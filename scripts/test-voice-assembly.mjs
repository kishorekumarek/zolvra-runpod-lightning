#!/usr/bin/env node
// scripts/test-voice-assembly.mjs
// Tests new voice casting + emotion + full-clip assembly with SFX + BGM on 2 existing Hailuo clips
// Run: node scripts/test-voice-assembly.mjs

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { promises as fs } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { VOICE_MAP, EMOTION_SETTINGS } from '../lib/voice-config.mjs';
import { getSfxPath } from '../lib/sfx-mixer.mjs';
import { getBgmPath } from '../lib/bgm-selector.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const TASK_ID = 'a0eb49a6-f2ca-4427-8864-b3a0c95ec5c9';
const TMP = '/tmp/zolvra-test-2clip-v2';
const OUT = join(__dirname, '..', 'output', 'test-2clip-v2.mp4');
const FFMPEG = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';

const TEST_SCENES = [
  {
    scene_number: 1,
    speaker: 'narrator',
    emotion: 'gentle',
    environment: 'forest_rain',
    text: 'Oru naal, kaatula rain penjitu irunthuchi. Paandi mayil thannoda friends-kita odi vanthaan.',
    visual_description: 'Paandi the peacock running through gentle rain towards his friends in a lush green forest',
  },
  {
    scene_number: 2,
    speaker: 'paandi',
    emotion: 'excited',
    environment: 'forest_rain',
    text: 'Ayyo, parunga! Rainbow irukku! Super-a irukulla?',
    visual_description: 'Paandi pointing excitedly at a rainbow with wings spread wide, eyes bright with joy',
  },
];

async function callElevenLabs({ text, voiceId, voiceSettings }) {
  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}/stream`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: voiceSettings,
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs error ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

function getDuration(path) {
  const out = execSync(`ffprobe -v quiet -print_format json -show_streams "${path}"`).toString();
  return parseFloat(JSON.parse(out).streams[0].duration);
}

async function main() {
  await fs.mkdir(TMP, { recursive: true });
  await fs.mkdir(join(__dirname, '..', 'output'), { recursive: true });

  const sfxPath = getSfxPath('forest_rain');
  const bgmPath = getBgmPath();

  console.log('🧪 2-clip voice + assembly test (v2 — full clip duration + SFX + BGM)\n');
  console.log(`  SFX  : ${sfxPath || 'not found (forest_rain.mp3 missing)'}`);
  console.log(`  BGM  : ${bgmPath || 'not found (kids_folk_01.mp3 missing)'}`);
  console.log('');

  const sceneFinalPaths = [];
  let bgmOffset = 0;

  for (const scene of TEST_SCENES) {
    const pad = String(scene.scene_number).padStart(2, '0');
    const voiceId = VOICE_MAP[scene.speaker.toLowerCase()] || VOICE_MAP.default;
    const voiceSettings = EMOTION_SETTINGS[scene.emotion] || EMOTION_SETTINGS.normal;

    console.log(`Scene ${scene.scene_number}:`);
    console.log(`  Voice ID : ${voiceId} (${scene.speaker})`);
    console.log(`  Emotion  : ${scene.emotion} → stability=${voiceSettings.stability}, style=${voiceSettings.style}`);
    console.log(`  Text     : ${scene.text}`);

    // Download clip from Supabase storage
    const clipPath = join(TMP, `scene_${pad}_clip.mp4`);
    const { data: clipBlob, error } = await sb.storage.from('scenes')
      .download(`${TASK_ID}/scene_${pad}_anim.mp4`);
    if (error) throw new Error(`Clip download failed: ${error.message}`);
    await fs.writeFile(clipPath, Buffer.from(await clipBlob.arrayBuffer()));

    // Fix 1: use full clip duration, not audio duration
    const clipDur = getDuration(clipPath);
    console.log(`  Clip     : downloaded (${clipDur.toFixed(1)}s)`);

    // Generate audio via ElevenLabs
    const audioPath = join(TMP, `scene_${pad}_audio.mp3`);
    const audioBuffer = await callElevenLabs({ text: scene.text, voiceId, voiceSettings });
    await fs.writeFile(audioPath, audioBuffer);
    const audioDur = getDuration(audioPath);
    console.log(`  Audio    : generated (${audioDur.toFixed(1)}s) — clip has ${(clipDur - audioDur).toFixed(1)}s ambient tail`);

    // Assemble with full clip duration + SFX loop + BGM segment
    const finalPath = join(TMP, `scene_${pad}_final.mp4`);

    if (sfxPath && bgmPath) {
      const fc = [
        `[1:a]volume=1.0[voice]`,
        `[2:a]atrim=duration=${clipDur},asetpts=PTS-STARTPTS,volume=0.15[sfx]`,
        `[3:a]atrim=duration=${clipDur},asetpts=PTS-STARTPTS,volume=0.12[bgm]`,
        `[voice][sfx][bgm]amix=inputs=3:duration=longest[aout]`,
      ].join(';');

      execSync([
        `"${FFMPEG}" -y -loglevel error`,
        `-stream_loop -1 -i "${clipPath}"`,
        `-i "${audioPath}"`,
        `-stream_loop -1 -i "${sfxPath}"`,
        `-ss ${bgmOffset.toFixed(3)} -stream_loop -1 -i "${bgmPath}"`,
        `-t ${clipDur}`,
        `-map 0:v`,
        `-filter_complex "${fc}"`,
        `-map "[aout]"`,
        `-c:v libx264 -preset fast -crf 22`,
        `-c:a aac -b:a 192k`,
        `"${finalPath}"`,
      ].join(' '));
    } else {
      // Fallback: voice only, full clip duration
      execSync([
        `"${FFMPEG}" -y -loglevel error`,
        `-stream_loop -1 -i "${clipPath}"`,
        `-i "${audioPath}"`,
        `-map 0:v -map 1:a`,
        `-t ${clipDur}`,
        `-c:v libx264 -preset fast -crf 22`,
        `-c:a aac -b:a 192k`,
        `"${finalPath}"`,
      ].join(' '));
    }

    bgmOffset += clipDur;
    const finalDur = getDuration(finalPath);
    console.log(`  Scene    : assembled (${finalDur.toFixed(1)}s) ✓\n`);
    sceneFinalPaths.push(finalPath);
  }

  // Concat all scenes
  const concatFile = join(TMP, 'concat.txt');
  await fs.writeFile(concatFile, sceneFinalPaths.map(p => `file '${p}'`).join('\n'));
  const concatPath = join(TMP, 'concat.mp4');
  execSync([
    `"${FFMPEG}" -y -loglevel error -f concat -safe 0 -i "${concatFile}"`,
    `-c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k`,
    `"${concatPath}"`,
  ].join(' '));

  // Apply continuous BGM overlay: vol 0.1, fade in 2s, fade out 3s
  let outPath = concatPath;
  if (bgmPath) {
    const concatDur = getDuration(concatPath);
    const fadeOutStart = Math.max(0, concatDur - 3);
    const fc = [
      `[1:a]volume=0.1,afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=3[bgm_faded]`,
      `[0:a][bgm_faded]amix=inputs=2:duration=first[aout]`,
    ].join(';');

    execSync([
      `"${FFMPEG}" -y -loglevel error`,
      `-i "${concatPath}"`,
      `-stream_loop -1 -i "${bgmPath}"`,
      `-t ${concatDur}`,
      `-filter_complex "${fc}"`,
      `-map 0:v -map "[aout]"`,
      `-c:v copy -c:a aac -b:a 192k`,
      `"${OUT}"`,
    ].join(' '));
    outPath = OUT;
  } else {
    await fs.copyFile(concatPath, OUT);
    outPath = OUT;
  }

  const totalDur = getDuration(OUT);
  const size = (await fs.stat(OUT)).size;

  console.log(`✅ Test video: ${OUT}`);
  console.log(`   Voice IDs   : ${[...new Set(TEST_SCENES.map(s => VOICE_MAP[s.speaker.toLowerCase()] || VOICE_MAP.default))].join(', ')}`);
  console.log(`   Emotions    : ${TEST_SCENES.map(s => s.emotion).join(', ')}`);
  console.log(`   SFX used    : ${sfxPath ? 'forest_rain.mp3 (vol 0.15 per scene)' : 'none (file missing)'}`);
  console.log(`   BGM used    : ${bgmPath ? 'kids_folk_01.mp3 (vol 0.12 per scene + vol 0.1 final)' : 'none (file missing)'}`);
  console.log(`   Durations   : ${sceneFinalPaths.map((_, i) => getDuration(sceneFinalPaths[i]).toFixed(1) + 's').join(', ')}`);
  console.log(`   Final video : ${totalDur.toFixed(1)}s | ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log('\nOpening in QuickTime...');
  execSync(`open "${OUT}"`);
}

main().catch(e => { console.error('✗', e.message); process.exit(1); });
