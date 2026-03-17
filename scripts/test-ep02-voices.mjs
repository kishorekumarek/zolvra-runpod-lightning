#!/usr/bin/env node
// scripts/test-ep02-voices.mjs — Test EP02 new voices with emotional variations

import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import { generateSpeech } from '../lib/tts.mjs';

const outputDir = '/Users/friday/.openclaw/workspace/streams/youtube/output/ep02-voice-samples';

// Ensure output directory exists
await fs.mkdir(outputDir, { recursive: true });

const testSamples = [
  {
    scene: 1,
    character: 'Arjun',
    voice_name: 'Bradford (Expressive)',
    voice_id: 'NNl6r8mD7vthiJatiJt1',
    tamil_text: 'Kaviyaa! Meenu! Vaanga, vilaiyaadalam!',
    english_gloss: 'Kaviya! Meenu! Come, let\'s play!',
    emotion: 'excited',
    tts_stability: 0.5,
    tts_style: 0.7,
    use_speaker_boost: true,
    filename: 'ep02-s01-arjun-excited-joy.mp3'
  },
  {
    scene: 2,
    character: 'Arjun',
    voice_name: 'Bradford (Expressive)',
    voice_id: 'NNl6r8mD7vthiJatiJt1',
    tamil_text: 'Ayo! Paaru, paaru! Minminni! Minminni!',
    english_gloss: 'Wow! Look, look! Fireflies! Fireflies!',
    emotion: 'wonder',
    tts_stability: 0.4,
    tts_style: 0.6,
    use_speaker_boost: false,
    filename: 'ep02-s02-arjun-wonder-awe.mp3'
  },
  {
    scene: 3,
    character: 'Kaviya',
    voice_name: 'Arabella (Mysterious & Emotive)',
    voice_id: 'Z3R5wn05IrDiVCyEkUrK',
    tamil_text: 'Pidichchudunga! Naanum varen! Odunga, odunga!',
    english_gloss: 'Catch them! I\'m coming too! Run, run!',
    emotion: 'excited',
    tts_stability: 0.5,
    tts_style: 0.7,
    use_speaker_boost: true,
    filename: 'ep02-s03-kaviya-playful-joy.mp3'
  },
  {
    scene: 5,
    character: 'Kaviya',
    voice_name: 'Arabella (Mysterious & Emotive)',
    voice_id: 'Z3R5wn05IrDiVCyEkUrK',
    tamil_text: 'Arjun... paaru. Bottle-la potathuku apram, minminni poochiyoda velicham konjam, konjama koraiyithu!',
    english_gloss: 'Arjun... look. Since we put them in the bottle, the fireflies\' light is getting dimmer and dimmer.',
    emotion: 'gentle',
    tts_stability: 0.3,
    tts_style: 0.4,
    use_speaker_boost: false,
    filename: 'ep02-s05-kaviya-sadness-concern.mp3'
  },
  {
    scene: 6,
    character: 'Kaviya',
    voice_name: 'Arabella (Mysterious & Emotive)',
    voice_id: 'Z3R5wn05IrDiVCyEkUrK',
    tamil_text: 'Antha poochigaluku bottle-ulla adaipattu irukrathu pidikala. Velila vitralama?',
    english_gloss: 'Those little lights don\'t like being trapped in the bottle. Should we let them go?',
    emotion: 'gentle',
    tts_stability: 0.4,
    tts_style: 0.5,
    use_speaker_boost: false,
    filename: 'ep02-s06-kaviya-hope-kindness.mp3'
  },
  {
    scene: 7,
    character: 'Kaviya',
    voice_name: 'Arabella (Mysterious & Emotive)',
    voice_id: 'Z3R5wn05IrDiVCyEkUrK',
    tamil_text: 'Ponga... ponga... seekiram ponga.',
    english_gloss: 'Go... go... go quickly.',
    emotion: 'gentle',
    tts_stability: 0.3,
    tts_style: 0.2,
    use_speaker_boost: false,
    filename: 'ep02-s07-kaviya-awe-reverence.mp3'
  },
  {
    scene: 8,
    character: 'Meenu',
    voice_name: 'Hope (Upbeat & Clear)',
    voice_id: 'tnSpp4vdxKPjI9w0GnoV',
    tamil_text: 'Paaru, Kaviya akka... romba azhagaa irukku.',
    english_gloss: 'Look, Kaviya sister... it\'s so beautiful.',
    emotion: 'excited',
    tts_stability: 0.4,
    tts_style: 0.6,
    use_speaker_boost: false,
    filename: 'ep02-s08-meenu-awe-wonder.mp3'
  }
];

console.log('🎙️  EP02 Voice Sample Generator');
console.log(`📁 Output: ${outputDir}`);
console.log(`🔄 Testing ${testSamples.length} scenes...\n`);

let successCount = 0;
let failCount = 0;

for (const sample of testSamples) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${timestamp}] Scene ${sample.scene}: ${sample.character} (${sample.emotion})`);
  console.log(`   Tamil: ${sample.tamil_text}`);
  console.log(`   Voice: ${sample.voice_name}`);

  try {
    const audioBuffer = await generateSpeech({
      text: sample.tamil_text,
      voiceId: sample.voice_id,
      emotion: sample.emotion,
      settings: {
        tts_stability: sample.tts_stability,
        tts_style: sample.tts_style,
        tts_similarity_boost: 0.75,
      },
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

  // Rate limit: ElevenLabs is ~1-2 calls/sec per free tier
  await new Promise(resolve => setTimeout(resolve, 1000));
}

console.log(`\n━━━ Summary ━━━`);
console.log(`✅ Success: ${successCount}/${testSamples.length}`);
console.log(`❌ Failed: ${failCount}/${testSamples.length}`);
console.log(`\n📂 All samples saved to: ${outputDir}`);
console.log(`\n🎧 Next: Listen to each sample and verify emotional accuracy.`);
console.log(`   Then suggest changes before we run the full pipeline.`);
