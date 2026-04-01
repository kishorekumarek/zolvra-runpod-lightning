/**
 * run-ep02-redo-tts-assemble.mjs
 * Re-run Stage 6 (TTS) + Stage 7 (assembly) for EP02 Minminni
 * with corrected dialogues from DB. Animations already done in Supabase storage.
 */
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

const tracker = {
  costs: {},
  addCost(stage, cost) { this.costs[stage] = (this.costs[stage] || 0) + cost; }
};

console.log('🚀 EP02 Minminni — Re-running Stage 6 (TTS) + Stage 7 (assembly)');
console.log(`  Task ID: ${taskId}`);

const sb = getSupabase();

// ── 1. Load script + scenes from Stage 2 record ─────────────────────────────
console.log('\n📦 Loading stage 2 pipeline state...');
const { data: stage2, error: stage2Err } = await sb
  .from('video_pipeline_runs')
  .select('pipeline_state')
  .eq('task_id', taskId)
  .eq('stage', 2)
  .single();

if (stage2Err || !stage2) throw new Error(`Stage 2 load failed: ${stage2Err?.message || 'no data'}`);

const { script, scenes } = stage2.pipeline_state;
console.log(`  ✓ Loaded ${scenes?.length ?? 0} scenes from stage 2`);

// ── 2. Load animation paths from scene_assets ────────────────────────────────
console.log('\n📥 Loading & downloading animations from Supabase storage...');
const { data: assets, error: assetsErr } = await sb
  .from('scene_assets')
  .select('scene_number, image_url, animation_url')
  .eq('video_id', taskId)
  .order('scene_number');

if (assetsErr) throw new Error(`scene_assets load failed: ${assetsErr.message}`);

const animDir = join(tmpDir, 'animations');
await fs.mkdir(animDir, { recursive: true });

const sceneAnimPaths = {};

for (const asset of assets) {
  const sceneNum = asset.scene_number;
  const sceneLabel = String(sceneNum).padStart(2, '0');
  const localPath = join(animDir, `scene_${sceneLabel}_anim.mp4`);

  // Check if already downloaded
  let alreadyExists = false;
  try {
    await fs.access(localPath);
    alreadyExists = true;
  } catch {}

  if (alreadyExists) {
    console.log(`  ✓ Scene ${sceneNum}: already downloaded`);
  } else if (asset.animation_url) {
    console.log(`  ⬇️  Scene ${sceneNum}: downloading from storage...`);
    const buf = await downloadFromStorage({ bucket: 'scenes', path: asset.animation_url });
    await fs.writeFile(localPath, buf);
    console.log(`  ✓ Scene ${sceneNum}: saved to ${localPath}`);
  } else {
    console.warn(`  ⚠️  Scene ${sceneNum}: no animation_url — skipping`);
    continue;
  }

  sceneAnimPaths[sceneNum] = { animPath: localPath, storagePath: asset.animation_url };
}

console.log(`  ✓ ${Object.keys(sceneAnimPaths).length} animation paths ready`);

// ── 3. Delete old voice assets so Stage 6 regenerates ───────────────────────
console.log('\n🗑️  Clearing old voice_assets...');
const { error: delErr } = await sb.from('voice_assets').delete().eq('video_id', taskId);
if (delErr) console.warn(`  ⚠️  voice_assets delete warning: ${delErr.message}`);
else console.log('  ✓ Old voice assets cleared');

// ── 4. Build initial state ───────────────────────────────────────────────────
// Stage 6 reads scene.text but the DB stores it as scene.dialogue — normalise here
const normalisedScenes = scenes.map(s => ({
  ...s,
  text: s.text ?? s.dialogue ?? '',
}));

// ── Inject corrected v3 dialogue (audio tags + proper speakers) ──────────────
const correctedScript = {
  1: { text: '[excited] KAAViyaa! MeenU! Vaanga vaanga, [laughing] vilaiyaadalam vilaiyaadalam!', speaker: 'arjun', emotion: 'excited' },
  2: { text: '[surprised] Haiyyo! PAARU paaru! [amazed] Minmini poochi! Minmini POOCHI!', speaker: 'arjun', emotion: 'wonder' },
  3: { text: '[excited] OdUnga ODI Pidinga [laughing], [giggling]thappichida poguthu, seekram pidinga', speaker: 'kaviya', emotion: 'excited' },
  4: { text: '[excited] PUdinga PUdinga! BOTTLE-la podunga! [laughing] Paaru evvalavu iruku!', speaker: 'arjun', emotion: 'excited' },
  5: { text: '[sad] Arjun... paaru. [sighs] Bottle-la potathuku apram... minmini poochiyoda velicham konjam konjama koraiyithu...', speaker: 'kaviya', emotion: 'sad' },
  6: { text: '[thoughtful] Antha poochigalukku bottle-ulla adaipattu irukrathu pidikala... [hopeful] velila vitidalama?', speaker: 'kaviya', emotion: 'gentle' },
  7: { text: '[whispers] Ponga... ponga... [gentle] seekiram ponga.', speaker: 'kaviya', emotion: 'whisper' },
  8: { text: '[amazed] Paaru Kaaviya akka... ROMBA azhagaa irukku. [calmly] adachi vekkaama, freeya vidrathudhaan nallathu [applause]', speaker: 'meenu', emotion: 'awe' },
};
const patchedScenes = normalisedScenes.map(s => ({ ...s, ...(correctedScript[s.scene_number] || {}) }));

console.log('\n📝 Scene dialogue preview (corrected):');
patchedScenes.forEach(s => console.log(`  Scene ${s.scene_number} [${s.speaker}/${s.emotion}]: "${s.text.slice(0, 60)}"`));

let state = {
  script,
  scenes: patchedScenes,
  sceneAnimPaths,
  videoType: 'short',
  parentCardId: '176',
  tmpDir,
};

// ── 5. Stage 6: TTS ─────────────────────────────────────────────────────────
console.log('\n--- STAGE 6: TTS ---');
state = await runStage6(taskId, tracker, state);
console.log('✅ Stage 6 done');

// ── 6. Stage 7: Assembly ────────────────────────────────────────────────────
console.log('\n--- STAGE 7: ASSEMBLY ---');
state = await runStage7(taskId, tracker, state);
console.log('✅ Stage 7 done');

const assembledPath = state.finalVideoPath;
if (!assembledPath) {
  throw new Error('Stage 7 did not return a finalVideoPath');
}
console.log(`  Assembled: ${assembledPath}`);

// ── 7. Logo watermark ────────────────────────────────────────────────────────
console.log('\n🖼️  Applying logo watermark...');
const outputDir = '/Users/friday/.openclaw/workspace/streams/youtube/output';
await fs.mkdir(outputDir, { recursive: true });
const logoPath = '/Users/friday/.openclaw/workspace/streams/youtube/assets/channel-logo.png';
const finalOutput = join(outputDir, 'ep02-minminni-v3-final.mp4');

const ffmpegCmd = [
  `ffmpeg -y`,
  `-i "${assembledPath}"`,
  `-i "${logoPath}"`,
  `-filter_complex "[1:v]scale=-1:80[logo];[0:v][logo]overlay=W-w-20:20"`,
  `-c:a copy`,
  `"${finalOutput}"`,
].join(' ');

console.log(`  Running: ${ffmpegCmd}`);
execSync(ffmpegCmd, { stdio: 'inherit' });

console.log(`\n✅ TTS + assembly done — output/ep02-minminni-final.mp4 ready`);
console.log(`  Path: ${finalOutput}`);
console.log('\n💰 Costs:', tracker.costs);
const totalCost = Object.values(tracker.costs).reduce((a, b) => a + b, 0);
console.log(`  Total: $${totalCost.toFixed(4)}`);
