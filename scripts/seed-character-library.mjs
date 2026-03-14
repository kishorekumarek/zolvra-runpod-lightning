#!/usr/bin/env node
// scripts/seed-character-library.mjs — Seed initial characters (NARRATOR + Velu)
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';

const characters = [
  {
    name: 'NARRATOR',
    description: 'The story narrator. Warm, gentle storytelling voice for Tamil kids. No visual representation.',
    reference_image_url: null,
    image_prompt: null,
    voice_id: process.env.ELEVENLABS_NARRATOR_VOICE_ID || 'XCVlHBLvc3SVXhH7pRkb',
    approved: true,
  },
  {
    name: 'Velu',
    description: 'A curious 6-year-old Tamil boy with big eyes and a gap-toothed smile. Wears a white shirt and blue shorts. Loves animals.',
    reference_image_url: null,
    image_prompt: "A cheerful Tamil boy aged 6, big brown eyes, gap-toothed smile, short black hair, white shirt, blue shorts, warm skin tone, soft watercolor children's illustration style, friendly expression, 16:9 composition",
    voice_id: process.env.ELEVENLABS_NARRATOR_VOICE_ID || 'XCVlHBLvc3SVXhH7pRkb', // use narrator voice as default placeholder
    approved: false, // Darl must approve first
  },
];

async function seedCharacters() {
  const sb = getSupabase();

  console.log('🌱 Seeding character_library...\n');

  for (const char of characters) {
    const { data: existing } = await sb
      .from('character_library')
      .select('id, name')
      .eq('name', char.name)
      .single();

    if (existing) {
      console.log(`  ⏭️  ${char.name} already exists — skipping`);
      continue;
    }

    const { error } = await sb
      .from('character_library')
      .insert(char);

    if (error) {
      console.error(`  ❌ ${char.name}: ${error.message}`);
    } else {
      console.log(`  ✅ ${char.name} (approved: ${char.approved})`);
    }
  }

  console.log('\n📋 Character seeding complete');
  console.log('ℹ️  Note: Velu requires Darl approval (approved: false) before use in pipeline');
}

seedCharacters().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
