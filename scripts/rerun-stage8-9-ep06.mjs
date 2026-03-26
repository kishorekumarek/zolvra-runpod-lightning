#!/usr/bin/env node
// scripts/rerun-stage8-9-ep06.mjs — Upload EP06 Pongal Harvest Helper unlisted (stage 8) then publish (stage 9)
// Usage: node scripts/rerun-stage8-9-ep06.mjs
import 'dotenv/config';
import { promises as fs } from 'fs';
import { getSupabase } from '../lib/supabase.mjs';
import { CostTracker } from '../lib/cost-tracker.mjs';
import { runStage8 } from '../stages/stage-08-review.mjs';
import { runStage9 } from '../stages/stage-09-publish.mjs';

const TASK_ID = '873ea102-9df9-4878-852d-831bfb4670fd';
const FINAL_VIDEO = '/tmp/zolvra-pipeline/873ea102-9df9-4878-852d-831bfb4670fd/assembly/final.mp4';
const FINAL_DURATION = 91.7;

async function main() {
  console.log('\n🎬 EP06 Pongal Harvest Helper — Stages 8+9 — Upload Unlisted + Publish');
  console.log(`   Task ID: ${TASK_ID}\n`);

  const sb = getSupabase();

  // Verify the final video exists before doing anything
  await fs.access(FINAL_VIDEO);
  console.log(`✓ Final video confirmed: ${FINAL_VIDEO}`);

  // Load accumulated state from all prior completed stages
  console.log('↩️  Restoring pipeline state from completed stages...');
  const { data: priorRuns, error: priorErr } = await sb
    .from('video_pipeline_runs')
    .select('stage, pipeline_state')
    .eq('task_id', TASK_ID)
    .in('status', ['completed', 'awaiting_review'])
    .order('stage', { ascending: true });

  if (priorErr) throw new Error(`Failed to load prior runs: ${priorErr.message}`);

  let pipelineState = { taskId: TASK_ID };
  for (const run of priorRuns || []) {
    if (run.pipeline_state) {
      console.log(`   Stage ${run.stage}: restoring state`);
      pipelineState = { ...pipelineState, ...run.pipeline_state };
    }
  }

  // Override finalVideoPath and duration with the known good assembled video
  pipelineState.finalVideoPath = FINAL_VIDEO;
  pipelineState.finalDurationSeconds = FINAL_DURATION;
  console.log(`✓ State restored. finalVideoPath overridden → ${FINAL_VIDEO}`);
  console.log(`✓ finalDurationSeconds overridden → ${FINAL_DURATION}s`);

  const tracker = new CostTracker(TASK_ID);

  // ─── Stage 8: Upload unlisted to YouTube + notify Telegram ───────────────
  console.log('\n── Stage 8 ──────────────────────────────────────────────');
  await sb.from('video_pipeline_runs').upsert({
    task_id: TASK_ID,
    stage: 8,
    status: 'running',
    started_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage' });

  try {
    pipelineState = await runStage8(TASK_ID, tracker, pipelineState) || pipelineState;
    await tracker.flush(8);

    const s8Snapshot = { ...pipelineState };
    delete s8Snapshot.taskId;
    await sb.from('video_pipeline_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), pipeline_state: s8Snapshot })
      .eq('task_id', TASK_ID).eq('stage', 8);

    console.log('\n✅ Stage 8 complete');
    console.log(`   YouTube URL: ${pipelineState.youtubeUrl}`);
  } catch (err) {
    await sb.from('video_pipeline_runs')
      .update({ status: 'failed', error: err.message, completed_at: new Date().toISOString() })
      .eq('task_id', TASK_ID).eq('stage', 8);
    console.error('\n💥 Stage 8 failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }

  // ─── Stage 9: Add to playlist, feedback loop ─────────────────────────────
  console.log('\n── Stage 9 ──────────────────────────────────────────────');
  await sb.from('video_pipeline_runs').upsert({
    task_id: TASK_ID,
    stage: 9,
    status: 'running',
    started_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage' });

  try {
    pipelineState = await runStage9(TASK_ID, tracker, pipelineState) || pipelineState;
    await tracker.flush(9);

    const s9Snapshot = { ...pipelineState };
    delete s9Snapshot.taskId;
    await sb.from('video_pipeline_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), pipeline_state: s9Snapshot })
      .eq('task_id', TASK_ID).eq('stage', 9);

    console.log('\n✅ Stage 9 complete');
    console.log(`   Video unlisted at: ${pipelineState.youtubeUrl}`);
  } catch (err) {
    await sb.from('video_pipeline_runs')
      .update({ status: 'failed', error: err.message, completed_at: new Date().toISOString() })
      .eq('task_id', TASK_ID).eq('stage', 9);
    console.error('\n💥 Stage 9 failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }

  console.log('\n🎉 EP06 stages 8+9 complete — video is UNLISTED on YouTube, awaiting Darl review.');
}

main().catch(e => {
  console.error('\n💥 Fatal error:', e.message);
  console.error(e.stack);
  process.exit(1);
});
