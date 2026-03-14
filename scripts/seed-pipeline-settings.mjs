#!/usr/bin/env node
// scripts/seed-pipeline-settings.mjs — Insert default pipeline_settings from SPEC.md Section 2.4
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';

const SETTINGS = [
  { key: 'feedback_collection_mode',      value: true },
  { key: 'feedback_collection_target',    value: 10 },
  { key: 'feedback_collection_completed', value: 0 },
  { key: 'budget_target_usd',             value: 8.00 },
  { key: 'budget_hard_cap_usd',           value: 10.00 },
  { key: 'image_model',                   value: 'imagen-3.0-fast-generate-001' },
  { key: 'animation_model',               value: 'kling-v1-5' },
  { key: 'tts_stability',                 value: 0.50 },
  { key: 'tts_similarity_boost',          value: 0.75 },
  { key: 'tts_style',                     value: 0.45 },
  { key: 'tts_speaking_rate',             value: 0.85 },
  { key: 'kling_default_duration',        value: 5 },
  { key: 'kling_cfg_scale',               value: 0.5 },
  {
    key: 'kling_motion_type_defaults',
    value: {
      dialogue:  { duration: 5, cfg_scale: 0.4 },
      action:    { duration: 5, cfg_scale: 0.6 },
      landscape: { duration: 5, cfg_scale: 0.3 },
      emotional: { duration: 5, cfg_scale: 0.5 },
    },
  },
  {
    key: 'ssml_defaults',
    value: {
      narrator_rate:             'slow',
      character_rate:            'medium',
      pause_between_lines_ms:    600,
      pause_after_scene_ms:      1200,
    },
  },
  { key: 'youtube_default_category_id',   value: '27' },
  { key: 'youtube_default_playlist_id',   value: 'PLACEHOLDER' },
  { key: 'scenes_per_video_target',       value: 10 },
  { key: 'takes_per_audio_segment',       value: 2 },
  { key: 'background_music_pool',         value: [] },
];

async function seedSettings() {
  const sb = getSupabase();

  console.log('🌱 Seeding pipeline_settings...\n');

  let ok = 0;
  let errors = 0;

  for (const { key, value } of SETTINGS) {
    const { error } = await sb
      .from('pipeline_settings')
      .upsert({ key, value }, { onConflict: 'key' });

    if (error) {
      console.error(`  ❌ ${key}: ${error.message}`);
      errors++;
    } else {
      console.log(`  ✅ ${key}`);
      ok++;
    }
  }

  console.log(`\n📋 Done: ${ok} settings seeded, ${errors} errors`);
  if (errors > 0) process.exit(1);
}

seedSettings().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
