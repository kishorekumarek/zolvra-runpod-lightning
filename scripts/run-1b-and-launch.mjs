#!/usr/bin/env node
// Temporary runner: Stage 1B (story intake) → save concept → launch pipeline from Stage 2
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { extractConceptFromStory } from '../stages/stage-01b-story-intake.mjs';
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

// ── Story input: file path arg or stdin ──────────────────────────────
// Usage:  node run-1b-and-launch.mjs story.txt
//         cat story.txt | node run-1b-and-launch.mjs
import { readFileSync } from 'fs';

let STORY;
const storyFile = process.argv[2];
if (storyFile) {
  STORY = readFileSync(storyFile, 'utf8').trim();
  console.log(`📄 Story loaded from: ${storyFile}`);
} else if (!process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  STORY = Buffer.concat(chunks).toString('utf8').trim();
  console.log('📄 Story read from stdin');
} else {
  console.error('❌ No story provided.\nUsage: node run-1b-and-launch.mjs story.txt\n   or: cat story.txt | node run-1b-and-launch.mjs');
  process.exit(1);
}

const sb = getSupabase();

// ── Pipeline lock check ──────────────────────────────────────────────
const { data: running } = await sb
  .from('video_pipeline_runs')
  .select('task_id, stage_id')
  .in('status', ['running', 'in_progress'])
  .limit(1);

if (running?.length) {
  console.error(`Another pipeline already running (task: ${running[0].task_id}, stage: ${running[0].stage}). Aborting.`);
  process.exit(1);
}

// Clear any stale abort flag + flush stale Telegram updates
await sb.from('pipeline_settings').upsert({ key: 'pipeline_abort', value: false }, { onConflict: 'key' });
await flushApprovalUpdates();

// ── Stage 1B: extract concept + Telegram approval ────────────────────
const concept = await extractConceptFromStory(STORY, { videoType: 'short' });

// ── Save concept to ops_tasks ────────────────────────────────────────
const { data: card, error: cardErr } = await sb
  .from('ops_tasks')
  .insert({
    title: `Story Concept: ${concept.title}`,
    description: JSON.stringify(concept),
    task_type: 'story_concept',
    stream: 'youtube',
    status: 'done',
    auto_created: true,
  })
  .select('id')
  .single();

if (cardErr) { console.error('Failed to save concept card:', cardErr.message); process.exit(1); }
console.log(`\n  Concept saved to ops_tasks (card: ${card.id})`);

// ── Create task ID + log Stage 1 ─────────────────────────────────────
const taskId = randomUUID();
await sb.from('video_pipeline_runs').upsert({
  task_id: taskId,
  stage: 1,
  status: 'completed',
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
}, { onConflict: 'task_id,stage' });

console.log(`\n🎬 YouTube AI Pipeline`);
console.log(`   Concept: ${concept.title}`);
console.log(`   Theme: ${concept.theme}`);
console.log(`   Characters: ${(concept.characters || []).join(', ')}`);
console.log(`   Video type: ${concept.videoType}`);
console.log(`   Task ID: ${taskId}`);
console.log(`   Starting at stage: 2\n`);

const tracker = new CostTracker(taskId);
const stageFns = { 2: runStage2, 3: runStage3, 4: runStage4, 5: runStage5,
                   6: runStage6, 7: runStage7, 8: runStage8, 9: runStage9 };

let pipelineState = { taskId, concept };

for (const [stageNum, stageFn] of Object.entries(stageFns).map(([k,v]) => [parseInt(k,10), v])) {
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
    const stateSnapshot = { ...pipelineState };
    delete stateSnapshot.taskId;
    await sb.from('video_pipeline_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), pipeline_state: stateSnapshot })
      .eq('task_id', taskId).eq('stage_id', STAGE_NUM_TO_ID[stageNum]);
    console.log(`✅ Stage ${stageNum} complete`);
  } catch (err) {
    if (err instanceof PipelineAbortError) {
      await sb.from('video_pipeline_runs')
        .update({ status: 'aborted', error: err.message, completed_at: new Date().toISOString() })
        .eq('task_id', taskId).eq('stage_id', STAGE_NUM_TO_ID[stageNum]);
      console.log(`\n🛑 Pipeline aborted at stage ${stageNum}: ${err.message}`);
      process.exit(0);
    }
    await sb.from('video_pipeline_runs')
      .update({ status: 'failed', error: err.message, completed_at: new Date().toISOString() })
      .eq('task_id', taskId).eq('stage_id', STAGE_NUM_TO_ID[stageNum]);
    console.error(`❌ Stage ${stageNum} failed: ${err.message}`);
    console.error('🛑 Pipeline halted');
    process.exit(1);
  }
}

const finalCost = await tracker.totalSpent();
console.log(`\n🎉 Pipeline complete! Total cost: $${finalCost.toFixed(4)}\n`);
