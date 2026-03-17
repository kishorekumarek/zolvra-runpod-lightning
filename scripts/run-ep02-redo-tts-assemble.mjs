#!/usr/bin/env node
// run-ep02-redo-tts-assemble.mjs — Re-run TTS (stage 6) + assembly (stage 7) for EP02 Minminni
// Uses existing animation assets from prior pipeline run 210cfd98
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { setSetting } from '../lib/settings.mjs';
import { CostTracker } from '../lib/cost-tracker.mjs';
import { runStage6 } from '../stages/stage-06-voice.mjs';
import { runStage7 } from '../stages/stage-07-assemble.mjs';

const TASK_ID = '210cfd98-f7d1-4f06-ac1d-e0f2587441d4';
const TMP_DIR = `/tmp/zolvra-pipeline/${TASK_ID}`;
const OUTPUT_PATH = 'output/ep02-minminni-v2-final.mp4';

const sb = getSupabase();

// ─── Set video_type + disable feedback collection for this redo ──────────────
await setSetting('video_type', 'short');
await setSetting('feedback_collection_mode', false);

// ─── Build corrected scenes with `text` field for stage 6 ────────────────────
const scenes = [
  {
    scene_number: 1,
    speaker: 'Arjun',
    text: 'Kaviyaa! Meenu! Vaanga, vilaiyaadalam!',
    emotion: 'joy',
    characters: ['Arjun', 'Kaviya', 'Meenu', 'Paati'],
    duration_seconds: 8,
  },
  {
    scene_number: 2,
    speaker: 'Arjun',
    text: 'Ayo! Paaru, paaru! Minminni! Minminni!',
    emotion: 'wonder',
    characters: ['Arjun', 'Kaviya', 'Meenu'],
    duration_seconds: 8,
  },
  {
    scene_number: 3,
    speaker: 'Kaviya',
    text: 'Pidichchudunga! Naanum varen! Odunga, odunga!',
    emotion: 'joy',
    characters: ['Arjun', 'Kaviya', 'Meenu'],
    duration_seconds: 9,
  },
  {
    scene_number: 4,
    speaker: 'Arjun',
    text: 'Pudinga, pudinga! Bottle-la podunga! Paaru, evvalavu iruku!',
    emotion: 'joy',
    characters: ['Arjun', 'Kaviya', 'Meenu'],
    duration_seconds: 9,
  },
  {
    scene_number: 5,
    speaker: 'Kaviya',
    text: 'Arjun... paaru. Bottle-la potathuku apram, minminni poochiyoda velicham konjam, konjama koraiyithu!',
    emotion: 'sadness',
    characters: ['Kaviya', 'Arjun', 'Meenu'],
    duration_seconds: 10,
  },
  {
    scene_number: 6,
    speaker: 'Kaviya',
    text: 'Antha poochigaluku bottle-ulla adaipattu irukrathu pidikala. Velila vitralama?',
    emotion: 'hope',
    characters: ['Kaviya', 'Arjun', 'Meenu'],
    duration_seconds: 10,
  },
  {
    scene_number: 7,
    speaker: 'Kaviya',
    text: 'Ponga... ponga... seekiram ponga.',
    emotion: 'awe',
    characters: ['Kaviya', 'Arjun', 'Meenu'],
    duration_seconds: 8,
  },
  {
    scene_number: 8,
    speaker: 'Meenu',
    text: 'Paaru, Kaviya akka... romba azhagaa irukku.',
    emotion: 'awe',
    characters: ['Kaviya', 'Arjun', 'Meenu', 'Paati'],
    duration_seconds: 9,
  },
];

// ─── Build existing asset maps from tmpDir ───────────────────────────────────
const sceneImagePaths = {};
const sceneAnimPaths = {};

for (const scene of scenes) {
  const label = String(scene.scene_number).padStart(2, '0');
  const animPath = join(TMP_DIR, 'scenes', `scene_${label}_anim.mp4`);
  const imagePath = join(TMP_DIR, 'scenes', `scene_${label}_image.png`);

  try {
    await fs.access(animPath);
    sceneAnimPaths[scene.scene_number] = {
      animPath,
      storagePath: `${TASK_ID}/scene_${label}_anim.mp4`,
    };
  } catch {
    console.warn(`  ⚠️  No anim for scene ${scene.scene_number}`);
  }

  try {
    await fs.access(imagePath);
    sceneImagePaths[scene.scene_number] = {
      imagePath,
      storagePath: `${TASK_ID}/scene_${label}_image.png`,
    };
  } catch {
    console.warn(`  ⚠️  No image for scene ${scene.scene_number}`);
  }
}

console.log(`✅ Found ${Object.keys(sceneAnimPaths).length} animations, ${Object.keys(sceneImagePaths).length} images`);

// ─── Ensure audio + assembly dirs exist ──────────────────────────────────────
await fs.mkdir(join(TMP_DIR, 'audio'), { recursive: true });
await fs.mkdir(join(TMP_DIR, 'assembly'), { recursive: true });

// ─── Run Stage 6 (TTS) + Stage 7 (Assembly) ─────────────────────────────────
const tracker = new CostTracker(TASK_ID);
let state = {
  scenes,
  sceneImagePaths,
  sceneAnimPaths,
  tmpDir: TMP_DIR,
  videoType: 'short',
  parentCardId: 'ep02-minminni-v2',
};

console.log('\n━━━ Stage 6: TTS (corrected dialogues) ━━━');
state = await runStage6(TASK_ID, tracker, state);

console.log('\n━━━ Stage 7: Assembly ━━━');
state = await runStage7(TASK_ID, tracker, state);

// ─── Copy final to output ────────────────────────────────────────────────────
const finalPath = state.finalVideoPath;
if (finalPath) {
  await fs.mkdir('output', { recursive: true });
  await fs.copyFile(finalPath, OUTPUT_PATH);
  console.log(`\n🎉 EP02 v2 complete! → ${OUTPUT_PATH}`);
} else {
  console.error('❌ No final video path in state');
  process.exit(1);
}

const totalCost = await tracker.totalSpent();
console.log(`   Total cost: $${totalCost.toFixed(4)}`);
