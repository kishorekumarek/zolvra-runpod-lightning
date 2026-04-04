// scripts/prepend-title-card.mjs — Prepend JJ intro + title card to an existing final.mp4
//
// Usage:
//   node scripts/prepend-title-card.mjs <task_id> <ep_number> <ep_title>
//
// What it does:
//   1. Reads final.mp4 from output/<task_id>/final.mp4
//   2. Re-encodes intro.mp4 to match final.mp4 dimensions/fps
//   3. Applies EP number + title text overlay (Noto Sans Tamil)
//   4. Creates a 3s title card still from first frame of intro
//   5. Concat filter: [intro-final + title-card] → prepend.mp4
//   6. Concat filter: [prepend.mp4 + final.mp4] → final_with_titlecard.mp4
//   No Supabase. No YouTube. File operation only.

import 'dotenv/config';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FFMPEG, FFPROBE, getDurationSeconds } from '../lib/ffmpeg.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, '..');
const OUTPUT_DIR = join(ROOT, 'output');
const ASSETS_DIR = join(ROOT, 'assets');

const JJ_INTRO_PATH = join(ASSETS_DIR, 'series', 'jungle-jambu', 'intro.mp4');

const NOTO_TAMIL_FONT_PATHS = [
  '/Library/Fonts/NotoSansTamil-Regular.ttf',
  '/Library/Fonts/NotoSansTamil.ttf',
  '/System/Library/Fonts/Supplemental/NotoSansTamil-Regular.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansTamil-Regular.ttf',
  '/usr/share/fonts/noto/NotoSansTamil-Regular.ttf',
];

function findNotoTamilFont() {
  for (const p of NOTO_TAMIL_FONT_PATHS) {
    try {
      execSync(`test -f "${p}"`, { stdio: 'pipe' });
      return p;
    } catch { /* not found */ }
  }
  return null;
}

async function main() {
  const [,, taskId, epNumberStr, ...titleParts] = process.argv;
  if (!taskId || !epNumberStr || titleParts.length === 0) {
    console.error('Usage: node scripts/prepend-title-card.mjs <task_id> <ep_number> <ep_title>');
    process.exit(1);
  }
  const epNumber    = parseInt(epNumberStr, 10);
  const epTitle     = titleParts.join(' ');

  const finalPath   = join(OUTPUT_DIR, taskId, 'final.mp4');
  const outputPath  = join(OUTPUT_DIR, taskId, 'final_with_titlecard.mp4');
  const assemblyDir = join(OUTPUT_DIR, taskId, 'titlecard-assembly');

  // Verify final.mp4 exists
  try {
    await fs.access(finalPath);
  } catch {
    console.error(`❌ final.mp4 not found at ${finalPath}`);
    process.exit(1);
  }

  await fs.mkdir(assemblyDir, { recursive: true });
  console.log(`🎬 Prepending title card to EP${epNumber}: ${epTitle}`);
  console.log(`   task: ${taskId}`);

  // ── Step 1: Get final.mp4 dimensions + fps ──────────────────────────────────
  const dimsRaw = execSync(
    `"${FFPROBE}" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${finalPath}"`
  ).toString().trim().split(',');
  const [mW, mH] = dimsRaw.map(Number);

  const fpsRaw = execSync(
    `"${FFPROBE}" -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "${finalPath}"`
  ).toString().trim();
  const [fpsNum, fpsDen] = fpsRaw.split('/').map(Number);
  const fps = Math.round(fpsNum / (fpsDen || 1));
  console.log(`  📐 final.mp4: ${mW}×${mH} @ ${fps}fps`);

  // ── Step 2: Re-encode intro to match final.mp4 ──────────────────────────────
  const introReencoded = join(assemblyDir, 'intro-reencoded.mp4');
  execSync([
    `"${FFMPEG}" -y`,
    `-i "${JJ_INTRO_PATH}"`,
    `-c:v libx264 -preset fast -crf 23`,
    `-vf "scale=${mW}:${mH}:force_original_aspect_ratio=decrease,pad=${mW}:${mH}:(ow-iw)/2:(oh-ih)/2"`,
    `-r ${fps}`,
    `-c:a aac -b:a 192k`,
    `"${introReencoded}"`,
  ].join(' '), { stdio: 'pipe' });
  console.log('  ✓ Intro re-encoded');

  // ── Step 3: Apply text overlay → intro-final.mp4 ────────────────────────────
  const introFinal  = join(assemblyDir, 'intro-final.mp4');
  const fontPath    = findNotoTamilFont();
  const textFile    = join(assemblyDir, 'intro-text.txt');

  if (fontPath) {
    await fs.writeFile(textFile, `EP${epNumber}\n${epTitle}`, 'utf8');
    const drawFilter = [
      `drawtext=fontfile='${fontPath}'`,
      `textfile='${textFile}'`,
      `x=(w-text_w)/2`,
      `y=(h*0.65)`,
      `fontsize=52`,
      `fontcolor=white`,
      `line_spacing=10`,
      `box=1`,
      `boxcolor=black@0.5`,
      `boxborderw=12`,
    ].join(':');
    execSync([
      `"${FFMPEG}" -y`,
      `-i "${introReencoded}"`,
      `-vf "${drawFilter}"`,
      `-c:v libx264 -preset fast -crf 23`,
      `-c:a copy`,
      `"${introFinal}"`,
    ].join(' '), { stdio: 'pipe' });
    await fs.unlink(introReencoded).catch(() => {});
    console.log(`  ✓ Text overlay applied (EP${epNumber} + title)`);
  } else {
    console.warn('  ⚠️  Noto Sans Tamil font not found — text overlay skipped');
    await fs.rename(introReencoded, introFinal);
  }

  // ── Step 4: Extract first frame of intro-final → title card still ───────────
  const titleFrame = join(assemblyDir, 'title-frame.png');
  execSync([
    `"${FFMPEG}" -y`,
    `-ss 0 -i "${introFinal}"`,
    `-frames:v 1`,
    `"${titleFrame}"`,
  ].join(' '), { stdio: 'pipe' });

  const titleCard = join(assemblyDir, 'title-card.mp4');
  execSync([
    `"${FFMPEG}" -y`,
    `-loop 1 -i "${titleFrame}"`,
    `-f lavfi -i anullsrc=r=44100:cl=stereo`,
    `-t 3`,
    `-c:v libx264 -preset fast -crf 23`,
    `-vf "scale=${mW}:${mH}"`,
    `-r ${fps}`,
    `-c:a aac -b:a 192k`,
    `-shortest`,
    `"${titleCard}"`,
  ].join(' '), { stdio: 'pipe' });
  console.log('  ✓ Title card (3s still) created');

  // ── Step 5: Concat intro-final + title-card → prepend.mp4 ───────────────────
  const prependPath = join(assemblyDir, 'prepend.mp4');
  execSync([
    `"${FFMPEG}" -y`,
    `-i "${introFinal}"`,
    `-i "${titleCard}"`,
    `-filter_complex "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[vout][aout]"`,
    `-map "[vout]" -map "[aout]"`,
    `-c:v libx264 -preset fast -crf 23`,
    `-c:a aac -b:a 192k`,
    `"${prependPath}"`,
  ].join(' '), { stdio: 'pipe' });
  console.log('  ✓ prepend.mp4 built (intro + title card)');

  // ── Step 6: Concat prepend.mp4 + final.mp4 → final_with_titlecard.mp4 ───────
  execSync([
    `"${FFMPEG}" -y`,
    `-i "${prependPath}"`,
    `-i "${finalPath}"`,
    `-filter_complex "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[vout][aout]"`,
    `-map "[vout]" -map "[aout]"`,
    `-c:v libx264 -preset fast -crf 23`,
    `-c:a aac -b:a 192k`,
    `"${outputPath}"`,
  ].join(' '), { stdio: 'pipe' });

  const duration = getDurationSeconds(outputPath);
  console.log(`\n✅ Done! ${outputPath}`);
  console.log(`   Duration: ${duration.toFixed(1)}s`);
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
