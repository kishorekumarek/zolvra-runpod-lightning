#!/usr/bin/env node
// scripts/post-process-ep01.mjs — Clean encode → watermark → concat end card → ep01-final.mp4
// Usage: node scripts/post-process-ep01.mjs
import 'dotenv/config';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSupabase } from '../lib/supabase.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASK_ID = 'eb42af4b-f4ce-4e0f-b2f7-1f3e452030f8';
const FFMPEG = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');
const OUTPUT_DIR = join(__dirname, '..', 'output');
const LOGO_PATH = join(__dirname, '..', 'assets', 'channel-logo.png');

/**
 * Locate the assembled video from stage 7.
 * Checks Supabase state first, then falls back to well-known tmp path.
 */
async function findAssembledVideo() {
  const sb = getSupabase();
  const { data: row } = await sb
    .from('video_pipeline_runs')
    .select('pipeline_state')
    .eq('task_id', TASK_ID)
    .eq('stage', 7)
    .single();

  if (row?.pipeline_state?.finalVideoPath) {
    try {
      await fs.access(row.pipeline_state.finalVideoPath);
      console.log(`  Stage 7 state path: ${row.pipeline_state.finalVideoPath}`);
      return row.pipeline_state.finalVideoPath;
    } catch {
      console.warn('  Stage 7 path not accessible, falling back...');
    }
  }

  // Fallback: well-known tmp location
  const tmpFinal = `/tmp/zolvra-pipeline/${TASK_ID}/assembly/final.mp4`;
  try {
    await fs.access(tmpFinal);
    console.log(`  Found tmp final: ${tmpFinal}`);
    return tmpFinal;
  } catch { /* not found */ }

  // Last resort: ep01 or latest mp4 in output/
  const files = await fs.readdir(OUTPUT_DIR).catch(() => []);
  const ep01s = files.filter(f =>
    f.endsWith('.mp4') && f.includes('ep01') &&
    !f.includes('final') && !f.includes('watermark') && !f.includes('endcard') && !f.includes('clean')
  );
  if (ep01s.length > 0) {
    const chosen = join(OUTPUT_DIR, ep01s[0]);
    console.log(`  Found in output/: ${chosen}`);
    return chosen;
  }

  throw new Error(
    'Could not locate assembled video from stage 7.\n' +
    'Run scripts/rerun-stage7.mjs first to generate the assembled video.'
  );
}

async function main() {
  console.log('\n🎬 EP01 Post-Processing');
  console.log(`   FFMPEG: ${FFMPEG}\n`);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const sourceVideo = await findAssembledVideo();
  console.log(`✓ Source video: ${sourceVideo}`);

  const cleanPath       = join(OUTPUT_DIR, 'ep01-clean.mp4');
  const watermarkedPath = join(OUTPUT_DIR, 'ep01-watermarked.mp4');
  const endcardPath     = join(OUTPUT_DIR, 'end-card-ready.mp4');
  const finalPath       = join(OUTPUT_DIR, 'ep01-final.mp4');

  // Verify end-card-ready.mp4 exists
  try {
    await fs.access(endcardPath);
  } catch {
    throw new Error(`end-card-ready.mp4 not found at ${endcardPath}. Run Fix 2 first:\n  ffmpeg -y -i assets/end-card.mp4 -vf scale=1280:720 -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k -r 30 output/end-card-ready.mp4`);
  }

  // ── Step 1: Clean re-encode (fixes duration metadata, pads video to match audio) ──
  console.log('\n🧹 Step 1: Clean re-encode (fix duration metadata)...');

  // Detect video/audio duration mismatch (xfade shortens video but not audio)
  const vDurRaw = execSync(
    `"${FFPROBE}" -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "${sourceVideo}"`
  ).toString().trim();
  const aDurRaw = execSync(
    `"${FFPROBE}" -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 "${sourceVideo}"`
  ).toString().trim();
  const vDurSrc = parseFloat(vDurRaw);
  const aDurSrc = parseFloat(aDurRaw);
  const extraVideo = aDurSrc - vDurSrc;

  if (extraVideo > 0.1) {
    console.log(`  Video/audio mismatch: video=${vDurSrc.toFixed(1)}s, audio=${aDurSrc.toFixed(1)}s`);
    console.log(`  Padding video by ${extraVideo.toFixed(2)}s (clone last frame) to match audio`);
  }

  // tpad extends video with cloned last frame when video is shorter than audio
  const videoFilter = extraVideo > 0.1
    ? `-vf "tpad=stop_mode=clone:stop_duration=${extraVideo.toFixed(3)}"`
    : '';

  execSync([
    `"${FFMPEG}" -y -loglevel warning`,
    `-i "${sourceVideo}"`,
    videoFilter,
    `-c:v libx264 -preset fast -crf 18`,
    `-c:a aac -b:a 192k`,
    `"${cleanPath}"`,
  ].filter(Boolean).join(' '), { stdio: 'pipe' });

  const cleanDur = execSync(
    `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${cleanPath}"`
  ).toString().trim();
  const cleanVDur = execSync(
    `"${FFPROBE}" -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "${cleanPath}"`
  ).toString().trim();
  const cleanADur = execSync(
    `"${FFPROBE}" -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 "${cleanPath}"`
  ).toString().trim();
  console.log(`✓ Clean encode: ${cleanPath} (${parseFloat(cleanDur).toFixed(1)}s | video=${parseFloat(cleanVDur).toFixed(1)}s audio=${parseFloat(cleanADur).toFixed(1)}s)`);

  // ── Step 2: Watermark ────────────────────────────────────────────────────
  console.log('\n📍 Step 2: Adding logo watermark (top-right, 80px, full opacity)...');

  execSync([
    `"${FFMPEG}" -y -loglevel warning`,
    `-i "${cleanPath}"`,
    `-i "${LOGO_PATH}"`,
    `-filter_complex "[1:v]scale=-1:80[logo];[0:v][logo]overlay=W-w-20:20[out]"`,
    `-map "[out]" -map 0:a`,
    `-c:v libx264 -preset fast -crf 18`,
    `-c:a aac -b:a 192k`,
    `"${watermarkedPath}"`,
  ].join(' '), { stdio: 'pipe' });

  const wSize = (await fs.stat(watermarkedPath)).size;
  console.log(`✓ Watermarked: ${watermarkedPath} (${(wSize / 1024 / 1024).toFixed(1)} MB)`);

  // ── Step 3: Concat watermarked + end card (full re-encode) ───────────────
  // Use filter_complex concat (not the concat demuxer) to normalize fps/time_base
  // across the 24fps main video and 30fps end card — avoids PTS offset corruption.
  console.log('\n🔗 Step 3: Concatenating watermarked video + end card (filter_complex concat)...');

  execSync([
    `"${FFMPEG}" -y -loglevel warning`,
    `-i "${watermarkedPath}"`,
    `-i "${endcardPath}"`,
    `-filter_complex "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]"`,
    `-map "[v]" -map "[a]"`,
    `-c:v libx264 -preset fast -crf 18`,
    `-c:a aac -b:a 192k`,
    `"${finalPath}"`,
  ].join(' '), { stdio: 'pipe' });

  // ── Step 4: Verify ───────────────────────────────────────────────────────
  const finalSize = (await fs.stat(finalPath)).size;
  const durationOut = execSync(
    `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${finalPath}"`
  ).toString().trim();
  const totalDuration = parseFloat(durationOut);

  console.log(`\n✅ Post-processing complete!`);
  console.log(`   Output   : ${finalPath}`);
  console.log(`   Duration : ${totalDuration.toFixed(1)}s`);
  console.log(`   Size     : ${(finalSize / 1024 / 1024).toFixed(1)} MB`);

  if (totalDuration > 300) {
    console.error(`\n⚠️  WARNING: Duration ${totalDuration.toFixed(1)}s > 300s — something may be wrong!`);
    console.error(`   Expected ~267s. Investigate source video and end card durations.`);
    const endcardDur = execSync(
      `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${endcardPath}"`
    ).toString().trim();
    const wDur = execSync(
      `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${watermarkedPath}"`
    ).toString().trim();
    console.error(`   watermarked: ${parseFloat(wDur).toFixed(1)}s`);
    console.error(`   end-card:    ${parseFloat(endcardDur).toFixed(1)}s`);
  }
}

main().catch(e => {
  console.error('\n💥 Post-processing failed:', e.message);
  console.error(e.stack);
  process.exit(1);
});
