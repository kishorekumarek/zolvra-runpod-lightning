#!/usr/bin/env node
// scripts/post-process-ep01.mjs — Watermark + animated end card → ep01-final.mp4
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
  const ep01s = files.filter(f => f.endsWith('.mp4') && f.includes('ep01') && !f.includes('final') && !f.includes('watermark') && !f.includes('endcard'));
  if (ep01s.length > 0) {
    const chosen = join(OUTPUT_DIR, ep01s[0]);
    console.log(`  Found in output/: ${chosen}`);
    return chosen;
  }

  throw new Error(
    'Could not locate assembled video from stage 7.\n' +
    'Run scripts/rebuild-ep01.mjs first to generate the assembled video.'
  );
}

async function main() {
  console.log('\n🎬 EP01 Post-Processing');
  console.log(`   FFMPEG: ${FFMPEG}\n`);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const sourceVideo = await findAssembledVideo();
  console.log(`✓ Source video: ${sourceVideo}`);

  const watermarkedPath = join(OUTPUT_DIR, 'ep01-watermarked.mp4');
  const endcardLogoPath = join(OUTPUT_DIR, '_ep01-endcard-logo.png');
  const endcardPath     = join(OUTPUT_DIR, 'ep01-endcard.mp4');
  const concatListPath  = join(OUTPUT_DIR, '_ep01-concat.txt');
  const finalPath       = join(OUTPUT_DIR, 'ep01-final.mp4');

  // ── Step 1: Watermark ────────────────────────────────────────────────────
  console.log('\n📍 Step 1: Adding logo watermark (top-right, 80px, 50% opacity)...');

  // Per spec: [1:v]scale=-1:80,format=rgba,colorchannelmixer=aa=0.5[logo];[0:v][logo]overlay=W-w-20:20[out]
  const watermarkCmd = [
    `"${FFMPEG}" -y -loglevel warning`,
    `-i "${sourceVideo}"`,
    `-i "${LOGO_PATH}"`,
    `-filter_complex "[1:v]scale=-1:80,format=rgba,colorchannelmixer=aa=0.5[logo];[0:v][logo]overlay=W-w-20:20[out]"`,
    `-map "[out]" -map 0:a`,
    `-c:v libx264 -preset fast -crf 22`,
    `-c:a copy`,
    `"${watermarkedPath}"`,
  ].join(' ');

  execSync(watermarkCmd, { stdio: 'pipe' });
  const wSize = (await fs.stat(watermarkedPath)).size;
  console.log(`✓ Watermarked: ${watermarkedPath} (${(wSize / 1024 / 1024).toFixed(1)} MB)`);

  // ── Step 2: Animated end card ────────────────────────────────────────────
  console.log('\n🎞️  Step 2: Generating 7-second animated end card...');

  // Pre-scale logo for end card: we want ~120px height at full size
  execSync(
    `"${FFMPEG}" -y -loglevel warning -i "${LOGO_PATH}" -vf "scale=-1:120" "${endcardLogoPath}"`,
    { stdio: 'pipe' }
  );

  // Build filter_complex:
  //   [1:v] = logo stream (looped still, timestamps 0-7)
  //   scale: zoom from 0→full over 1.5s using if(lt(t,1.5),... ) expression
  //   overlay: centered, logo sits slightly above vertical center
  //   drawtext: "Subscribe!" below logo, fontsize pulses with sin(t)
  // Input 2: silent audio track
  const fc = [
    `[1:v]scale=w='if(lt(t\\,1.5)\\,iw*t/1.5\\,iw)':h='if(lt(t\\,1.5)\\,ih*t/1.5\\,ih)'[logo_anim]`,
    `[0:v][logo_anim]overlay=x='(W-w)/2':y='H/2-100':shortest=1[v1]`,
    `[v1]drawtext=text='Subscribe to Tiny Tamil Tales\\!':fontcolor=white:fontsize='40+5*sin(t*6.28)':x='(w-text_w)/2':y='H/2+80'[out]`,
  ].join(';');

  const endcardCmd = [
    `"${FFMPEG}" -y -loglevel warning`,
    `-t 7 -f lavfi -i "color=c=0x1a7a7a:s=1280x720:r=30"`,
    `-loop 1 -t 7 -i "${endcardLogoPath}"`,
    `-t 7 -f lavfi -i "anullsrc=r=44100:cl=stereo"`,
    `-filter_complex "${fc}"`,
    `-map "[out]" -map 2:a`,
    `-t 7 -c:v libx264 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k`,
    `"${endcardPath}"`,
  ].join(' ');

  execSync(endcardCmd, { stdio: 'pipe' });
  console.log(`✓ End card: ${endcardPath}`);

  // ── Step 3: Concat watermarked + end card ────────────────────────────────
  console.log('\n🔗 Step 3: Concatenating watermarked video + end card...');

  await fs.writeFile(concatListPath, [
    `file '${watermarkedPath}'`,
    `file '${endcardPath}'`,
  ].join('\n') + '\n');

  const concatCmd = [
    `"${FFMPEG}" -y -loglevel warning`,
    `-f concat -safe 0 -i "${concatListPath}"`,
    `-c:v libx264 -preset fast -crf 22`,
    `-c:a aac -b:a 192k`,
    `"${finalPath}"`,
  ].join(' ');

  execSync(concatCmd, { stdio: 'pipe' });

  // Cleanup temp files
  await fs.unlink(endcardLogoPath).catch(() => {});
  await fs.unlink(concatListPath).catch(() => {});

  const finalSize = (await fs.stat(finalPath)).size;
  const durationOut = execSync(
    `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${finalPath}"`
  ).toString().trim();

  console.log(`\n✅ Post-processing complete!`);
  console.log(`   Output   : ${finalPath}`);
  console.log(`   Duration : ${parseFloat(durationOut).toFixed(1)}s`);
  console.log(`   Size     : ${(finalSize / 1024 / 1024).toFixed(1)} MB`);
}

main().catch(e => {
  console.error('\n💥 Post-processing failed:', e.message);
  console.error(e.stack);
  process.exit(1);
});
