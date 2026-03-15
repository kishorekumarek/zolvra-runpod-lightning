// run-ep02-stage6-7.mjs
// Re-runs Stage 6 (TTS) + Stage 7 (assembly) for EP02 Minminni with corrected dialogues.
// Animations already exist in Supabase storage — downloads them locally first.
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getSupabase } from './lib/supabase.mjs';
import { downloadFromStorage, BUCKETS } from './lib/storage.mjs';
import { runStage6 } from './stages/stage-06-voice.mjs';
import { runStage7 } from './stages/stage-07-assemble.mjs';

const taskId = '210cfd98-f7d1-4f06-ac1d-e0f2587441d4';
const tmpDir = `/tmp/${taskId}`;
const FINAL_OUTPUT = '/Users/friday/.openclaw/workspace/streams/youtube/output/ep02-minminni-final.mp4';
const LOGO_PATH   = '/Users/friday/.openclaw/workspace/streams/youtube/assets/channel-logo.png';

const tracker = {
  costs: {},
  addCost(stage, cost) { this.costs[stage] = (this.costs[stage] || 0) + cost; }
};

const sb = getSupabase();

// ── 1. Load scene script from Stage 2 DB record ──────────────────────────────
console.log('📦 Loading stage 2 state from DB...');
const { data: stage2, error: s2err } = await sb
  .from('video_pipeline_runs')
  .select('pipeline_state')
  .eq('task_id', taskId)
  .eq('stage', 2)
  .single();

if (s2err || !stage2) throw new Error(`Failed to load stage 2 state: ${s2err?.message}`);

const { script, scenes } = stage2.pipeline_state;
console.log(`  ✓ Loaded ${scenes.length} scenes`);

// ── 2. Load animation paths from scene_assets ─────────────────────────────────
console.log('📂 Loading animation asset paths from DB...');
const { data: assets, error: aErr } = await sb
  .from('scene_assets')
  .select('scene_number, image_url, animation_url')
  .eq('video_id', taskId)
  .order('scene_number');

if (aErr) throw new Error(`Failed to load scene_assets: ${aErr.message}`);
console.log(`  ✓ Found ${assets.length} scene assets in DB`);

// ── 3. Ensure tmpDir structure exists ─────────────────────────────────────────
await fs.mkdir(join(tmpDir, 'scenes'), { recursive: true });
await fs.mkdir(join(tmpDir, 'audio'),  { recursive: true });
await fs.mkdir(join(tmpDir, 'assembly'), { recursive: true });
console.log(`  ✓ tmpDir ready: ${tmpDir}`);

// ── 4. Download animation clips locally ───────────────────────────────────────
console.log('⬇️  Downloading animation clips from storage...');
const sceneAnimPaths = {};

for (const asset of assets) {
  const sceneNum = asset.scene_number;
  const sceneLabel = String(sceneNum).padStart(2, '0');
  const localPath = join(tmpDir, 'scenes', `scene_${sceneLabel}_anim.mp4`);

  // Check if already downloaded
  try {
    await fs.access(localPath);
    console.log(`  ↩️  Scene ${sceneNum}: already local — skipping download`);
  } catch {
    if (!asset.animation_url) {
      console.warn(`  ⚠️  Scene ${sceneNum}: no animation_url in DB — skipping`);
      continue;
    }
    console.log(`  ⬇️  Scene ${sceneNum}: downloading ${asset.animation_url}...`);
    const buffer = await downloadFromStorage({ bucket: BUCKETS.scenes, path: asset.animation_url });
    await fs.writeFile(localPath, buffer);
    console.log(`  ✓ Scene ${sceneNum} saved to ${localPath}`);
  }

  sceneAnimPaths[sceneNum] = {
    animPath: localPath,
    storagePath: asset.animation_url,
  };
}

console.log(`  ✓ ${Object.keys(sceneAnimPaths).length} animation clips ready`);

// ── 5. Clear old voice assets so Stage 6 regenerates from scratch ─────────────
console.log('🗑️  Clearing old voice_assets from DB...');
const { error: delErr } = await sb.from('voice_assets').delete().eq('video_id', taskId);
if (delErr) console.warn(`  ⚠️  voice_assets delete warning: ${delErr.message}`);
else console.log('  ✓ Old voice assets cleared');

// ── 6. Build initial state ────────────────────────────────────────────────────
// Stage 6 expects scene.text — Stage 2 stores as scene.dialogue. Normalise.
const normalisedScenes = scenes.map(s => ({
  ...s,
  text: s.text ?? s.dialogue ?? '',
}));

let state = {
  script,
  scenes: normalisedScenes,
  sceneAnimPaths,
  videoType: 'short',
  tmpDir,
  parentCardId: '176',
};

// ── 7. Stage 6 — TTS ─────────────────────────────────────────────────────────
console.log('\n--- STAGE 6: TTS ---');
state = await runStage6(taskId, tracker, state);
console.log('✅ Stage 6 done');

// ── 8. Stage 7 — Assembly ─────────────────────────────────────────────────────
console.log('\n--- STAGE 7: ASSEMBLY ---');
state = await runStage7(taskId, tracker, state);
console.log('✅ Stage 7 done');

const assembledPath = state.finalVideoPath;
if (!assembledPath) throw new Error('Stage 7 returned no finalVideoPath');
console.log(`  Assembled: ${assembledPath}`);

// ── 9. Apply logo watermark (top-right, 80px height, full opacity) ─────────────
console.log('\n--- WATERMARK ---');
console.log(`  Applying logo watermark → ${FINAL_OUTPUT}`);

const watermarkCmd = [
  `ffmpeg -y`,
  `-i "${assembledPath}"`,
  `-i "${LOGO_PATH}"`,
  `-filter_complex "[1:v]scale=-1:80[logo];[0:v][logo]overlay=W-w-20:20"`,
  `-c:a copy`,
  `"${FINAL_OUTPUT}"`,
].join(' ');

execSync(watermarkCmd, { stdio: 'inherit' });
console.log(`✅ Watermark applied`);

// ── 10. Report ────────────────────────────────────────────────────────────────
const totalCost = Object.values(tracker.costs).reduce((a, b) => a + b, 0);
console.log('\n🎉 TTS + assembly done — output/ep02-minminni-final.mp4 ready');
console.log(`   Costs: ${JSON.stringify(tracker.costs)}`);
console.log(`   Total: $${totalCost.toFixed(4)}`);
console.log(`   Output: ${FINAL_OUTPUT}`);
