#!/usr/bin/env node
// Run stage 4 (illustration) for EP03 task
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';
import { runStage4 } from '../stages/stage-04-illustrate.mjs';
import { CostTracker } from '../lib/cost-tracker.mjs';

const taskId = 'c6176cd9-6102-4511-a8cc-70aee1f75d4f';
const sb = getSupabase();

// Load character map from stage 3
const { data: s3 } = await sb
  .from('video_pipeline_runs')
  .select('pipeline_state')
  .eq('task_id', taskId)
  .eq('stage', 3)
  .single();

const characterMap = s3?.pipeline_state?.characters;
if (!characterMap) {
  console.error('No characterMap found in stage 3 pipeline_state');
  process.exit(1);
}

// Mark stage 4 as running
await sb
  .from('video_pipeline_runs')
  .update({ status: 'running', started_at: new Date().toISOString(), error: null })
  .eq('task_id', taskId)
  .eq('stage', 4);

const tracker = new CostTracker(taskId);

try {
  const result = await runStage4(taskId, tracker, {
    videoType: 'long',
    characterMap,
  });

  await tracker.flush(4);

  // Mark stage 4 completed
  await sb
    .from('video_pipeline_runs')
    .update({
      status: 'completed',
      pipeline_state: result || {},
      completed_at: new Date().toISOString(),
      error: null,
    })
    .eq('task_id', taskId)
    .eq('stage', 4);

  console.log('✅ Stage 4 completed');
} catch (err) {
  console.error('❌ Stage 4 failed:', err.message);
  await sb
    .from('video_pipeline_runs')
    .update({ status: 'failed', error: err.message })
    .eq('task_id', taskId)
    .eq('stage', 4);
  process.exit(1);
}
