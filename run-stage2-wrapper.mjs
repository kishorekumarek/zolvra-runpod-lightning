import 'dotenv/config';
import { getSupabase } from './lib/supabase.mjs';
import { CostTracker } from './lib/cost-tracker.mjs';
import { runStage2 } from './stages/stage-02-script-gen.mjs';

const TASK_ID = 'cb03d267-388a-48c1-8678-3ef14fbf0ceb';
const sb = getSupabase();

// Load all pipeline stage states
const { data: runs } = await sb
  .from('video_pipeline_runs')
  .select('stage, pipeline_state, status')
  .eq('task_id', TASK_ID)
  .order('stage', { ascending: true });

console.log('Existing stages:', runs?.map(r => `stage ${r.stage}: ${r.status}`).join(', '));

let pipelineState = { taskId: TASK_ID };
for (const run of runs || []) {
  if (run.pipeline_state) Object.assign(pipelineState, run.pipeline_state);
}

console.log('Concept:', JSON.stringify(pipelineState.concept, null, 2));

if (!pipelineState.concept) {
  console.error('No concept found in pipeline state!');
  process.exit(1);
}

const tracker = new CostTracker(TASK_ID);
const result = await runStage2(TASK_ID, tracker, pipelineState);
console.log('Stage 2 complete. Scenes generated:', result.scenes?.length);
