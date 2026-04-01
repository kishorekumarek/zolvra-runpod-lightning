#!/usr/bin/env node
// scripts/assemble-ep02-final.mjs — Assemble EP02 final video: animation + voices + BGM + logo + end card

import 'dotenv/config';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

const baseDir = '/Users/friday/.openclaw/workspace/streams/youtube';
const videoInput = path.join(baseDir, 'output/ep02-minminni-v3-final.mp4');
const voiceDir = path.join(baseDir, 'output/ep02-minmini-samples-v3');
const bgmFile = path.join(baseDir, 'assets/bgm/kids_folk_02.mp3');
const logoFile = path.join(baseDir, 'assets/channel-logo.png');
const endCardVideo = path.join(baseDir, 'assets/shorts_end_card.mp4');
const endCardAudio = path.join(baseDir, 'assets/end_card_audio.mp3');
const ffmpegPath = '/opt/homebrew/bin/ffmpeg';
const ffprobePath = '/opt/homebrew/bin/ffprobe';

const outputDir = path.join(baseDir, 'output/ep02-assembly');
const tempDir = path.join(outputDir, 'temp');
const finalOutput = path.join(outputDir, 'ep02-minmini-assembled-final.mp4');

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(tempDir, { recursive: true });

console.log('🎬 EP02 Final Assembly\n');

// Step 1: Get video duration
console.log('📏 Checking video duration...');
const probeOutput = JSON.parse(
  execSync(`"${ffprobePath}" -v error -show_entries format=duration -of json "${videoInput}"`).toString()
);
const videoDuration = parseFloat(probeOutput.format.duration);
console.log(`   Video duration: ${videoDuration.toFixed(2)}s\n`);

// Step 2: Concatenate all voice samples
console.log('🎙️  Concatenating voice samples...');
const voiceFiles = [1, 2, 3, 4, 5, 6, 7, 8].map(i => 
  path.join(voiceDir, `ep02-s${String(i).padStart(2, '0')}-*.mp3`)
);

const voiceConcat = path.join(tempDir, 'voices-concat.txt');
let concatList = '';
for (let i = 1; i <= 8; i++) {
  const files = execSync(`ls ${path.join(voiceDir, `ep02-s${String(i).padStart(2, '0')}-*.mp3`)} 2>/dev/null | head -1`).toString().trim();
  if (files) {
    concatList += `file '${files}'\n`;
  }
}
await fs.writeFile(voiceConcat, concatList);

const voiceOutput = path.join(tempDir, 'voices-combined.mp3');
execSync(`"${ffmpegPath}" -f concat -safe 0 -i "${voiceConcat}" -c copy "${voiceOutput}" -y`, { stdio: 'pipe' });
console.log('   ✅ Voices concatenated\n');

// Step 3: Get voice duration
const voiceDuration = JSON.parse(
  execSync(`"${ffprobePath}" -v error -show_entries format=duration -of json "${voiceOutput}"`).toString()
).format.duration;
console.log(`   Voice duration: ${voiceDuration.toFixed(2)}s`);
console.log(`   Video duration: ${videoDuration.toFixed(2)}s\n`);

// Step 4: Mix audio (voice + BGM)
console.log('🎵 Mixing voice + BGM...');
const mixedAudio = path.join(tempDir, 'audio-mixed.mp3');
// Voice at -12dB, BGM at -20dB to keep voice clear
execSync(`"${ffmpegPath}" -i "${voiceOutput}" -i "${bgmFile}" -filter_complex "[0]volume=0.8[v];[1]volume=0.3[bgm];[v][bgm]amix=inputs=2:duration=first[out]" -map "[out]" "${mixedAudio}" -y`, { stdio: 'pipe' });
console.log('   ✅ Audio mixed (voice + BGM)\n');

// Step 5: Add logo overlay + audio
console.log('📽️  Adding logo overlay + mixed audio...');
const withLogoOutput = path.join(tempDir, 'with-logo.mp4');
const logoScale = 'w=200:h=200'; // 200x200px logo
execSync(`"${ffmpegPath}" \
  -i "${videoInput}" \
  -i "${mixedAudio}" \
  -i "${logoFile}" \
  -filter_complex "[0][2]overlay=W-w-20:20[v];[v]scale=1080:1920[out]" \
  -map "[out]" \
  -map "1:a" \
  -c:v libx264 -preset fast -crf 23 \
  -c:a aac -b:a 128k \
  -shortest \
  "${withLogoOutput}" -y`, { stdio: 'pipe' });
console.log('   ✅ Logo added + audio synced\n');

// Step 6: Concat end card
console.log('📌 Appending end card...');
const concatList2 = path.join(tempDir, 'concat-endcard.txt');
await fs.writeFile(concatList2, `file '${withLogoOutput}'\nfile '${endCardVideo}'\n`);

const preFinal = path.join(tempDir, 'with-endcard.mp4');
execSync(`"${ffmpegPath}" -f concat -safe 0 -i "${concatList2}" -c copy "${preFinal}" -y`, { stdio: 'pipe' });
console.log('   ✅ End card appended\n');

// Step 7: Add end card audio
console.log('🔊 Adding end card audio...');
execSync(`"${ffmpegPath}" \
  -i "${preFinal}" \
  -i "${endCardAudio}" \
  -c:v copy \
  -c:a aac -b:a 128k \
  -map 0:v:0 -map '[a]' \
  -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[a]" \
  "${finalOutput}" -y`, { stdio: 'pipe' });
console.log('   ✅ End card audio added\n');

// Step 8: Verify output
const finalDuration = JSON.parse(
  execSync(`"${ffprobePath}" -v error -show_entries format=duration -of json "${finalOutput}"`).toString()
).format.duration;
const finalSize = (await fs.stat(finalOutput)).size / (1024 * 1024);

console.log('✅ ASSEMBLY COMPLETE');
console.log(`   File: ep02-minmini-assembled-final.mp4`);
console.log(`   Duration: ${finalDuration.toFixed(2)}s`);
console.log(`   Size: ${finalSize.toFixed(1)}MB\n`);

console.log(`📁 Output: ${finalOutput}\n`);

// Cleanup temp
console.log('🧹 Cleaning up temp files...');
await execSync(`rm -rf "${tempDir}"`);
console.log('   ✅ Done\n');

console.log('🚀 Ready for YouTube upload (unlisted)');
console.log(`   Telegram: Will send link to 7879469053`);
