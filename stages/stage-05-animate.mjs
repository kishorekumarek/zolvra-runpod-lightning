// stages/stage-05-animate.mjs — Kling image-to-video per scene
// Auto-stage — checks isFeedbackCollectionMode()
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode } from '../lib/settings.mjs';
import { createNexusCard } from '../lib/nexus-client.mjs';
import { submitKlingJob, pollKlingJob, downloadKlingVideo } from '../lib/kling.mjs';
import { getKlingParams } from '../lib/motion-params.mjs';
import { uploadSceneAnimation, uploadSceneImage, getSignedUrl, BUCKETS } from '../lib/storage.mjs';
import { generateSceneImage, buildScenePrompt } from '../lib/image-gen.mjs';
import { stillImageToVideo } from '../lib/ffmpeg.mjs';
import { withRetry } from '../lib/retry.mjs';
import { calcAnimationCost, calcImageCost } from '../lib/cost-tracker.mjs';

const STAGE = 5;
const NSFW_HALT_RATIO = 0.8; // halt pipeline if >80% of scenes fail

/** Returns true if the error is a Hailuo NSFW rejection (HTTP/API code 422). */
function isNsfwError(err) {
  return /422/.test(err?.message);
}

/**
 * Stage 5: Animate each scene with Kling image-to-video.
 */
export async function runStage5(taskId, tracker, state = {}) {
  console.log('🎬 Stage 5: Scene animation...');

  const { scenes, sceneImagePaths, characterMap, parentCardId, tmpDir } = state;
  if (!scenes) throw new Error('Stage 5: scenes not found');
  if (!sceneImagePaths) throw new Error('Stage 5: sceneImagePaths not found');

  const sb = getSupabase();
  const sceneAnimPaths = {};

  // Process scenes in batches of 3 (avoid Kling rate limits)
  const validScenes = scenes.filter(s => sceneImagePaths[s.scene_number]);
  const results = [];

  for (let i = 0; i < validScenes.length; i += 3) {
    const batch = validScenes.slice(i, i + 3);
    const batchResults = await Promise.allSettled(
      batch.map(scene => animateScene({
        taskId, scene,
        imagePath: sceneImagePaths[scene.scene_number]?.imagePath,
        storagePath: sceneImagePaths[scene.scene_number]?.storagePath,
        characterMap, tmpDir, tracker
      }))
    );
    results.push(...batchResults.map((r, idx) => ({ ...r, scene: batch[idx] })));

    if (i + 3 < validScenes.length) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  const failed = results.filter(r => r.status === 'rejected');

  if (validScenes.length > 0 && failed.length / validScenes.length > NSFW_HALT_RATIO) {
    throw new Error(
      `Too many animation failures (${failed.length}/${validScenes.length}, ${Math.round(failed.length / validScenes.length * 100)}%). ` +
      `Errors: ${failed.map(f => f.reason?.message).join('; ')}`
    );
  }

  if (failed.length > 0) {
    for (const f of failed) {
      console.warn(`  ⚠️  Scene ${f.scene.scene_number} animation failed: ${f.reason?.message}`);
      await createNexusCard({
        title: `Manual animation needed: Scene ${f.scene.scene_number}`,
        description: `Animation failed: ${f.reason?.message}\nPlease upload a replacement MP4 to scenes/${taskId}/scene_${String(f.scene.scene_number).padStart(2, '0')}_anim.mp4`,
        task_type: 'stage_review',
        priority: 'high',
        parent_id: parentCardId,
        stream: 'youtube',
      });
    }
  }

  // Collect successful paths
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { scene, animPath, storagePath } = r.value;
      sceneAnimPaths[scene.scene_number] = { animPath, storagePath };
    }
  }

  // Feedback collection mode — review animations
  if (await isFeedbackCollectionMode()) {
    await feedbackReviewAnimations({ taskId, sceneAnimPaths, parentCardId, sb });
  }

  console.log(`✅ Stage 5 complete. ${Object.keys(sceneAnimPaths).length}/${validScenes.length} scenes animated`);
  return { ...state, sceneAnimPaths };
}

async function animateScene({ taskId, scene, imagePath, storagePath, characterMap, tmpDir, tracker }) {
  if (!storagePath) throw new Error(`No storage path for scene ${scene.scene_number}`);

  // New flat scene format has no motion_type — default to 'dialogue'
  const motionType = scene.motion_type || 'dialogue';
  const motionParams = await getKlingParams(motionType);
  const prompt = `${scene.visual_description} — ${motionParams.prompt_suffix}, gentle children's animation style`;

  console.log(`  Submitting Hailuo job for scene ${scene.scene_number}...`);

  let currentImagePath = imagePath;
  let currentStoragePath = storagePath;
  let klingTaskId;

  // Attempt 1 — original image
  try {
    const imageUrl = await resolveSignedUrl(currentStoragePath, scene.scene_number);
    klingTaskId = await withRetry(
      () => submitKlingJob({ imageUrl, prompt, motionParams }),
      { maxRetries: 3, baseDelayMs: 30000, stage: STAGE, taskId }
    );
  } catch (err) {
    if (!isNsfwError(err)) throw err;

    console.warn(`  ⚠️  Scene ${scene.scene_number} NSFW rejected (attempt 1). Regenerating with extra-safe prompt...`);
    ({ imagePath: currentImagePath, storagePath: currentStoragePath } =
      await regenerateSafeImage({ taskId, scene, characterMap, tmpDir, tracker }));

    // Attempt 2 — extra-safe regenerated image
    try {
      const imageUrl = await resolveSignedUrl(currentStoragePath, scene.scene_number);
      klingTaskId = await withRetry(
        () => submitKlingJob({ imageUrl, prompt, motionParams }),
        { maxRetries: 3, baseDelayMs: 30000, stage: STAGE, taskId }
      );
    } catch (err2) {
      if (!isNsfwError(err2)) throw err2;

      console.warn(`  ⚠️  Scene ${scene.scene_number} NSFW rejected (attempt 2). Using static image fallback.`);
      return staticImageFallback({ taskId, scene, imagePath: currentImagePath, storagePath: currentStoragePath, tmpDir, tracker });
    }
  }

  const videoUrl = await withRetry(
    () => pollKlingJob(klingTaskId, 300000),
    { maxRetries: 2, baseDelayMs: 10000, stage: STAGE, taskId }
  );

  const videoBuffer = await downloadKlingVideo(videoUrl);

  // Save locally
  const scenesDir = join(tmpDir, 'scenes');
  await fs.mkdir(scenesDir, { recursive: true });
  const animPath = join(scenesDir, `scene_${String(scene.scene_number).padStart(2, '0')}_anim.mp4`);
  await fs.writeFile(animPath, videoBuffer);

  // Upload to storage
  const animStoragePath = await uploadSceneAnimation({
    videoId: taskId,
    sceneNumber: scene.scene_number,
    buffer: videoBuffer,
  });

  // Update scene_assets
  const sb = getSupabase();
  await sb.from('scene_assets')
    .update({ animation_url: animStoragePath })
    .eq('video_id', taskId)
    .eq('scene_number', scene.scene_number);

  const cost = calcAnimationCost(1);
  tracker.addCost(STAGE, cost);

  console.log(`  ✓ Scene ${scene.scene_number} animated ($${cost.toFixed(4)})`);
  return { scene, animPath, storagePath: animStoragePath };
}

async function resolveSignedUrl(storagePath, sceneNumber) {
  try {
    return await getSignedUrl({ bucket: BUCKETS.scenes, path: storagePath, expiresInSeconds: 3600 });
  } catch (err) {
    throw new Error(`Could not get signed URL for scene ${sceneNumber}: ${err.message}`);
  }
}

/** Re-generate scene image with an extra-safe prompt to avoid NSFW rejection. */
async function regenerateSafeImage({ taskId, scene, characterMap, tmpDir, tracker }) {
  // Look up character by scene.speaker (flat format — no scene.lines)
  const character = characterMap?.[scene.speaker]
    ?? characterMap?.[scene.speaker?.toUpperCase()]
    ?? characterMap?.['NARRATOR']
    ?? null;

  const extraSuffix = 'minimal characters, simple background, no physical contact between characters, wide shot, child-friendly';
  const prompt = buildScenePrompt(scene, character, extraSuffix);

  console.log(`  Regenerating image for scene ${scene.scene_number} with extra-safe prompt...`);
  const imageBuffer = await withRetry(
    () => generateSceneImage({ prompt }),
    { maxRetries: 3, baseDelayMs: 15000, stage: STAGE, taskId }
  );

  const scenesDir = join(tmpDir, 'scenes');
  await fs.mkdir(scenesDir, { recursive: true });
  const imagePath = join(scenesDir, `scene_${String(scene.scene_number).padStart(2, '0')}_image_safe.png`);
  await fs.writeFile(imagePath, imageBuffer);

  const storagePath = await uploadSceneImage({
    videoId: taskId,
    sceneNumber: scene.scene_number,
    buffer: imageBuffer,
  });

  tracker.addCost(STAGE, calcImageCost(1, 'fast'));
  return { imagePath, storagePath };
}

/** Create a freeze-frame 10s video from a still image as last-resort fallback. */
async function staticImageFallback({ taskId, scene, imagePath, storagePath, tmpDir, tracker }) {
  const scenesDir = join(tmpDir, 'scenes');
  await fs.mkdir(scenesDir, { recursive: true });
  const animPath = join(scenesDir, `scene_${String(scene.scene_number).padStart(2, '0')}_anim.mp4`);

  await stillImageToVideo({ imagePath, duration: 10, outputPath: animPath });

  const videoBuffer = await fs.readFile(animPath);
  const animStoragePath = await uploadSceneAnimation({
    videoId: taskId,
    sceneNumber: scene.scene_number,
    buffer: videoBuffer,
  });

  const sb = getSupabase();
  await sb.from('scene_assets')
    .update({ animation_url: animStoragePath })
    .eq('video_id', taskId)
    .eq('scene_number', scene.scene_number);

  console.log(`  ✓ Scene ${scene.scene_number} using static fallback (freeze frame, 10s)`);
  return { scene, animPath, storagePath: animStoragePath };
}

async function feedbackReviewAnimations({ taskId, sceneAnimPaths, parentCardId, sb }) {
  console.log('  📋 Feedback collection mode: requesting animation review...');

  const urlList = Object.entries(sceneAnimPaths)
    .map(([n, { storagePath }]) => `Scene ${n}: ${storagePath}`)
    .join('\n');

  const cardId = await createNexusCard({
    title: `[Feedback] Stage 5: Scene Animations Review`,
    description: [
      `Feedback collection mode: Please review all scene animations.`,
      `\n**Animation paths:**\n${urlList}`,
      `\nApprove to continue, or Request Changes with specific feedback per scene.`,
    ].join('\n'),
    task_type: 'stage_review',
    priority: 'medium',
    parent_id: parentCardId,
    stream: 'youtube',
  });

  console.log(`  NEXUS animation review card created: ${cardId} (non-blocking)`);
}
