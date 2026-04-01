#!/usr/bin/env node
// scripts/download-and-assemble-ep02.mjs
// Download 8 scene animations from Supabase → assemble with voice + BGM + logo + end card → upload

import 'dotenv/config';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { getSupabase } from '../lib/supabase.mjs';

const baseDir = '/Users/friday/.openclaw/workspace/streams/youtube';
const ffmpeg = '/opt/homebrew/bin/ffmpeg';
const ffprobe = '/opt/homebrew/bin/ffprobe';
const taskId = '210cfd98-f7d1-4f06-ac1d-e0f2587441d4';

const voiceDir = path.join(baseDir, 'output/ep02-minmini-samples-v3');
const bgmFile = path.join(baseDir, 'assets/bgm/kids_folk_02.mp3');
const logoFile = path.join(baseDir, 'assets/channel-logo.png');
const endCardVideo = path.join(baseDir, 'assets/shorts_end_card.mp4');
const endCardAudio = path.join(baseDir, 'assets/end_card_audio.mp3');

const workDir = path.join(baseDir, 'output/ep02-assembly-final');
const scenesDir = path.join(workDir, 'scenes');
const tempDir = path.join(workDir, 'temp');

await fs.mkdir(scenesDir, { recursive: true });
await fs.mkdir(tempDir, { recursive: true });

const sb = getSupabase();

// ─── STEP 1: Download 8 scene animations from Supabase ───────────────────────
console.log('📥 STEP 1: Downloading 8 scene animations from Supabase...\n');

for (let i = 1; i <= 8; i++) {
  const fileName = `scene_${String(i).padStart(2, '0')}_anim.mp4`;
  const storagePath = `${taskId}/${fileName}`;
  const localPath = path.join(scenesDir, fileName);

  // Check if already downloaded
  try {
    await fs.access(localPath);
    const stat = await fs.stat(localPath);
    if (stat.size > 100000) {
      console.log(`  Scene ${i}: Already downloaded (${(stat.size/1024/1024).toFixed(1)}MB)`);
      continue;
    }
  } catch {}

  console.log(`  Scene ${i}: Downloading ${storagePath}...`);
  const { data, error } = await sb.storage.from('scenes').download(storagePath);
  if (error) {
    console.error(`  ❌ Scene ${i} download failed:`, error.message);
    process.exit(1);
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  await fs.writeFile(localPath, buffer);
  console.log(`  ✅ Scene ${i}: ${(buffer.length/1024/1024).toFixed(1)}MB`);
}

console.log('\n✅ All 8 scene animations downloaded\n');

// ─── STEP 2: Get durations of each scene video and voice sample ───────────────
console.log('📏 STEP 2: Measuring durations...\n');

function getDuration(filePath) {
  const result = execSync(
    `"${ffprobe}" -v error -show_entries format=duration -of csv=p=0 "${filePath}"`
  ).toString().trim();
  return parseFloat(result);
}

const voiceFiles = [
  'ep02-s01-arjun-excited.mp3',
  'ep02-s02-arjun-wonder.mp3',
  'ep02-s03-kaavya-playful.mp3',
  'ep02-s04-arjun-mischievous.mp3',
  'ep02-s05-kaavya-realization.mp3',
  'ep02-s06-kaavya-hope.mp3',
  'ep02-s07-kaavya-blessing.mp3',
  'ep02-s08-meenu-awe.mp3',
];

for (let i = 0; i < 8; i++) {
  const sceneFile = path.join(scenesDir, `scene_${String(i+1).padStart(2, '0')}_anim.mp4`);
  const voiceFile = path.join(voiceDir, voiceFiles[i]);
  const sceneDur = getDuration(sceneFile);
  const voiceDur = getDuration(voiceFile);
  console.log(`  Scene ${i+1}: video=${sceneDur.toFixed(2)}s, voice=${voiceDur.toFixed(2)}s${voiceDur > sceneDur ? ' ⚠️ voice longer' : ''}`);
}

// ─── STEP 3: For each scene, combine video + voice (trim video to voice length) ─
console.log('\n🎬 STEP 3: Combining each scene video with voice audio...\n');

const assembledScenes = [];
for (let i = 0; i < 8; i++) {
  const idx = String(i+1).padStart(2, '0');
  const sceneFile = path.join(scenesDir, `scene_${idx}_anim.mp4`);
  const voiceFile = path.join(voiceDir, voiceFiles[i]);
  const outputFile = path.join(tempDir, `scene_${idx}_with_voice.mp4`);

  const voiceDur = getDuration(voiceFile);
  const sceneDur = getDuration(sceneFile);

  // If voice is shorter than video, trim video to voice length (no looping)
  // If voice is longer than video, freeze last frame
  if (voiceDur <= sceneDur) {
    // Trim video to voice duration — no unnecessary looping
    execSync(`"${ffmpeg}" -y -i "${sceneFile}" -i "${voiceFile}" -t ${voiceDur.toFixed(3)} -map 0:v -map 1:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -shortest "${outputFile}"`, { stdio: 'pipe' });
  } else {
    // Voice longer than video: loop video to match voice
    execSync(`"${ffmpeg}" -y -stream_loop -1 -i "${sceneFile}" -i "${voiceFile}" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -shortest "${outputFile}"`, { stdio: 'pipe' });
  }

  const outDur = getDuration(outputFile);
  console.log(`  Scene ${i+1}: ${outDur.toFixed(2)}s ✅`);
  assembledScenes.push(outputFile);
}

// ─── STEP 4: Concatenate all 8 scenes ─────────────────────────────────────────
console.log('\n🔗 STEP 4: Concatenating 8 scenes...\n');

const concatList = path.join(tempDir, 'concat-scenes.txt');
const concatContent = assembledScenes.map(f => `file '${f}'`).join('\n');
await fs.writeFile(concatList, concatContent);

const concatOutput = path.join(tempDir, 'all-scenes-concat.mp4');
execSync(`"${ffmpeg}" -y -f concat -safe 0 -i "${concatList}" -c copy "${concatOutput}"`, { stdio: 'pipe' });

const concatDur = getDuration(concatOutput);
console.log(`  Total duration: ${concatDur.toFixed(2)}s ✅\n`);

// ─── STEP 5: Add BGM (low volume) ────────────────────────────────────────────
console.log('🎵 STEP 5: Adding BGM...\n');

const withBgm = path.join(tempDir, 'with-bgm.mp4');
execSync(`"${ffmpeg}" -y -i "${concatOutput}" -i "${bgmFile}" -filter_complex "[1:a]volume=0.15,aloop=loop=-1:size=2e+09[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 128k "${withBgm}"`, { stdio: 'pipe' });
console.log(`  ✅ BGM added (volume=0.15)\n`);

// ─── STEP 6: Add logo overlay (top right, clear) ─────────────────────────────
console.log('🏷️  STEP 6: Adding logo overlay (top right)...\n');

// Get video dimensions first
const dimensions = execSync(
  `"${ffprobe}" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${withBgm}"`
).toString().trim().split(',');
const [vidW, vidH] = dimensions.map(Number);
console.log(`  Video dimensions: ${vidW}x${vidH}`);

// Scale logo to ~8% of video width, position top-right with 20px padding
const logoW = Math.round(vidW * 0.12);
const withLogo = path.join(tempDir, 'with-logo.mp4');
execSync(`"${ffmpeg}" -y -i "${withBgm}" -i "${logoFile}" -filter_complex "[1:v]scale=${logoW}:-1[logo];[0:v][logo]overlay=W-w-20:20[vout]" -map "[vout]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a copy "${withLogo}"`, { stdio: 'pipe' });
console.log(`  ✅ Logo added (${logoW}px wide, top-right)\n`);

// ─── STEP 7: Append end card video + end card audio ──────────────────────────
console.log('📌 STEP 7: Appending end card...\n');

// First, re-encode end card to match main video codec/resolution
const endCardReencoded = path.join(tempDir, 'end-card-reencoded.mp4');
execSync(`"${ffmpeg}" -y -i "${endCardVideo}" -i "${endCardAudio}" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 23 -vf "scale=${vidW}:${vidH}:force_original_aspect_ratio=decrease,pad=${vidW}:${vidH}:(ow-iw)/2:(oh-ih)/2" -c:a aac -b:a 128k -r 30 "${endCardReencoded}"`, { stdio: 'pipe' });

// Re-encode main to ensure matching parameters
const mainReencoded = path.join(tempDir, 'main-reencoded.mp4');
execSync(`"${ffmpeg}" -y -i "${withLogo}" -c:v libx264 -preset fast -crf 23 -r 30 -c:a aac -b:a 128k "${mainReencoded}"`, { stdio: 'pipe' });

const finalConcat = path.join(tempDir, 'final-concat.txt');
await fs.writeFile(finalConcat, `file '${mainReencoded}'\nfile '${endCardReencoded}'\n`);

const finalOutput = path.join(workDir, 'ep02-minmini-FINAL.mp4');
execSync(`"${ffmpeg}" -y -f concat -safe 0 -i "${finalConcat}" -c copy "${finalOutput}"`, { stdio: 'pipe' });

const finalDur = getDuration(finalOutput);
const finalSize = (await fs.stat(finalOutput)).size / (1024 * 1024);
console.log(`  ✅ End card appended`);
console.log(`  Final duration: ${finalDur.toFixed(2)}s`);
console.log(`  Final size: ${finalSize.toFixed(1)}MB\n`);

// ─── STEP 8: Sync validation ─────────────────────────────────────────────────
console.log('🔍 STEP 8: Sync validation...\n');

const finalVidDur = execSync(
  `"${ffprobe}" -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "${finalOutput}"`
).toString().trim();
const finalAudDur = execSync(
  `"${ffprobe}" -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 "${finalOutput}"`
).toString().trim();
const syncDiff = Math.abs(parseFloat(finalVidDur) - parseFloat(finalAudDur));
console.log(`  Video stream: ${parseFloat(finalVidDur).toFixed(2)}s`);
console.log(`  Audio stream: ${parseFloat(finalAudDur).toFixed(2)}s`);
console.log(`  Sync diff: ${syncDiff.toFixed(3)}s ${syncDiff < 0.5 ? '✅ OK' : '⚠️ DRIFT'}\n`);

// ─── DONE ─────────────────────────────────────────────────────────────────────
console.log('🎉 ASSEMBLY COMPLETE');
console.log(`   📁 ${finalOutput}`);
console.log(`   ⏱️  ${finalDur.toFixed(2)}s`);
console.log(`   📦 ${finalSize.toFixed(1)}MB`);
console.log(`   🔄 Sync: ${syncDiff.toFixed(3)}s drift\n`);
console.log('🚀 Ready for YouTube upload (unlisted)');
