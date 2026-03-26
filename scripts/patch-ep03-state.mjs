#!/usr/bin/env node
// Patch EP03 stage 2 pipeline_state to include the `script` object that stage 3 expects
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';

const sb = getSupabase();
const TASK_ID = 'cb03d267-388a-48c1-8678-3ef14fbf0ceb';

// Get current stage 2 state
const { data: run } = await sb
  .from('video_pipeline_runs')
  .select('pipeline_state')
  .eq('task_id', TASK_ID)
  .eq('stage_id', 'script')
  .single();

const { scenes, youtube_seo, episodeNumber } = run.pipeline_state;

// Build the script object that runStage2 returns but didn't persist
const script = {
  metadata: {
    title: youtube_seo?.title || 'Tara and the Banyan Tree | Tamil Kids Story | Tiny Tamil Tales',
    episode: episodeNumber || 3,
    characters: [...new Set(scenes.map(s => s.speaker).filter(s => s !== 'narrator'))],
  },
  youtube_seo,
};

console.log('Script object to inject:');
console.log(JSON.stringify(script, null, 2));

// Also need videoType in state
const updatedState = {
  ...run.pipeline_state,
  script,
  videoType: 'long',
};

const { error } = await sb
  .from('video_pipeline_runs')
  .update({ pipeline_state: updatedState })
  .eq('task_id', TASK_ID)
  .eq('stage_id', 'script');

if (error) throw new Error(`Patch failed: ${error.message}`);
console.log('\n✅ Stage 2 pipeline_state patched with script + videoType');

// Also reset stage 3 and 4 back to pending
for (const stage of [3, 4]) {
  await sb.from('video_pipeline_runs')
    .update({ status: 'pending', started_at: null, completed_at: null, error: null, pipeline_state: null })
    .eq('task_id', TASK_ID)
    .eq('stage_id', STAGE_NUM_TO_ID[stage]);
}
console.log('✅ Stages 3-4 reset to pending');

process.exit(0);
