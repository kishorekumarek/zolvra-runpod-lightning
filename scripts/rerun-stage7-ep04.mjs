#!/usr/bin/env node
// scripts/rerun-stage7-ep04.mjs — Rerun stage 7 (xfade dissolve assembly) for EP04 Tara and the Banyan Tree
// Usage: node scripts/rerun-stage7-ep04.mjs
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { CostTracker } from '../lib/cost-tracker.mjs';
import { runStage7 } from '../stages/stage-07-assemble.mjs';

const TASK_ID = '00ba123a-b818-43ea-b3d1-72f52c90edca';

async function main() {
  console.log('\n🔨 EP04 Tara and the Banyan Tree — Stage 7 Rerun — dissolve transitions');
  console.log(`   Task ID: ${TASK_ID}\n`);

  const sb = getSupabase();

  // Load accumulated state from all prior completed stages
  console.log('↩️  Restoring pipeline state from completed stages...');
  const { data: priorRuns, error: priorErr } = await sb
    .from('video_pipeline_runs')
    .select('stage_id, pipeline_state')
    .eq('task_id', TASK_ID)
    .in('status', ['completed', 'awaiting_review'])
    .order('stage_id', { ascending: true });

  if (priorErr) throw new Error(`Failed to load prior runs: ${priorErr.message}`);

  let pipelineState = { taskId: TASK_ID };
  for (const run of priorRuns || []) {
    if (run.pipeline_state) {
      console.log(`   Stage ${run.stage_id}: restoring state`);
      pipelineState = { ...pipelineState, ...run.pipeline_state };
    }
  }

  if (!pipelineState.tmpDir) {
    pipelineState.tmpDir = `/tmp/zolvra-pipeline/${TASK_ID}`;
    console.log(`   tmpDir not in state — defaulting to: ${pipelineState.tmpDir}`);
  }
  await fs.mkdir(join(pipelineState.tmpDir, 'assembly'), { recursive: true });

  console.log(`✓ State restored. tmpDir: ${pipelineState.tmpDir}`);
  console.log(`  sceneAnimPaths: ${Object.keys(pipelineState.sceneAnimPaths || {}).length} scenes`);
  console.log(`  sceneAudioPaths: ${Object.keys(pipelineState.sceneAudioPaths || {}).length} scenes`);

  // Mark stage 7 as running
  await sb.from('video_pipeline_runs').upsert({
    task_id: TASK_ID,
    stage: 7,
    status: 'running',
    started_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage' });

  const tracker = new CostTracker(TASK_ID);

  try {
    pipelineState = await runStage7(TASK_ID, tracker, pipelineState) || pipelineState;
    await tracker.flush(7);
    const s7Snapshot = { ...pipelineState };
    delete s7Snapshot.taskId;
    await sb.from('video_pipeline_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), pipeline_state: s7Snapshot })
      .eq('task_id', TASK_ID).eq('stage_id', 'assemble');
    console.log('\n✅ Stage 7 complete');
    console.log(`   Final video : ${pipelineState.finalVideoPath}`);
    console.log(`   Duration    : ${pipelineState.finalDurationSeconds?.toFixed(1)}s`);
  } catch (err) {
    await sb.from('video_pipeline_runs')
      .update({ status: 'failed', error: err.message, completed_at: new Date().toISOString() })
      .eq('task_id', TASK_ID).eq('stage_id', 'assemble');
    throw err;
  }
}

main().catch(e => {
  console.error('\n💥 Stage 7 rerun failed:', e.message);
  console.error(e.stack);
  process.exit(1);
});
