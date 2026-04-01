#!/usr/bin/env node
// Inspect all 24 scenes from existing EP03 pipeline
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';

const sb = getSupabase();
const TASK_ID = 'cb03d267-388a-48c1-8678-3ef14fbf0ceb';

const { data: run } = await sb
  .from('video_pipeline_runs')
  .select('pipeline_state')
  .eq('task_id', TASK_ID)
  .eq('stage_id', 'script')
  .single();

const { scenes, youtube_seo, episodeNumber } = run.pipeline_state;

console.log(`Episode: ${episodeNumber}`);
console.log(`YouTube SEO:`, JSON.stringify(youtube_seo, null, 2));
console.log(`\n━━━ ${scenes.length} SCENES ━━━\n`);

for (const s of scenes) {
  const hasTamil = /[\u0B80-\u0BFF]/.test(s.text);
  console.log(`Scene ${s.scene_number} [${s.speaker}/${s.emotion}] ${hasTamil ? '✓Tamil' : '✗NO TAMIL'}`);
  console.log(`  Text: ${s.text}`);
  console.log(`  Visual: ${s.visual_description.slice(0, 150)}`);
  console.log();
}

process.exit(0);
