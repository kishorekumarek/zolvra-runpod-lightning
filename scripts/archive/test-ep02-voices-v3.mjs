#!/usr/bin/env node
// scripts/test-ep02-voices-v3.mjs — Test EP02 voices using correct ElevenLabs v3 format

import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';

const ELEVENLABS_BASE = 'https://api.us.elevenlabs.io/v1';
const outputDir = '/Users/friday/.openclaw/workspace/streams/youtube/output/ep02-voice-samples-v3';

await fs.mkdir(outputDir, { recursive: true });

/**
 * Call ElevenLabs TTS with v3 model + language_code + speed.
 */
async function callElevenLabsV3({ text, voiceId, voiceSettings }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

  const response = await fetch(
    `${ELEVENLABS_BASE}/text-to-speech/${voiceId}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_v3',           // ← v3 model
        language_code: 'ta',             // ← Tamil language
        voice_settings: { 
          ...voiceSettings, 
          speed: 0.92                    // ← v3 speed control
        },
        output_format: 'mp3_44100_128',
      }),
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
    throw new Error(`ElevenLabs error (${response.status}): ${errText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

const testSamples = [
  {
    scene: 1,
    character: 'Arjun',
    voice_id: 'oDV9OTaNLmINQYHfVOXe',   // Cubbie (original)
    tamil_text: 'Kaviyaa! Meenu! Vaanga, vilaiyaadalam!',
    emotion: 'excited',
    voice_settings: { stability: 0.45, similarity_boost: 0.42, style: 0.25, use_speaker_boost: true },
    filename: 'ep02-s01-arjun-excited.mp3'
  },
  {
    scene: 2,
    character: 'Arjun',
    voice_id: 'oDV9OTaNLmINQYHfVOXe',
    tamil_text: 'Ayo! Paaru, paaru! Minminni! Minminni!',
    emotion: 'excited',
    voice_settings: { stability: 0.45, similarity_boost: 0.42, style: 0.25, use_speaker_boost: true },
    filename: 'ep02-s02-arjun-wonder.mp3'
  },
  {
    scene: 3,
    character: 'Kaviya',
    voice_id: 'DNLl3gCCSh2dfb1WDBpZ',   // Mridula (original, female)
    tamil_text: 'Pidichchudunga! Naanum varen! Odunga, odunga!',
    emotion: 'happy',
    voice_settings: { stability: 0.5, similarity_boost: 0.42, style: 0.2, use_speaker_boost: true },
    filename: 'ep02-s03-kaviya-joy.mp3'
  },
  {
    scene: 5,
    character: 'Kaviya',
    voice_id: 'DNLl3gCCSh2dfb1WDBpZ',
    tamil_text: 'Arjun... paaru. Bottle-la potathuku apram, minminni poochiyoda velicham konjam, konjama koraiyithu!',
    emotion: 'gentle',
    voice_settings: { stability: 0.55, similarity_boost: 0.42, style: 0.18, use_speaker_boost: true },
    filename: 'ep02-s05-kaviya-concern.mp3'
  },
  {
    scene: 6,
    character: 'Kaviya',
    voice_id: 'DNLl3gCCSh2dfb1WDBpZ',
    tamil_text: 'Antha poochigaluku bottle-ulla adaipattu irukrathu pidikala. Velila vitralama?',
    emotion: 'gentle',
    voice_settings: { stability: 0.55, similarity_boost: 0.42, style: 0.18, use_speaker_boost: true },
    filename: 'ep02-s06-kaviya-hope.mp3'
  },
  {
    scene: 7,
    character: 'Kaviya',
    voice_id: 'DNLl3gCCSh2dfb1WDBpZ',
    tamil_text: 'Ponga... ponga... seekiram ponga.',
    emotion: 'gentle',
    voice_settings: { stability: 0.55, similarity_boost: 0.42, style: 0.18, use_speaker_boost: true },
    filename: 'ep02-s07-kaviya-whisper.mp3'
  },
  {
    scene: 8,
    character: 'Meenu',
    voice_id: 'KNmZI8RXLqk94uYj1GaH',   // Hunter 2 (original children)
    tamil_text: 'Paaru, Kaviya akka... romba azhagaa irukku.',
    emotion: 'happy',
    voice_settings: { stability: 0.5, similarity_boost: 0.42, style: 0.2, use_speaker_boost: true },
    filename: 'ep02-s08-meenu-awe.mp3'
  }
];

console.log('🎙️  EP02 Voice Samples — ElevenLabs v3 Format');
console.log(`📁 Output: ${outputDir}`);
console.log(`🔄 Testing ${testSamples.length} scenes with ORIGINAL working voices...\n`);

let successCount = 0;
let failCount = 0;

for (const sample of testSamples) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${timestamp}] Scene ${sample.scene}: ${sample.character} (${sample.emotion})`);
  console.log(`   Tamil: ${sample.tamil_text}`);

  try {
    const audioBuffer = await callElevenLabsV3({
      text: sample.tamil_text,
      voiceId: sample.voice_id,
      voiceSettings: sample.voice_settings,
    });

    const filePath = path.join(outputDir, sample.filename);
    await fs.writeFile(filePath, audioBuffer);

    const fileSize = (audioBuffer.length / 1024).toFixed(1);
    console.log(`   ✅ Generated: ${sample.filename} (${fileSize} KB)\n`);
    successCount++;
  } catch (error) {
    console.error(`   ❌ FAILED: ${error.message}\n`);
    failCount++;
  }

  await new Promise(resolve => setTimeout(resolve, 1000));
}

console.log(`\n━━━ Summary ━━━`);
console.log(`✅ Success: ${successCount}/${testSamples.length}`);
console.log(`❌ Failed: ${failCount}/${testSamples.length}`);
console.log(`\n📂 Samples saved to: ${outputDir}`);
console.log(`\n🎙️  Voice Mapping (EP02):`);
console.log(`  Arjun  → oDV9OTaNLmINQYHfVOXe (Cubbie — original)`);
console.log(`  Kaviya → DNLl3gCCSh2dfb1WDBpZ (Mridula — original)`);
console.log(`  Meenu  → KNmZI8RXLqk94uYj1GaH (Hunter 2 — original)`);
console.log(`\n✅ Using ElevenLabs v3 model with language_code='ta' and speed=0.92`);
