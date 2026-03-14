#!/usr/bin/env node
// launch-pipeline.mjs — Bootstrap Stage 2+ with concept loaded from NEXUS card
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

const [,, conceptTaskIdArg, startStageArg, taskIdArg] = process.argv;
const conceptTaskId = conceptTaskIdArg || '13';
const startStage = parseInt(startStageArg || '2', 10);

const sb = getSupabase();

// Load concept from NEXUS card
const { data: card, error } = await sb
  .from('ops_tasks')
  .select('*')
  .eq('id', parseInt(conceptTaskId, 10))
  .single();

if (error || !card) {
  console.error('Failed to load concept card:', error?.message);
  process.exit(1);
}

// Parse concept from markdown description
function parseConceptDescription(desc) {
  const theme = desc.match(/\*\*Theme:\*\*\s*(.+)/)?.[1]?.trim() || '';
  const charactersRaw = desc.match(/\*\*Characters:\*\*\s*(.+)/)?.[1]?.trim() || '';
  const synopsis = desc.match(/\*\*Synopsis:\*\*\s*([\s\S]+?)(?=\n\*\*|$)/)?.[1]?.trim() || desc;
  const targetDuration = parseInt(desc.match(/\*\*Target duration:\*\*\s*(\d+)s/)?.[1] || '300', 10);
  const targetAge = desc.match(/\*\*Target age:\*\*\s*(.+)/)?.[1]?.trim() || '3-7';
  const characters = charactersRaw.split(',').map(c => c.trim()).filter(Boolean);

  return { theme, characters, synopsis, targetDurationSeconds: targetDuration, targetAge };
}

const conceptParsed = parseConceptDescription(card.description || '');
const concept = {
  title: card.title.replace('Story Concept: ', '').trim(),
  ...conceptParsed,
};

console.log(`\n🎬 YouTube AI Pipeline`);
console.log(`   Concept: ${concept.title}`);
console.log(`   Theme: ${concept.theme}`);
console.log(`   Characters: ${concept.characters.join(', ')}`);
console.log(`   Target duration: ${concept.targetDurationSeconds}s`);
console.log(`   Starting at stage: ${startStage}\n`);

// Reuse existing taskId or create new one
let taskId = taskIdArg;
if (!taskId) {
  taskId = randomUUID();
  // Record Stage 1
  await sb.from('video_pipeline_runs').upsert({
    task_id: taskId,
    stage: 1,
    status: 'completed',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage' });
}

// Get or create parent card
let parentCardId;
const { data: existingParent } = await sb
  .from('ops_tasks')
  .select('id')
  .eq('task_type', 'video_production')
  .eq('stream', 'youtube')
  .like('title', `%${concept.title}%`)
  .single();

if (existingParent) {
  parentCardId = existingParent.id;
} else {
  const { data: newParent } = await sb
    .from('ops_tasks')
    .insert({
      title: `🎬 Production: ${concept.title}`,
      description: 'Full video production pipeline — auto-created by Stage 1',
      stream: 'youtube',
      status: 'in_progress',
      priority: 'high',
      task_type: 'video_production',
      auto_created: true,
      pipeline_stage: 'stage-01',
    })
    .select()
    .single();
  parentCardId = newParent?.id;
}

console.log(`   Task ID:      ${taskId}`);
console.log(`   Parent card:  ${parentCardId}\n`);

const tracker = new CostTracker(taskId);

const stageFns = { 2: runStage2, 3: runStage3, 4: runStage4, 5: runStage5,
                   6: runStage6, 7: runStage7, 8: runStage8, 9: runStage9 };

let pipelineState = { taskId, concept, parentCardId };

// Restore persisted state from completed stages (for mid-pipeline restarts)
if (startStage > 2) {
  const { data: priorRuns } = await sb
    .from('video_pipeline_runs')
    .select('stage, pipeline_state')
    .eq('task_id', taskId)
    .in('status', ['completed', 'awaiting_review'])
    .order('stage', { ascending: true });

  for (const run of priorRuns || []) {
    if (run.pipeline_state) {
      console.log(`  ↩️  Restoring state from stage ${run.stage}`);
      pipelineState = { ...pipelineState, ...run.pipeline_state };
    }
  }
}

for (const [stageNum, stageFn] of Object.entries(stageFns).map(([k,v]) => [parseInt(k,10), v])) {
  if (stageNum < startStage) continue;

  console.log(`\n━━━ Stage ${stageNum} ━━━`);

  await sb.from('video_pipeline_runs').upsert({
    task_id: taskId,
    stage: stageNum,
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
      .update({ status: 'completed', completed_at: new Date().toISOString(), pipeline_state: stateSnapshot })
      .eq('task_id', taskId).eq('stage', stageNum);
    console.log(`✅ Stage ${stageNum} complete`);
  } catch (err) {
    await sb.from('video_pipeline_runs')
      .update({ status: 'failed', error: err.message, completed_at: new Date().toISOString() })
      .eq('task_id', taskId).eq('stage', stageNum);
    console.error(`❌ Stage ${stageNum} failed: ${err.message}`);
    console.error('🛑 Pipeline halted');
    process.exit(1);
  }
}

const finalCost = await tracker.totalSpent();
console.log(`\n🎉 Pipeline complete! Total cost: $${finalCost.toFixed(4)}\n`);
