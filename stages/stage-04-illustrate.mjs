// stages/stage-04-illustrate.mjs — Scene image generation via Google AI Imagen
// REWRITTEN for pipeline schema rewrite: reads from DB, writes to scenes table.
// Dual-write: also returns old sceneImagePaths for un-rewritten Stage 5.
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { isFeedbackCollectionMode } from '../lib/settings.mjs';
import { generateSceneImage, buildScenePrompt } from '../lib/image-gen.mjs';
import { uploadSceneImage, downloadFromStorage, BUCKETS } from '../lib/storage.mjs';
import { createTmpDir } from '../lib/ffmpeg.mjs';
import { withRetry } from '../lib/retry.mjs';
import { calcImageCost } from '../lib/cost-tracker.mjs';
import { sendApprovalBotMedia, sendTelegramMessage, sendTelegramMessageWithButtons, waitForTelegramResponse } from '../lib/telegram.mjs';
import { getVideoConfig } from '../lib/video-config.mjs';
import {
  getPipelineState, getConcept, getScenes, getEpisodeCharacters, updateScene,
} from '../lib/pipeline-db.mjs';

const STAGE = 4;
const STAGE_ID = 'illustrate';
const MAX_SCENE_FAILURES = 5;

/**
 * Stage 4: Generate one image per scene.
 *
 * NEW: reads scenes + episode_characters from DB, writes to scenes table.
 * Writes image_url/image_status/image_approved to scenes table.
 */
export async function runStage4(taskId, tracker, state = {}) {
  console.log('🎨 Stage 4: Scene illustration...');

  // ── Read from DB ───────────────────────────────────────────────────
  const ps = await getPipelineState(taskId);
  if (!ps?.concept_id) throw new Error('Stage 4: pipeline_state not found or missing concept_id');

  const concept = await getConcept(ps.concept_id);
  const videoType = concept.video_type || 'short';
  const artStyle = concept.art_style || '3D Pixar animation still';
  const aspectRatio = getVideoConfig(videoType).aspectRatio;
  console.log(`  video_type=${videoType}, aspectRatio=${aspectRatio}`);

  // Load all scenes from DB
  const scenes = await getScenes(taskId);
  if (!scenes || scenes.length === 0) throw new Error('Stage 4: no scenes found in DB');

  // Load episode characters for reference images
  const epChars = await getEpisodeCharacters(taskId);
  const epCharMap = {};
  for (const ec of epChars) {
    epCharMap[ec.character_name.toLowerCase()] = ec;
  }

  // ── Hydrate reference images from storage ──────────────────────────
  const referenceImageBuffers = {};
  for (const ec of epChars) {
    const refUrl = ec.episode_image_url || ec.reference_image_url;
    if (!refUrl) continue;
    try {
      referenceImageBuffers[ec.character_name] = await downloadFromStorage({ bucket: BUCKETS.characters, path: refUrl });
      console.log(`  ✓ ${ec.character_name}: reference image loaded from storage`);
    } catch (dlErr) {
      console.warn(`  ⚠️  ${ec.character_name}: reference image download failed (non-fatal): ${dlErr.message}`);
    }
  }

  const tmpDir = await createTmpDir(taskId);

  const sceneImagePaths = {}; // local paths for within-run use only

  const feedbackMode = await isFeedbackCollectionMode();
  let failureCount = 0;

  await sendTelegramMessage(`🎨 Stage 4: Illustrating ${scenes.length} scenes...`);

  for (const scene of scenes) {
    const sceneNum = scene.scene_number;

    // Skip already-completed scenes (resume from DB)
    if (scene.image_status === 'completed') {
      sceneImagePaths[sceneNum] = { imagePath: null, storagePath: scene.image_url };
      console.log(`  Scene ${sceneNum}: already illustrated — skipping`);
      continue;
    }

    // ── Generate image ───────────────────────────────────────────────
    let imagePath, storagePath;
    try {
      const result = await illustrateScene({
        taskId, scene, epCharMap, referenceImageBuffers, tmpDir, tracker, aspectRatio, artStyle,
      });
      imagePath = result.imagePath;
      storagePath = result.storagePath;
      sceneImagePaths[sceneNum] = { imagePath, storagePath };
    } catch (err) {
      failureCount++;
      console.warn(`  ⚠️  Scene ${sceneNum} failed: ${err.message}`);
      await sendTelegramMessage(`⚠️ Manual asset needed: Scene ${sceneNum}\nError: ${err.message}\nUpload to: ${taskId}/scene_${String(sceneNum).padStart(2, '0')}_image.png`);
      await updateScene(taskId, sceneNum, { image_status: 'failed' });
      if (failureCount > MAX_SCENE_FAILURES) {
        throw new Error(`Too many scene illustration failures (${failureCount}/${scenes.length})`);
      }
      continue;
    }

    // ── Approval loop ────────────────────────────────────────────────
    if (feedbackMode) {
      let approved = false;
      while (!approved) {
        if (imagePath) {
          const caption = `Scene ${sceneNum} (${scene.speaker}, ${scene.emotion})\n${scene.visual_description?.slice(0, 200) || ''}`;
          await sendApprovalBotMedia({ filePath: imagePath, type: 'photo', caption });
        }

        const callbackPrefix = `s4_${sceneNum}`;
        const telegramMessageId = await sendTelegramMessageWithButtons(
          `🎨 Scene ${sceneNum}/${scenes.length} Image Review\nApprove or reject with feedback`,
          callbackPrefix
        );

        const decision = await waitForTelegramResponse(telegramMessageId, callbackPrefix);

        if (decision.approved) {
          await updateScene(taskId, sceneNum, { image_approved: true });
          approved = true;
          console.log(`  ✓ Scene ${sceneNum} image approved`);
        } else {
          console.log(`  ✗ Scene ${sceneNum} image rejected: ${decision.comment}`);
          console.log(`  Regenerating scene ${sceneNum} with feedback...`);
          const feedbackScene = decision.comment
            ? { ...scene, visual_description: `${scene.visual_description}. Reviewer feedback: ${decision.comment}` }
            : scene;
          const regenerated = await illustrateScene({
            taskId, scene: feedbackScene, epCharMap, referenceImageBuffers, tmpDir, tracker, aspectRatio, artStyle,
          });
          imagePath = regenerated.imagePath;
          storagePath = regenerated.storagePath;
          sceneImagePaths[sceneNum] = { imagePath, storagePath };
        }
      }
    } else {
      // Auto-mode: no approval needed
      await updateScene(taskId, sceneNum, { image_approved: true });
    }

    // 7s delay before next scene to stay within Imagen 10 req/min quota
    if (scene !== scenes[scenes.length - 1]) {
      await new Promise(r => setTimeout(r, 7000));
    }
  }

  await sendTelegramMessage(`✅ Stage 4 complete — ${Object.keys(sceneImagePaths).length}/${scenes.length} scenes illustrated`);
  console.log(`✅ Stage 4 complete. ${Object.keys(sceneImagePaths).length}/${scenes.length} scenes illustrated`);

}

/**
 * Generate + upload one scene image. Updates scenes table in DB.
 */
async function illustrateScene({ taskId, scene, epCharMap, referenceImageBuffers, tmpDir, tracker, aspectRatio = '16:9', artStyle = '3D Pixar animation still' }) {
  // Look up primary character from episode_characters
  const speakerKey = scene.speaker?.toLowerCase();
  const character = epCharMap[speakerKey] || null;

  // Build prompt — buildScenePrompt expects { image_prompt, description } on character
  const charForPrompt = character ? { image_prompt: character.image_prompt, description: character.image_prompt } : null;
  const prompt = buildScenePrompt(scene, charForPrompt, { aspectRatio, artStyle });
  console.log(`  Generating image for scene ${scene.scene_number} (${scene.speaker}/${scene.emotion}, ${aspectRatio})...`);

  // Collect reference image buffers from characters visible in this scene
  const sceneCharacterKeys = scene.characters?.length
    ? scene.characters
    : (scene.speaker ? [scene.speaker] : []);
  const referenceImages = sceneCharacterKeys
    .map(key => referenceImageBuffers[key] || referenceImageBuffers[key?.toLowerCase()])
    .filter(Boolean)
    .slice(0, 4); // Gemini cap: 4 reference images

  if (referenceImages.length > 0) {
    console.log(`  ↩️  Attaching ${referenceImages.length} character reference image(s) for scene ${scene.scene_number}`);
  }

  const imageBuffer = await withRetry(
    () => generateSceneImage({ prompt, sceneNumber: scene.scene_number, aspectRatio, referenceImages }),
    { maxRetries: 3, baseDelayMs: 15000, stage: STAGE, taskId }
  );

  // Save locally
  const scenesDir = join(tmpDir, 'scenes');
  await fs.mkdir(scenesDir, { recursive: true });
  const imagePath = join(scenesDir, `scene_${String(scene.scene_number).padStart(2, '0')}_image.png`);
  await fs.writeFile(imagePath, imageBuffer);

  // Upload to Supabase Storage
  const storagePath = await uploadSceneImage({
    videoId: taskId,
    sceneNumber: scene.scene_number,
    buffer: imageBuffer,
  });

  // 2s delay: let Supabase finish the storage.objects metadata write
  await new Promise(r => setTimeout(r, 2000));

  // NEW: write to scenes table (replaces old scene_assets)
  await updateScene(taskId, scene.scene_number, {
    image_url: storagePath,
    prompt_used: prompt,
    image_status: 'completed',
  });

  const cost = calcImageCost(1, 'fast');
  tracker.addCost(STAGE, cost);

  console.log(`  ✓ Scene ${scene.scene_number} illustrated ($${cost.toFixed(4)})`);
  return { scene, imagePath, storagePath };
}
