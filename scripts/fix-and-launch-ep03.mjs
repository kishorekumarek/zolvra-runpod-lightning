#!/usr/bin/env node
// Fix EP03 pipeline state and launch from stage 3
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';
import { setSetting } from '../lib/settings.mjs';

const sb = getSupabase();
const TASK_ID = 'cb03d267-388a-48c1-8678-3ef14fbf0ceb';

// Voice mapping for EP03 characters
const VOICE_MAP = {
  tara: 'oDV9OTaNLmINQYHfVOXe',
  mini: '2zRM7PkgwBPiau2jvVXc',
  miko: 'Sm1seazb4gs7RSlUVw7c',
  narrator: 'XCVlHBLvc3SVXhH7pRkb',
  albert: 'JL7VCc7O6rY87Cfz9kIO',
};

async function main() {
  // 1. Save voice map to settings
  await setSetting('voice_map', JSON.stringify(VOICE_MAP));
  await setSetting('video_type', 'long');
  console.log('✅ Voice map and video_type saved to pipeline_settings');

  // 2. Mark stage 2 as completed (currently awaiting_review)
  const { error: s2err } = await sb
    .from('video_pipeline_runs')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('task_id', TASK_ID)
    .eq('stage', 2);

  if (s2err) throw new Error(`Failed to update stage 2: ${s2err.message}`);
  console.log('✅ Stage 2 marked as completed');

  // 3. Reset stuck stages 3 and 4 back to pending
  for (const stage of [3, 4]) {
    const { error } = await sb
      .from('video_pipeline_runs')
      .update({
        status: 'pending',
        started_at: null,
        completed_at: null,
        error: null,
        pipeline_state: null,
      })
      .eq('task_id', TASK_ID)
      .eq('stage', stage);

    if (error) console.warn(`Warning resetting stage ${stage}: ${error.message}`);
    else console.log(`✅ Stage ${stage} reset to pending`);
  }

  // 4. Verify state
  const { data: runs } = await sb
    .from('video_pipeline_runs')
    .select('stage, status')
    .eq('task_id', TASK_ID)
    .order('stage', { ascending: true });

  console.log('\nPipeline state after fix:');
  for (const r of runs) {
    console.log(`  Stage ${r.stage}: ${r.status}`);
  }

  console.log(`\n🚀 Ready to launch: node scripts/launch-pipeline.mjs 255 3 ${TASK_ID}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌', err.message);
    process.exit(1);
  });
