#!/usr/bin/env node
// run-ep02-stage5-final.mjs — EP02 Minminni: Stage 5 → Stage 6 → Stage 7 → watermark
// Images already generated. Load from scene_assets table, animate with Wan 2.6, voice, assemble.
import 'dotenv/config';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSupabase } from './lib/supabase.mjs';
import { runStage5 } from './stages/stage-05-animate.mjs';
import { runStage6 } from './stages/stage-06-voice.mjs';
import { runStage7 } from './stages/stage-07-assemble.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASK_ID = '210cfd98-f7d1-4f06-ac1d-e0f2587441d4';
const FFMPEG   = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const FFPROBE  = FFMPEG.replace(/ffmpeg$/, 'ffprobe');
const OUTPUT_DIR = join(__dirname, 'output');
const LOGO_PATH  = join(__dirname, 'assets', 'channel-logo.png');

const tracker = {
  costs: {},
  addCost(stage, cost) {
    this.costs[stage] = (this.costs[stage] || 0) + cost;
  },
  total() {
    return Object.values(this.costs).reduce((a, b) => a + b, 0);
  },
};

console.log('🚀 EP02 Minminni — Stage 5 → Final');
console.log(`  Task ID: ${TASK_ID}`);

const sb = getSupabase();

// ── Load stage 2 state (scenes + script) ────────────────────────────────────
const { data: stage2, error: stage2Err } = await sb
  .from('video_pipeline_runs')
  .select('pipeline_state')
  .eq('task_id', TASK_ID)
  .eq('stage', 2)
  .single();

if (stage2Err || !stage2) {
  throw new Error(`Failed to load stage 2 state: ${stage2Err?.message || 'no data'}`);
}

const { script, scenes } = stage2.pipeline_state;
console.log(`  Loaded ${scenes?.length ?? 0} scenes from stage 2`);

// ── Load scene_assets (images already generated) ─────────────────────────────
const { data: assets, error: assetsErr } = await sb
  .from('scene_assets')
  .select('scene_number, image_url')
  .eq('video_id', TASK_ID)
  .eq('status', 'completed');

if (assetsErr) throw new Error(`Failed to load scene_assets: ${assetsErr.message}`);
console.log(`  Loaded ${assets?.length ?? 0} scene assets from DB`);

const sceneImagePaths = {};
for (const a of assets) {
  sceneImagePaths[a.scene_number] = { imagePath: null, storagePath: a.image_url };
}
console.log(`  Scene image paths: ${Object.keys(sceneImagePaths).join(', ')}`);

// ── Load characters ──────────────────────────────────────────────────────────
const { data: chars, error: charsErr } = await sb
  .from('character_library')
  .select('*')
  .eq('approved', true);

if (charsErr) throw new Error(`Failed to load characters: ${charsErr.message}`);

const characterMap = {};
for (const c of chars) {
  characterMap[c.name] = c;
}

// ── Normalize scenes: ensure scene.text exists (Stage 6 uses .text, DB has .dialogue) ──────
for (const s of scenes) {
  if (!s.text && s.dialogue) s.text = s.dialogue;
  if (!s.text) s.text = '';
}

// ── Build tmpDir ─────────────────────────────────────────────────────────────
const tmpDir = `/tmp/zolvra-pipeline/${TASK_ID}`;
await fs.mkdir(tmpDir, { recursive: true });
await fs.mkdir(join(tmpDir, 'scenes'), { recursive: true });
await fs.mkdir(join(tmpDir, 'audio'), { recursive: true });
await fs.mkdir(join(tmpDir, 'assembly'), { recursive: true });

let state = {
  script,
  scenes,
  videoType: 'short',
  characterMap,
  characterMapWithImages: characterMap,
  sceneImagePaths,
  parentCardId: '176',
  tmpDir,
};

// ── Stage 5: Animate ─────────────────────────────────────────────────────────
console.log('\n══════════════════════════════');
console.log('  STAGE 5 — Animate (Wan 2.6)');
console.log('══════════════════════════════');
state = await runStage5(TASK_ID, tracker, state);
console.log(`  ✅ Stage 5 done — ${Object.keys(state.sceneAnimPaths || {}).length} scenes animated`);
console.log(`  Stage costs so far: $${tracker.total().toFixed(4)}`);

// ── Stage 6: Voice ───────────────────────────────────────────────────────────
console.log('\n══════════════════════════════');
console.log('  STAGE 6 — Voice (TTS)');
console.log('══════════════════════════════');
state = await runStage6(TASK_ID, tracker, state);
console.log(`  ✅ Stage 6 done — ${Object.keys(state.sceneAudioPaths || {}).length} audio files`);
console.log(`  Stage costs so far: $${tracker.total().toFixed(4)}`);

// ── Stage 7: Assemble ────────────────────────────────────────────────────────
console.log('\n══════════════════════════════');
console.log('  STAGE 7 — Assemble');
console.log('══════════════════════════════');
state = await runStage7(TASK_ID, tracker, state);
const assembledPath = state.finalVideoPath;
console.log(`  ✅ Stage 7 done — ${assembledPath}`);
console.log(`  Stage costs so far: $${tracker.total().toFixed(4)}`);

if (!assembledPath) {
  throw new Error('Stage 7 returned no finalVideoPath — assembly failed');
}

// ── Post-process: Watermark (NO end card for Shorts) ─────────────────────────
console.log('\n══════════════════════════════');
console.log('  POST-PROCESS — Watermark');
console.log('══════════════════════════════');

await fs.mkdir(OUTPUT_DIR, { recursive: true });
const watermarkedPath = join(OUTPUT_DIR, 'ep02-minminni-watermarked.mp4');
const finalPath       = join(OUTPUT_DIR, 'ep02-minminni-final.mp4');

// Step 1: Clean re-encode (fix duration metadata)
console.log('🧹 Step 1: Clean re-encode...');
const cleanPath = join(OUTPUT_DIR, 'ep02-minminni-clean.mp4');

const vDurRaw = execSync(
  `"${FFPROBE}" -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "${assembledPath}"`
).toString().trim();
const aDurRaw = execSync(
  `"${FFPROBE}" -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 "${assembledPath}"`
).toString().trim();
const vDurSrc   = parseFloat(vDurRaw);
const aDurSrc   = parseFloat(aDurRaw);
const extraVideo = aDurSrc - vDurSrc;

const videoFilter = extraVideo > 0.1
  ? `-vf "tpad=stop_mode=clone:stop_duration=${extraVideo.toFixed(3)}"`
  : '';

execSync([
  `"${FFMPEG}" -y -loglevel warning`,
  `-i "${assembledPath}"`,
  videoFilter,
  `-c:v libx264 -preset fast -crf 18`,
  `-c:a aac -b:a 192k`,
  `"${cleanPath}"`,
].filter(Boolean).join(' '), { stdio: 'pipe' });

const cleanDur = execSync(
  `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${cleanPath}"`
).toString().trim();
console.log(`  ✓ Clean encode: ${parseFloat(cleanDur).toFixed(1)}s → ${cleanPath}`);

// Step 2: Add logo watermark (top-right, 80px, full opacity)
console.log('📍 Step 2: Adding logo watermark (top-right, 80px, full opacity)...');

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

// Rename watermarked as final (no end card for Shorts)
await fs.rename(watermarkedPath, finalPath);

const finalSize = (await fs.stat(finalPath)).size;
const finalDur  = execSync(
  `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${finalPath}"`
).toString().trim();

// Clean up intermediate files
await fs.unlink(cleanPath).catch(() => {});

// ── Summary ──────────────────────────────────────────────────────────────────
const totalCost = tracker.total();
console.log('\n══════════════════════════════════════════════════');
console.log(`🎉 EP02 complete — output/ep02-minminni-final.mp4 ready, total cost $${totalCost.toFixed(4)}`);
console.log(`   Output  : ${finalPath}`);
console.log(`   Duration: ${parseFloat(finalDur).toFixed(1)}s`);
console.log(`   Size    : ${(finalSize / 1024 / 1024).toFixed(1)} MB`);
console.log('   Costs by stage:', JSON.stringify(tracker.costs, null, 2));
console.log('══════════════════════════════════════════════════');
