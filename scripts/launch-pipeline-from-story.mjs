#!/usr/bin/env node
// launch-pipeline-from-story.mjs — Run Stage 1B + full pipeline from a story file
// Usage: node scripts/launch-pipeline-from-story.mjs <story-file> [video_type] [start_stage]
//
// Designed to be spawned as a DETACHED process so Friday stays responsive:
//   const child = spawn('node', ['scripts/launch-pipeline-from-story.mjs', '/tmp/story.txt', 'short'], {
//     detached: true, stdio: ['ignore', logFd, logFd],
//   });
//   child.unref();

import 'dotenv/config';
import { readFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.mjs';
import { CostTracker } from '../lib/cost-tracker.mjs';
import { extractConceptFromStory } from '../stages/stage-01b-story-intake.mjs';
import { runStage2 } from '../stages/stage-02-script-gen.mjs';
import { runStage3 } from '../stages/stage-03-character-prep.mjs';
import { runStage4 } from '../stages/stage-04-illustrate.mjs';
import { runStage5 } from '../stages/stage-05-animate.mjs';
import { runStage6 } from '../stages/stage-06-voice.mjs';
import { runStage7 } from '../stages/stage-07-assemble.mjs';
import { runStage8 } from '../stages/stage-08-review.mjs';
import { runStage9 } from '../stages/stage-09-publish.mjs';
import { flushApprovalUpdates, PipelineAbortError } from '../lib/telegram.mjs';

const [,, storyFileArg, videoTypeArg, startStageArg, taskIdArg] = process.argv;

if (!storyFileArg) {
  console.error('Usage: node scripts/launch-pipeline-from-story.mjs <story-file> [short|long] [start_stage] [task_id]');
  process.exit(1);
}

const videoType = videoTypeArg || 'short';
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

// ── Stage 1B: Extract concept from story ───────────────────────────────
const storyText = await readFile(storyFileArg, 'utf8');
console.log(`\n📖 Story loaded from ${storyFileArg} (${storyText.length} chars, type: ${videoType})`);

const concept = await extractConceptFromStory(storyText, { videoType });

const taskId = taskIdArg || randomUUID();

// Record Stage 1B
await sb.from('video_pipeline_runs').upsert({
  task_id: taskId,
  stage: 1,
  status: 'completed',
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
}, { onConflict: 'task_id,stage' });

console.log(`\n🎬 YouTube AI Pipeline (from story)`);
console.log(`   Concept: ${concept.title}`);
console.log(`   Video type: ${videoType}`);
console.log(`   Task ID: ${taskId}\n`);

const tracker = new CostTracker(taskId);

const stageFns = { 2: runStage2, 3: runStage3, 4: runStage4, 5: runStage5,
                   6: runStage6, 7: runStage7, 8: runStage8, 9: runStage9 };

let pipelineState = { taskId, concept };

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
    const stateSnapshot = { ...pipelineState };
    delete stateSnapshot.taskId;
    await sb.from('video_pipeline_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), pipeline_state: stateSnapshot })
      .eq('task_id', taskId).eq('stage', stageNum);
    console.log(`✅ Stage ${stageNum} complete`);
  } catch (err) {
    if (err instanceof PipelineAbortError) {
      await sb.from('video_pipeline_runs')
        .update({ status: 'aborted', error: err.message, completed_at: new Date().toISOString() })
        .eq('task_id', taskId).eq('stage', stageNum);
      console.log(`\n🛑 Pipeline aborted at stage ${stageNum}: ${err.message}`);
      process.exit(0);
    }
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
