// scripts/test-tamil-script-tts.mjs — A/B test: romanized vs Tamil script vs mixed on ElevenLabs v3
// Usage: node scripts/test-tamil-script-tts.mjs
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'tmp', 'tamil-script-test');

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const API_KEY = process.env.ELEVENLABS_API_KEY;

// Use Kavin's voice (Cubbie - male child)
const VOICE_ID = 'oDV9OTaNLmINQYHfVOXe';

const TEST_CASES = [
  // --- Sentence 1: Excited dialogue ---
  {
    id: '1a_romanized',
    label: 'Sentence 1 — Romanized Tamil',
    text: 'naan romba khushi aana paaru!',
  },
  {
    id: '1b_tamil_script',
    label: 'Sentence 1 — Tamil Script',
    text: 'நான் ரொம்ப குஷி ஆனா பாரு!',
  },
  {
    id: '1c_tamil_with_tags',
    label: 'Sentence 1 — Tamil Script + v3 audio tags',
    text: '[excited] நான் ரொம்ப குஷி, ஆனா... பாரு!',
  },
  {
    id: '1d_romanized_with_tags',
    label: 'Sentence 1 — Romanized + v3 audio tags',
    text: '[excited] naan ROMBA khushi, aana... paaru!',
  },

  // --- Sentence 2: Casual / bored ---
  {
    id: '2a_romanized',
    label: 'Sentence 2 — Romanized Tamil',
    text: 'enakku romba bore adikkudhu, moviekku polaama?',
  },
  {
    id: '2b_tamil_script',
    label: 'Sentence 2 — Tamil Script',
    text: 'எனக்கு ரொம்ப போர் அடிக்குது, மூவிக்கு போலாமா?',
  },
  {
    id: '2c_tamil_mixed',
    label: 'Sentence 2 — Tamil Script + English loanwords',
    text: 'எனக்கு ரொம்ப bore அடிக்குது, movieக்கு போலாமா?',
  },
  {
    id: '2d_tamil_with_tags',
    label: 'Sentence 2 — Tamil Script + v3 tags',
    text: '[sighs] எனக்கு ரொம்ப போர் அடிக்குது... மூவிக்கு போலாமா?',
  },

  // --- Sentence 3: Gentle / descriptive (narrator style) ---
  {
    id: '3a_romanized',
    label: 'Sentence 3 — Romanized Tamil',
    text: 'oru azhagaana kaattula, chinna mayil onnu thoongitu irundhuchi.',
  },
  {
    id: '3b_tamil_script',
    label: 'Sentence 3 — Tamil Script',
    text: 'ஒரு அழகான காட்டுல, சின்ன மயில் ஒன்னு தூங்கிட்டு இருந்துச்சு.',
  },
  {
    id: '3c_tamil_with_tags',
    label: 'Sentence 3 — Tamil Script + v3 tags',
    text: '[gentle] ஒரு அழகான காட்டுல... சின்ன மயில் ஒன்னு தூங்கிட்டு இருந்துச்சு.',
  },

  // --- Sentence 4: Scared / whisper ---
  {
    id: '4a_romanized',
    label: 'Sentence 4 — Romanized Tamil',
    text: 'Aiyyo, andha pakkam yaaro irukkanga! enaku romba bayama iruku.',
  },
  {
    id: '4b_tamil_script',
    label: 'Sentence 4 — Tamil Script',
    text: 'ஐய்யோ, அந்த பக்கம் யாரோ இருக்காங்க! எனக்கு ரொம்ப பயமா இருக்கு.',
  },
  {
    id: '4c_tamil_with_tags',
    label: 'Sentence 4 — Tamil Script + v3 tags',
    text: '[whisper] ஐய்யோ... அந்த பக்கம் யாரோ இருக்காங்க! [scared] எனக்கு ரொம்ப பயமா இருக்கு.',
  },
];

async function generateTTS(text, voiceId) {
  const response = await fetch(
    `${ELEVENLABS_BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_v3',
        voice_settings: {},
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs error (${response.status}): ${err}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  if (!API_KEY) {
    console.error('❌ ELEVENLABS_API_KEY not set');
    process.exit(1);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  console.log(`🎙️  Tamil Script TTS A/B Test — ${TEST_CASES.length} variants`);
  console.log(`📁 Output: ${OUTPUT_DIR}\n`);

  const results = [];

  for (const tc of TEST_CASES) {
    console.log(`  ${tc.id}: ${tc.label}`);
    console.log(`    Text: ${tc.text}`);
    try {
      const buffer = await generateTTS(tc.text, VOICE_ID);
      const outPath = join(OUTPUT_DIR, `${tc.id}.mp3`);
      await fs.writeFile(outPath, buffer);
      console.log(`    ✓ Saved: ${outPath}\n`);
      results.push({ ...tc, path: outPath, status: 'ok' });
    } catch (err) {
      console.error(`    ✗ Failed: ${err.message}\n`);
      results.push({ ...tc, status: 'error', error: err.message });
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  // Write summary
  const summary = results.map(r =>
    `${r.status === 'ok' ? '✓' : '✗'} ${r.id} — ${r.label}\n  Text: ${r.text}\n  File: ${r.path || 'N/A'}`
  ).join('\n\n');

  const summaryPath = join(OUTPUT_DIR, 'README.txt');
  await fs.writeFile(summaryPath, `Tamil Script TTS A/B Test Results\n${'='.repeat(40)}\n\n${summary}\n`);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ Done! ${results.filter(r => r.status === 'ok').length}/${results.length} generated`);
  console.log(`📁 Listen to files in: ${OUTPUT_DIR}`);
  console.log(`\nCompare:`);
  console.log(`  1. Romanized vs Tamil script — pronunciation quality`);
  console.log(`  2. Tamil script + audio tags — do [excited], [whisper] etc. still work?`);
  console.log(`  3. Mixed Tamil+English loanwords — does it handle code-switching?`);
  console.log(`  4. CAPITALS emphasis — only works with Latin chars, check if tags compensate`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
