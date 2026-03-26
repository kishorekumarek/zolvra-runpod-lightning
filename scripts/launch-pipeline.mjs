#!/usr/bin/env node
// launch-pipeline.mjs — Bootstrap Stage 2+ with concept loaded from ops_tasks card
// Usage: node scripts/launch-pipeline.mjs <concept_task_id> [start_stage]
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.mjs';
import { CostTracker } from '../lib/cost-tracker.mjs';
import { runStage2 } from '../stages/stage-02-script-gen.mjs';
import { runStage3 } from '../stages/stage-03-character-prep.mjs';
import { runStage4 } from '../stages/stage-04-illustrate.mjs';
import { runStage5 } from '../stages/stage-05-animate.mjs';
import { runStage6 } from '../stages/stage-06-voice.mjs';
import { runStage7 } from '../stages/stage-07-assemble.mjs';
import { runStage8 } from '../stages/stage-08-review.mjs';
import { runStage9 } from '../stages/stage-09-publish.mjs';
import { flushApprovalUpdates, PipelineAbortError } from '../lib/telegram.mjs';
import { STAGE_NUM_TO_ID } from '../lib/stage-ids.mjs';

const [,, conceptTaskIdArg, startStageArg, taskIdArg] = process.argv;
const conceptTaskId = conceptTaskIdArg || '13';
const startStage = parseInt(startStageArg || '2', 10);

const sb = getSupabase();

// ── Single pipeline lock ───────────────────────────────────────────────
const { data: running } = await sb
  .from('video_pipeline_runs')
  .select('task_id, stage')
  .in('status', ['running', 'in_progress'])
  .limit(1);

if (running?.length) {
  console.error(`Another pipeline is already running (task: ${running[0].task_id}, stage: ${running[0].stage}). Aborting.`);
  process.exit(1);
}

// Clear any stale pipeline_abort flag
await sb.from('pipeline_settings').upsert({ key: 'pipeline_abort', value: false }, { onConflict: 'key' });

// Flush stale Telegram approval updates from previous runs
await flushApprovalUpdates();

// Load concept from ops_tasks card
const { data: card, error } = await sb
  .from('ops_tasks')
  .select('*')
  .eq('id', parseInt(conceptTaskId, 10))
  .single();

if (error || !card) {
  console.error('Failed to load concept card:', error?.message);
  process.exit(1);
}

// Parse concept from card description — try JSON first (from Stage 0/1), fall back to markdown regex (legacy)
function parseConceptDescription(desc, cardTitle) {
  // Try JSON (enriched concept from Stage 1)
  try {
    const parsed = JSON.parse(desc);
    if (parsed.title && parsed.characters) return parsed;
  } catch {
    // Not JSON — fall back to markdown parsing
  }

  // Legacy: parse from markdown description
  const theme = desc.match(/\*\*Theme:\*\*\s*(.+)/)?.[1]?.trim() || '';
  const charactersRaw = desc.match(/\*\*Characters:\*\*\s*(.+)/)?.[1]?.trim() || '';
  const synopsis = desc.match(/\*\*Synopsis:\*\*\s*([\s\S]+?)(?=\n\*\*|$)/)?.[1]?.trim() || desc;
  const targetDuration = parseInt(desc.match(/\*\*Target duration:\*\*\s*(\d+)s/)?.[1] || '90', 10);
  const targetAge = desc.match(/\*\*Target age:\*\*\s*(.+)/)?.[1]?.trim() || '3-7';
  const characters = charactersRaw.split(',').map(c => c.trim()).filter(Boolean);

  return {
    title: cardTitle.replace(/^Story Concept \d+:\s*/, '').replace('Story Concept: ', '').trim(),
    theme,
    characters,
    synopsis,
    targetDurationSeconds: targetDuration,
    targetAge,
  };
}

const concept = parseConceptDescription(card.description || '', card.title || '');

console.log(`\n🎬 YouTube AI Pipeline`);
console.log(`   Concept: ${concept.title}`);
console.log(`   Theme: ${concept.theme}`);
console.log(`   Characters: ${(concept.characters || []).join(', ')}`);
console.log(`   Video type: ${concept.videoType || 'not set'}`);
console.log(`   Starting at stage: ${startStage}\n`);

// Reuse existing taskId or create new one
let taskId = taskIdArg;
if (!taskId) {
  taskId = randomUUID();
  // Record Stage 1
  await sb.from('video_pipeline_runs').upsert({
    task_id: taskId,
    stage: 1,
    stage_id: STAGE_NUM_TO_ID[1] ?? null,
    status: 'completed',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage' });
}

console.log(`   Task ID:      ${taskId}\n`);

const tracker = new CostTracker(taskId);

// Stage execution order — explicit array to avoid JS integer key auto-sorting.
// Order: script(2) → characters(3) → tts(6) → illustrate(4) → animate(5) → assemble(7) → queue(8) → publish(9)
// TTS runs before illustration: audio approved before spending image gen + animation credits.
const stageOrder = [2, 3, 6, 4, 5, 7, 8]; // Stage 9 removed — upload is on-demand via publish-video.mjs
const stageFns = { 2: runStage2, 3: runStage3, 4: runStage4, 5: runStage5,
                   6: runStage6, 7: runStage7, 8: runStage8, 9: runStage9 };

let pipelineState = { taskId, concept };

// Restore persisted state from completed stages (for mid-pipeline restarts)
if (startStage > 2) {
  const { data: priorRuns } = await sb
    .from('video_pipeline_runs')
    .select('stage, pipeline_state')
    .eq('task_id', taskId)
    .in('status', ['completed', 'awaiting_review', 'running', 'in_progress'])
    .order('stage', { ascending: true });

  for (const run of priorRuns || []) {
    if (run.pipeline_state) {
      console.log(`  ↩️  Restoring state from stage ${run.stage}`);
      pipelineState = { ...pipelineState, ...run.pipeline_state };
    }
  }
}

for (const stageNum of stageOrder) {
  if (stageNum < startStage) continue;
  const stageFn = stageFns[stageNum];

  console.log(`\n━━━ Stage ${stageNum} ━━━`);

  await sb.from('video_pipeline_runs').upsert({
    task_id: taskId,
    stage: stageNum,
    stage_id: STAGE_NUM_TO_ID[stageNum] ?? null,
    status: 'running',
    started_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage' });

  try {
    await tracker.checkBudget();
    pipelineState = await stageFn(taskId, tracker, pipelineState) || pipelineState;
    await tracker.flush(stageNum);
    // Persist state snapshot so restarts can resume cleanly
    const stateSnapshot = { ...pipelineState };
    delete stateSnapshot.taskId; // don't duplicate
    await sb.from('video_pipeline_runs')
      .update({ status: 'completed', stage_id: STAGE_NUM_TO_ID[stageNum] ?? null, completed_at: new Date().toISOString(), pipeline_state: stateSnapshot })
      .eq('task_id', taskId).eq('stage', stageNum);
    console.log(`✅ Stage ${stageNum} complete`);
  } catch (err) {
    if (err instanceof PipelineAbortError) {
      await sb.from('video_pipeline_runs')
        .update({ status: 'aborted', stage_id: STAGE_NUM_TO_ID[stageNum] ?? null, error: err.message, completed_at: new Date().toISOString() })
        .eq('task_id', taskId).eq('stage', stageNum);
      console.log(`\n🛑 Pipeline aborted at stage ${stageNum}: ${err.message}`);
      process.exit(0);
    }
    await sb.from('video_pipeline_runs')
      .update({ status: 'failed', stage_id: STAGE_NUM_TO_ID[stageNum] ?? null, error: err.message, completed_at: new Date().toISOString() })
      .eq('task_id', taskId).eq('stage', stageNum);
    console.error(`❌ Stage ${stageNum} failed: ${err.message}`);
    console.error('🛑 Pipeline halted');
    process.exit(1);
  }
}

const finalCost = await tracker.totalSpent();
console.log(`\n🎉 Pipeline complete! Total cost: $${finalCost.toFixed(4)}\n`);
