// stages/stage-04-illustrate.mjs — Scene image generation via Google AI Imagen
// Auto-stage — checks isFeedbackCollectionMode()
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode, getVideoType } from '../lib/settings.mjs';
import { generateSceneImage, buildScenePrompt, estimateImageCost } from '../lib/image-gen.mjs';
import { uploadSceneImage, getSceneImageUrl, downloadFromStorage, BUCKETS } from '../lib/storage.mjs';
import { createTmpDir } from '../lib/ffmpeg.mjs';
import { withRetry } from '../lib/retry.mjs';
import { calcImageCost } from '../lib/cost-tracker.mjs';
import { sendApprovalBotMedia, sendTelegramMessage, sendTelegramMessageWithButtons, waitForTelegramResponse } from '../lib/telegram.mjs';
import { getVideoConfig } from '../lib/video-config.mjs';

const STAGE = 4;
const STAGE_ID = 'illustrate';
const MAX_SCENE_FAILURES = 5;

/**
 * Stage 4: Generate one image per scene.
 * Handles partial failures gracefully (up to MAX_SCENE_FAILURES).
 */
export async function runStage4(taskId, tracker, state = {}) {
  console.log('🎨 Stage 4: Scene illustration...');

  const videoType = state.videoType ?? await getVideoType();
  const aspectRatio = getVideoConfig(videoType).aspectRatio;
  console.log(`  video_type=${videoType}, aspectRatio=${aspectRatio}`);

  let { scenes } = state;
  // Prefer characterMap with reference image buffers if available
  const characterMap = state.characterMapWithImages ?? state.characterMap;

  if (!scenes) {
    // Fallback: load from the most recent stage-2 run for this task
    console.log('  ℹ️  scenes not in current state, loading from stage 2...');
    const sb2 = getSupabase();
    const { data: stage2Row } = await sb2
      .from('video_pipeline_runs')
      .select('pipeline_state')
      .eq('task_id', taskId)
      .eq('stage_id', 'script')
      .order('started_at', { ascending: false })
      .limit(1)
      .single();
    const ps = stage2Row?.pipeline_state;
    // Support new format (ps.scenes) and legacy format (ps.script.scenes)
    scenes = ps?.scenes || ps?.script?.scenes;
  }

  if (!scenes) throw new Error('Stage 4: scenes not found in pipeline state or stage 2 history');
  if (!characterMap) throw new Error('Stage 4: characterMap not found in pipeline state');

  const sb = getSupabase();
  const tmpDir = await createTmpDir(taskId);
  const sceneImagePaths = {};

  // Hydrate characterMap with reference image buffers from Supabase Storage (BUG 1 fix).
  // Stage 3 stores reference_image_url in character_library after approval.
  // We download those buffers here so illustrateScene() can pass them to generateSceneImage().
  // All errors are non-fatal — generation will proceed without reference images if download fails.
  for (const [name, character] of Object.entries(characterMap)) {
    // Must be a real Buffer — not a deserialized JSONB object ({type:'Buffer',data:[...]})
    // which looks truthy but breaks buf.toString('base64') in Gemini API call.
    if (Buffer.isBuffer(character.referenceImageBuffer)) continue; // already a real Buffer
    character.referenceImageBuffer = null; // clear stale deserialized object, re-download below

    // Check DB for reference_image_url if not already on the character object
    let refUrl = character.reference_image_url;
    if (!refUrl) {
      try {
        const { data: dbChar } = await sb
          .from('character_library')
          .select('reference_image_url')
          .ilike('name', name)
          .maybeSingle();
        refUrl = dbChar?.reference_image_url;
      } catch (dbErr) {
        console.warn(`  ⚠️  ${name}: failed to fetch reference_image_url from DB (non-fatal): ${dbErr.message}`);
      }
    }

    if (refUrl) {
      try {
        character.referenceImageBuffer = await downloadFromStorage({ bucket: BUCKETS.characters, path: refUrl });
        console.log(`  ✓ ${name}: reference image loaded from storage (${refUrl})`);
      } catch (dlErr) {
        console.warn(`  ⚠️  ${name}: reference image download failed (non-fatal) — generating without ref: ${dlErr.message}`);
      }
    }
  }

  // RESUME LOGIC NOTE:
  // doneScenes = scenes already in scene_assets with status='completed' (PRIMARY source of truth)
  // approvedImages = in-memory/state approval (secondary, used within a single run)
  // To force a scene to regenerate: use resetSceneForRegeneration() from lib/pipeline-utils.mjs
  //   which clears BOTH sources. Clearing only pipeline_state is NOT sufficient.
  // Check which scenes already have completed assets (resume-safe)
  const { data: existingAssets } = await sb.from('scene_assets')
    .select('scene_number')
    .eq('video_id', taskId)
    .eq('status', 'completed');
  const doneScenes = new Set((existingAssets || []).map(a => a.scene_number));
  if (doneScenes.size > 0) {
    console.log(`  ↩️  Skipping ${doneScenes.size} already-illustrated scenes: ${[...doneScenes].join(', ')}`);
  }

  // Image approval state
  const approvedImages = state.approvedImages || {};
  const feedbackMode = await isFeedbackCollectionMode();
  let failureCount = 0;

  // Generate + approve one scene at a time (7s delay between Imagen calls)
  for (const scene of scenes) {
    const sceneNum = scene.scene_number;

    // Skip already-completed scenes (resume support)
    if (doneScenes.has(sceneNum)) {
      const { data: asset } = await sb.from('scene_assets')
        .select('image_url')
        .eq('video_id', taskId)
        .eq('scene_number', sceneNum)
        .single();
      sceneImagePaths[sceneNum] = { imagePath: null, storagePath: asset?.image_url };
      approvedImages[sceneNum] = { approved: true };
      console.log(`  Scene ${sceneNum}: already illustrated — skipping`);
      continue;
    }

    // Skip already-approved images (resume support)
    if (approvedImages[sceneNum]?.approved && sceneImagePaths[sceneNum]) {
      console.log(`  Scene ${sceneNum}: image already approved — skipping`);
      continue;
    }

    // Generate image for this scene
    let result;
    try {
      result = await illustrateScene({ taskId, scene, characterMap, tmpDir, tracker, aspectRatio, state });
      sceneImagePaths[sceneNum] = { imagePath: result.imagePath, storagePath: result.storagePath };
    } catch (err) {
      failureCount++;
      console.warn(`  ⚠️  Scene ${sceneNum} failed: ${err.message}`);
      await sendTelegramMessage(`⚠️ Manual asset needed: Scene ${sceneNum}\nError: ${err.message}\nUpload to: ${taskId}/scene_${String(sceneNum).padStart(2, '0')}_image.png`);
      if (failureCount > MAX_SCENE_FAILURES) {
        throw new Error(`Too many scene illustration failures (${failureCount}/${scenes.length})`);
      }
      continue;
    }

    // Approval loop for this scene
    if (feedbackMode) {
      let approved = false;
      while (!approved) {
        const entry = sceneImagePaths[sceneNum];

        // Send image to Telegram
        if (entry.imagePath) {
          const caption = `Scene ${sceneNum} (${scene.speaker}, ${scene.emotion})\n${scene.visual_description?.slice(0, 200) || ''}`;
          await sendApprovalBotMedia({ filePath: entry.imagePath, type: 'photo', caption });
        }

        // Send approve/reject buttons
        const callbackPrefix = `s4_${sceneNum}`;
        const telegramMessageId = await sendTelegramMessageWithButtons(
          `🎨 Scene ${sceneNum}/${scenes.length} Image Review\nApprove or reject with feedback`,
          callbackPrefix
        );

        const decision = await waitForTelegramResponse(telegramMessageId, callbackPrefix);

        if (decision.approved) {
          approvedImages[sceneNum] = { approved: true };
          approved = true;
          console.log(`  ✓ Scene ${sceneNum} image approved`);
        } else {
          console.log(`  ✗ Scene ${sceneNum} image rejected: ${decision.comment}`);
          console.log(`  Regenerating scene ${sceneNum} with feedback...`);
          const feedbackScene = decision.comment
            ? { ...scene, visual_description: `${scene.visual_description}. Reviewer feedback: ${decision.comment}` }
            : scene;
          const regenerated = await illustrateScene({
            taskId, scene: feedbackScene, characterMap, tmpDir, tracker, aspectRatio, state,
          });
          sceneImagePaths[sceneNum] = { imagePath: regenerated.imagePath, storagePath: regenerated.storagePath };
        }

        // Batch state save: write every 3 scenes to reduce DB load
        if (sceneNum % 3 === 0) {
          await sb.from('video_pipeline_runs').upsert({
            task_id: taskId,
            stage_id: STAGE_ID,
            status: 'running',
            pipeline_state: { ...state, sceneImagePaths, approvedImages },
          }, { onConflict: 'task_id,stage_id' });
        }
      }
    } else {
      approvedImages[sceneNum] = { approved: true };
    }

    // 7s delay before next scene to stay within Imagen 10 req/min quota
    if (scene !== scenes[scenes.length - 1]) {
      await new Promise(r => setTimeout(r, 7000));
    }
  }

  // Bug 2 fix: persist tmpDir in pipeline_state so downstream stages (6, 7) can find local paths
  const sb2 = getSupabase();
  await sb2.from('video_pipeline_runs').upsert({
    task_id: taskId,
    stage_id: STAGE_ID,
    status: 'completed',
    pipeline_state: { ...state, scenes, sceneImagePaths, approvedImages, tmpDir },
  }, { onConflict: 'task_id,stage_id' });

  console.log(`✅ Stage 4 complete. ${Object.keys(sceneImagePaths).length}/${scenes.length} scenes illustrated`);
  return { ...state, scenes, sceneImagePaths, approvedImages, tmpDir };
}

async function illustrateScene({ taskId, scene, characterMap, tmpDir, tracker, aspectRatio = '16:9', state }) {
  // Look up primary character by scene.speaker
  const character = characterMap[scene.speaker]
    ?? characterMap[scene.speaker?.toUpperCase()]
    ?? characterMap['NARRATOR']
    ?? null;

  const prompt = buildScenePrompt(scene, character, { aspectRatio, artStyle: state?.artStyle || '3D Pixar animation still' });
  console.log(`  Generating image for scene ${scene.scene_number} (${scene.speaker}/${scene.emotion}, ${aspectRatio})...`);

  // Collect reference image buffers from characters appearing in this scene
  const sceneCharacterKeys = scene.characters?.length
    ? scene.characters
    : (scene.speaker ? [scene.speaker] : []);
  const referenceImages = sceneCharacterKeys
    .map(key => characterMap[key]?.referenceImageBuffer ?? characterMap[key?.toUpperCase()]?.referenceImageBuffer)
    .filter(Boolean)
    .slice(0, 4); // Gemini 3.1 Flash cap: 4 reference images

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

  // Record in scene_assets
  const sb = getSupabase();
  await sb.from('scene_assets').upsert({
    video_id:     taskId,
    scene_number: scene.scene_number,
    image_url:    storagePath,
    prompt_used:  prompt,
    status:       'completed',
  }, { onConflict: 'video_id,scene_number' });

  const cost = calcImageCost(1, 'fast');
  tracker.addCost(STAGE, cost);

  console.log(`  ✓ Scene ${scene.scene_number} illustrated ($${cost.toFixed(4)})`);
  return { scene, imagePath, storagePath };
}

