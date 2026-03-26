#!/usr/bin/env node
// resume-ep02-stage4.mjs — Resume EP02 pipeline from stage 4 onwards
// Use when: Supabase recovers and stages 1-3 are already in DB
// Task ID: 210cfd98-f7d1-4f06-ac1d-e0f2587441d4
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';
import { CostTracker } from '../lib/cost-tracker.mjs';
import { runStage4 } from '../stages/stage-04-illustrate.mjs';
import { runStage5 } from '../stages/stage-05-animate.mjs';
import { runStage6 } from '../stages/stage-06-voice.mjs';
import { runStage7 } from '../stages/stage-07-assemble.mjs';
import { STAGE_NUM_TO_ID } from '../lib/stage-ids.mjs';

const TASK_ID = process.argv[2] || '210cfd98-f7d1-4f06-ac1d-e0f2587441d4';
const START_STAGE = parseInt(process.argv[3] || '4', 10);

console.log(`\n🔄 EP02 Resume — Task ${TASK_ID} from Stage ${START_STAGE}`);

const sb = getSupabase();

// Restore state from DB
const { data: priorRuns, error: priorError } = await sb
  .from('video_pipeline_runs')
  .select('stage_id, pipeline_state, status')
  .eq('task_id', TASK_ID)
  .order('stage_id', { ascending: true });

if (priorError) {
  console.error('❌ Cannot load prior runs:', priorError.message);
  process.exit(1);
}

console.log('Prior runs:');
for (const r of priorRuns || []) {
  console.log(`  Stage ${r.stage}: ${r.status}`);
}

// Build state from completed runs
let state = { parentCardId: '176' };
for (const run of priorRuns || []) {
  if (run.pipeline_state && ['completed', 'awaiting_review'].includes(run.status)) {
    state = { ...state, ...run.pipeline_state };
  }
}

if (!state.script && !state.scenes) {
  console.error('❌ No script/scenes found in prior state — cannot resume');
  process.exit(1);
}

console.log(`\nRestored: script="${state.script?.title}", scenes=${state.scenes?.length}`);

const tracker = new CostTracker(TASK_ID);

const stageFns = [
  [4, runStage4, 'Illustration'],
  [5, runStage5, 'Animation'],
  [6, runStage6, 'Voice'],
  [7, runStage7, 'Assemble'],
].filter(([n]) => n >= START_STAGE);

for (const [stageNum, stageFn, label] of stageFns) {
  console.log(`\n━━━ Stage ${stageNum}: ${label} ━━━`);

  await sb.from('video_pipeline_runs').upsert({
    task_id: TASK_ID,
    stage: stageNum,
    status: 'running',
    started_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage' });

  try {
    await tracker.checkBudget();
    const result = await stageFn(TASK_ID, tracker, state);
    state = result || state;
    await tracker.flush(stageNum);

    await sb.from('video_pipeline_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        pipeline_state: { ...state },
      })
      .eq('task_id', TASK_ID)
      .eq('stage_id', STAGE_NUM_TO_ID[stageNum]);

    console.log(`✅ Stage ${stageNum} (${label}) complete`);
  } catch (err) {
    await sb.from('video_pipeline_runs')
      .update({
        status: 'failed',
        error: err.message,
        completed_at: new Date().toISOString(),
      })
      .eq('task_id', TASK_ID)
      .eq('stage_id', STAGE_NUM_TO_ID[stageNum]);

    console.error(`\n❌ Stage ${stageNum} (${label}) FAILED: ${err.message}`);
    console.error('🛑 Pipeline halted.');
    process.exit(1);
  }
}

const finalOutput = state.finalVideoPath || state.assembledVideoPath || 'output/ep02-minminni-final.mp4';
const totalCost = await tracker.totalSpent();

console.log('\n🎉 EP02 pipeline complete!');
console.log(`   Output: ${finalOutput}`);
console.log(`   Total cost: $${totalCost.toFixed(4)}`);
