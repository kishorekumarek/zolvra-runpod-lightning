#!/usr/bin/env node
// scripts/rebuild-ep01.mjs — Redo TTS with corrected script and reassemble EP01
// Usage: node scripts/rebuild-ep01.mjs
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSupabase } from '../lib/supabase.mjs';
import { CostTracker } from '../lib/cost-tracker.mjs';
import { runStage6 } from '../stages/stage-06-voice.mjs';
import { runStage7 } from '../stages/stage-07-assemble.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASK_ID = 'eb42af4b-f4ce-4e0f-b2f7-1f3e452030f8';

async function main() {
  console.log('\n🔨 EP01 Rebuild: TTS Redo + Reassemble');
  console.log(`   Task ID: ${TASK_ID}\n`);

  // 1. Read corrected script
  const correctedScriptPath = join(__dirname, '..', 'lib', 'corrected-script-ep01.json');
  const correctedScenes = JSON.parse(await fs.readFile(correctedScriptPath, 'utf8'));
  console.log(`✓ Loaded ${correctedScenes.length} corrected scenes from corrected-script-ep01.json`);

  const sb = getSupabase();

  // 2. Update stage 2 pipeline_state.scenes with the corrected array
  console.log('\n📝 Updating stage 2 pipeline_state.scenes...');
  const { data: stage2Row, error: s2ReadErr } = await sb
    .from('video_pipeline_runs')
    .select('pipeline_state')
    .eq('task_id', TASK_ID)
    .eq('stage_id', 'script')
    .single();

  if (s2ReadErr) throw new Error(`Failed to read stage 2 row: ${s2ReadErr.message}`);

  const updatedS2State = { ...(stage2Row?.pipeline_state || {}), scenes: correctedScenes };
  const { error: s2UpdateErr } = await sb
    .from('video_pipeline_runs')
    .update({ pipeline_state: updatedS2State })
    .eq('task_id', TASK_ID)
    .eq('stage_id', 'script');

  if (s2UpdateErr) throw new Error(`Failed to update stage 2 state: ${s2UpdateErr.message}`);
  console.log('✓ Stage 2 pipeline_state.scenes updated with corrected script');

  // 3. Delete existing stage 6 row so audio regenerates from scratch
  console.log('\n🗑️  Deleting stage 6 audio row...');
  const { error: delErr } = await sb
    .from('video_pipeline_runs')
    .delete()
    .eq('task_id', TASK_ID)
    .eq('stage_id', 'tts');

  if (delErr) throw new Error(`Failed to delete stage 6 row: ${delErr.message}`);
  console.log('✓ Stage 6 row deleted — audio will regenerate');

  // 4. Load accumulated state from all prior completed stages
  console.log('\n↩️  Restoring pipeline state from completed stages...');
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

  // Override scenes with corrected script
  pipelineState.scenes = correctedScenes;

  // Ensure tmpDir exists (may have been cleaned up between runs)
  if (!pipelineState.tmpDir) {
    pipelineState.tmpDir = `/tmp/zolvra-pipeline/${TASK_ID}`;
    console.log(`   tmpDir not in state — defaulting to: ${pipelineState.tmpDir}`);
  }
  await fs.mkdir(join(pipelineState.tmpDir, 'audio'), { recursive: true });
  await fs.mkdir(join(pipelineState.tmpDir, 'assembly'), { recursive: true });
  console.log(`✓ State restored. tmpDir: ${pipelineState.tmpDir}`);
  console.log(`  sceneAnimPaths: ${Object.keys(pipelineState.sceneAnimPaths || {}).length} scenes`);
  console.log(`  sceneImagePaths: ${Object.keys(pipelineState.sceneImagePaths || {}).length} scenes`);

  const tracker = new CostTracker(TASK_ID);

  // 5. Run Stage 6 — voice generation
  console.log('\n━━━ Stage 6: Voice Generation ━━━\n');
  await sb.from('video_pipeline_runs').upsert({
    task_id: TASK_ID,
    stage_id: 'tts',
    status: 'running',
    started_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage_id' });

  try {
    pipelineState = await runStage6(TASK_ID, tracker, pipelineState) || pipelineState;
    await tracker.flush(6);
    const s6Snapshot = { ...pipelineState };
    delete s6Snapshot.taskId;
    await sb.from('video_pipeline_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), pipeline_state: s6Snapshot })
      .eq('task_id', TASK_ID).eq('stage_id', 'tts');
    console.log('\n✅ Stage 6 complete');
  } catch (err) {
    await sb.from('video_pipeline_runs')
      .update({ status: 'failed', error: err.message, completed_at: new Date().toISOString() })
      .eq('task_id', TASK_ID).eq('stage_id', 'tts');
    throw err;
  }

  // 6. Run Stage 7 — video assembly
  console.log('\n━━━ Stage 7: Video Assembly ━━━\n');
  await sb.from('video_pipeline_runs').upsert({
    task_id: TASK_ID,
    stage_id: 'assemble',
    status: 'running',
    started_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage_id' });

  try {
    pipelineState = await runStage7(TASK_ID, tracker, pipelineState) || pipelineState;
    await tracker.flush(7);
    const s7Snapshot = { ...pipelineState };
    delete s7Snapshot.taskId;
    await sb.from('video_pipeline_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), pipeline_state: s7Snapshot })
      .eq('task_id', TASK_ID).eq('stage_id', 'assemble');
    console.log('\n✅ Stage 7 complete');
  } catch (err) {
    await sb.from('video_pipeline_runs')
      .update({ status: 'failed', error: err.message, completed_at: new Date().toISOString() })
      .eq('task_id', TASK_ID).eq('stage_id', 'assemble');
    throw err;
  }

  const totalCost = await tracker.totalSpent();
  console.log(`\n🎉 Rebuild complete!`);
  console.log(`   Final video : ${pipelineState.finalVideoPath}`);
  console.log(`   Duration    : ${pipelineState.finalDurationSeconds?.toFixed(1)}s`);
  console.log(`   Total cost  : $${totalCost.toFixed(4)}`);
}

main().catch(e => {
  console.error('\n💥 Rebuild failed:', e.message);
  console.error(e.stack);
  process.exit(1);
});
