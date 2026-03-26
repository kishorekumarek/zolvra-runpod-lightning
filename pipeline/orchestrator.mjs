// pipeline/orchestrator.mjs — Main pipeline entry point
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';
import { CostTracker, BudgetCapExceededError } from '../lib/cost-tracker.mjs';
import { runStage2 } from '../stages/stage-02-script-gen.mjs';
import { runStage3 } from '../stages/stage-03-character-prep.mjs';
import { runStage4 } from '../stages/stage-04-illustrate.mjs';
import { runStage5 } from '../stages/stage-05-animate.mjs';
import { runStage6 } from '../stages/stage-06-voice.mjs';
import { runStage7 } from '../stages/stage-07-assemble.mjs';
import { runStage8 } from '../stages/stage-08-review.mjs';
// Stage 9 removed from auto-chain (producer/publisher split).
// YouTube upload now happens via scripts/publish-video.mjs on demand.
// import { runStage9 } from '../stages/stage-09-publish.mjs';

/**
 * Run the full pipeline for a given task_id, starting from the specified stage.
 * Stage 0 (research) and Stage 1 (concept select) are triggered separately.
 */
export async function runPipeline(taskId, startStage = 2) {
  console.log(`\n🚀 Starting pipeline for task ${taskId} from stage ${startStage}\n`);

  const sb = getSupabase();
  const tracker = new CostTracker(taskId);

  // Map of stages with their runner functions
  // Stage 9 excluded — pipeline ends after Stage 8 (Supabase queue).
  // YouTube upload happens on demand via scripts/publish-video.mjs.
  const stageFns = {
    2: runStage2,
    3: runStage3,
    4: runStage4,
    5: runStage5,
    6: runStage6,
    7: runStage7,
    8: runStage8,
  };

  const stageNumbers = Object.keys(stageFns).map(Number).filter(n => n >= startStage);

  // Shared state passed between stages
  let pipelineState = { taskId };

  // Load accumulated state from last completed stage before startStage
  if (startStage > 2) {
    const { data: prevRun } = await sb
      .from('video_pipeline_runs')
      .select('pipeline_state')
      .eq('task_id', taskId)
      .eq('status', 'completed')
      .lt('stage', startStage)
      .order('stage', { ascending: false })
      .limit(1)
      .single();
    if (prevRun?.pipeline_state) {
      pipelineState = { ...pipelineState, ...prevRun.pipeline_state };
    }
  }

  for (const stageNum of stageNumbers) {
    const stageFn = stageFns[stageNum];
    console.log(`\n━━━ Stage ${stageNum} ━━━`);

    // Insert running record
    const { error: insertErr } = await sb
      .from('video_pipeline_runs')
      .upsert({
        task_id:    taskId,
        stage:      stageNum,
        status:     'running',
        started_at: new Date().toISOString(),
      }, { onConflict: 'task_id,stage' });

    if (insertErr) {
      console.error(`Failed to insert pipeline run for stage ${stageNum}:`, insertErr.message);
    }

    try {
      // Check budget before each stage
      await tracker.checkBudget();

      // Run the stage — passes state through, may mutate it
      pipelineState = await stageFn(taskId, tracker, pipelineState) || pipelineState;

      // Flush costs recorded in this stage
      await tracker.flush(stageNum);

      // Mark stage completed
      await sb
        .from('video_pipeline_runs')
        .update({
          status:       'completed',
          completed_at: new Date().toISOString(),
        })
        .eq('task_id', taskId)
        .eq('stage', stageNum);

      console.log(`✅ Stage ${stageNum} complete`);

    } catch (err) {
      console.error(`❌ Stage ${stageNum} failed: ${err.message}`);

      // Mark stage failed
      await sb
        .from('video_pipeline_runs')
        .update({
          status:       'failed',
          error:        err.message,
          completed_at: new Date().toISOString(),
        })
        .eq('task_id', taskId)
        .eq('stage', stageNum);

      if (err instanceof BudgetCapExceededError) {
        console.error('🛑 Budget hard cap exceeded — pipeline halted permanently');
      } else {
        console.error('🛑 Pipeline halted due to unrecoverable error');
      }

      return { success: false, stage: stageNum, error: err.message };
    }
  }

  const finalCost = await tracker.totalSpent();
  console.log(`\n🎉 Pipeline complete! Total cost: $${finalCost.toFixed(4)}\n`);
  return { success: true, taskId, totalCostUsd: finalCost };
}

/**
 * Resume a pipeline from its last failed stage.
 */
export async function resumePipeline(taskId) {
  const sb = getSupabase();

  // Find the last failed or incomplete stage
  const { data: runs } = await sb
    .from('video_pipeline_runs')
    .select('stage, status')
    .eq('task_id', taskId)
    .order('stage', { ascending: false });

  if (!runs || runs.length === 0) {
    throw new Error(`No pipeline runs found for task_id: ${taskId}`);
  }

  const lastFailed = runs.find(r => r.status === 'failed');
  const resumeFrom = lastFailed?.stage ?? (runs[0].stage + 1);

  console.log(`🔄 Resuming pipeline ${taskId} from stage ${resumeFrom}`);
  return runPipeline(taskId, resumeFrom);
}
