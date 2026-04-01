#!/usr/bin/env node
// scripts/regenerate-ep02-scenes-7-8-v2.mjs — Regenerate Scene 7 & 8 with updated Tamil dialogues

import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set');

const outputDir = '/Users/friday/.openclaw/workspace/streams/youtube/output/ep02-minmini-samples-v3';

const scenes = [
  {
    scene: 7,
    character: 'Kaavya',
    voice_id: '2zRM7PkgwBPiau2jvVXc',
    dialogue: '[excited] போங்க போங்க... [giggling] ஜாலி-ஆ பறந்து போங்க',
    filename: 'ep02-s07-kaavya-blessing.mp3'
  },
  {
    scene: 8,
    character: 'Meenu',
    voice_id: 'Sm1seazb4gs7RSlUVw7c',
    dialogue: '[excited] Paaru, Kaavya akka... [sighs with awe] romba super-ah irukku. [thoughtful] Yarayum… koondula adachi vekka-vey kudaathu',
    filename: 'ep02-s08-meenu-awe.mp3'
  }
];

console.log('🎙️  EP02 Scenes 7-8 Regeneration (v2 — Updated Tamil + Giggling)\n');

let successCount = 0;
let failCount = 0;

for (const scene of scenes) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${timestamp}] Scene ${scene.scene}: ${scene.character}`);
  console.log(`   Text: ${scene.dialogue}`);

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${scene.voice_id}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: scene.dialogue,
          model_id: 'eleven_v3',
          voice_settings: {}
        })
      }
    );

    if (!response.ok) {
      let errText;
      try {
        const errData = await response.json();
        errText = JSON.stringify(errData);
      } catch {
        errText = await response.text();
      }
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const filePath = path.join(outputDir, scene.filename);
    await fs.writeFile(filePath, audioBuffer);

    const fileSize = (audioBuffer.length / 1024).toFixed(1);
    console.log(`   ✅ Regenerated: ${scene.filename} (${fileSize} KB)\n`);
    successCount++;
  } catch (error) {
    console.error(`   ❌ FAILED: ${error.message}\n`);
    failCount++;
  }

  await new Promise(resolve => setTimeout(resolve, 1000));
}

console.log(`━━━ Summary ━━━`);
console.log(`✅ Success: ${successCount}/2`);
console.log(`❌ Failed: ${failCount}/2`);
console.log(`\n📂 Updated in: ${outputDir}`);
console.log(`\n✅ Scene 7: Tamil script + [giggling] = playful goodbye to fireflies`);
console.log(`✅ Scene 8: Added "koondula" (wild/untamed) = wisdom about freedom`);
