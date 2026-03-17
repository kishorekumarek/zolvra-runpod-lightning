#!/usr/bin/env node
// scripts/generate-ep02-minmini-v3.mjs — Generate EP02 voice samples with ElevenLabs v3 format

import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set');

const outputDir = '/Users/friday/.openclaw/workspace/streams/youtube/output/ep02-minmini-samples-v3';
await fs.mkdir(outputDir, { recursive: true });

const scenes = [
  {
    scene: 1,
    character: 'Arjun',
    voice_id: 'oDV9OTaNLmINQYHfVOXe',
    dialogue: '[excited] Kaavyaa! Meenu! VAANGA, vilaiyaadalam!',
    filename: 'ep02-s01-arjun-excited.mp3'
  },
  {
    scene: 2,
    character: 'Arjun',
    voice_id: 'oDV9OTaNLmINQYHfVOXe',
    dialogue: '[surprised] Haiyyo! Paaru... paaru! MINMINI! MINMINI!',
    filename: 'ep02-s02-arjun-wonder.mp3'
  },
  {
    scene: 3,
    character: 'Kaavya',
    voice_id: '2zRM7PkgwBPiau2jvVXc',
    dialogue: '[excited] Pidinga Pidinga! [laughing] Naanum varen! ODUNGA!',
    filename: 'ep02-s03-kaavya-playful.mp3'
  },
  {
    scene: 4,
    character: 'Arjun',
    voice_id: 'oDV9OTaNLmINQYHfVOXe',
    dialogue: '[mischievously] Pudi-nga, pudi-nga! Bottle-la podunga! [curious] Paaru... EVVALAVU super-ah iruku!',
    filename: 'ep02-s04-arjun-mischievous.mp3'
  },
  {
    scene: 5,
    character: 'Kaavya',
    voice_id: '2zRM7PkgwBPiau2jvVXc',
    dialogue: '[thoughtful] Arjun... [sighs] paaru. Bottle-la potathukapram… minmini poochiyoda velicham konjam... konjama koraiyithu.',
    filename: 'ep02-s05-kaavya-realization.mp3'
  },
  {
    scene: 6,
    character: 'Kaavya',
    voice_id: '2zRM7PkgwBPiau2jvVXc',
    dialogue: '[gently] Antha poochigaluku bottle-ulla adaipattu irukrathu... pidikala. [hopeful] Velila vitralama?',
    filename: 'ep02-s06-kaavya-hope.mp3'
  },
  {
    scene: 7,
    character: 'Kaavya',
    voice_id: '2zRM7PkgwBPiau2jvVXc',
    dialogue: '[whispers] Ponga... ponga... seekiram ponga.',
    filename: 'ep02-s07-kaavya-blessing.mp3'
  },
  {
    scene: 8,
    character: 'Meenu',
    voice_id: 'Sm1seazb4gs7RSlUVw7c',
    dialogue: '[softly amazed] Paaru, Kaavya akka... [sighs with awe] romba super-ah irukku. [thoughtful] Yarayum adaichi vekave kudathu',
    filename: 'ep02-s08-meenu-awe.mp3'
  }
];

console.log('🎙️  EP02 "Minmini" Voice Generation — ElevenLabs v3');
console.log(`📁 Output: ${outputDir}`);
console.log(`🔄 Generating ${scenes.length} scenes...\n`);

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
    console.log(`   ✅ Generated: ${scene.filename} (${fileSize} KB)\n`);
    successCount++;
  } catch (error) {
    console.error(`   ❌ FAILED: ${error.message}\n`);
    failCount++;
  }

  // Rate limit: 1 second between calls
  await new Promise(resolve => setTimeout(resolve, 1000));
}

console.log(`\n━━━ Summary ━━━`);
console.log(`✅ Success: ${successCount}/${scenes.length}`);
console.log(`❌ Failed: ${failCount}/${scenes.length}`);
console.log(`\n📂 All samples saved to: ${outputDir}`);
console.log(`\n🎧 Voice Mapping:`);
console.log(`  Arjun  → oDV9OTaNLmINQYHfVOXe (scenes 1, 2, 4)`);
console.log(`  Kaavya → 2zRM7PkgwBPiau2jvVXc (scenes 3, 5, 6, 7)`);
console.log(`  Meenu  → Sm1seazb4gs7RSlUVw7c (scene 8)`);
console.log(`\n✅ ElevenLabs v3 format: voice_settings: {} + audio tags + pauses`);
