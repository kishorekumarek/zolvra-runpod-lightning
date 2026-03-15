// stages/stage-05-animate.mjs — Wan 2.6 image-to-video per scene
// Auto-stage — checks isFeedbackCollectionMode()
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode } from '../lib/settings.mjs';
import { createNexusCard } from '../lib/nexus-client.mjs';
import { submitWanJob, pollWanJob, downloadWanVideo } from '../lib/wan.mjs';
import { uploadSceneAnimation, uploadSceneImage, getSignedUrl, downloadFromStorage, BUCKETS } from '../lib/storage.mjs';
import { generateSceneImage, buildScenePrompt } from '../lib/image-gen.mjs';
import { stillImageToVideo } from '../lib/ffmpeg.mjs';
import { withRetry } from '../lib/retry.mjs';
import { calcAnimationCost, calcImageCost } from '../lib/cost-tracker.mjs';

const STAGE = 5;
const NSFW_HALT_RATIO = 0.8; // halt pipeline if >80% of scenes fail
const WAN_INTER_JOB_DELAY_MS = 10000; // 10s delay between Wan jobs

/**
 * Build a concise animation prompt from scene data (max ~300 chars).
 * "Scene setting. Character name + key visual. Gentle movement, warm lighting, Pixar animation style, child-friendly Tamil village scene."
 */
function buildWanPrompt(scene) {
  const setting   = scene.environment || 'Tamil village';
  const speaker   = scene.speaker   || 'characters';
  const emotion   = scene.emotion   || 'happy';
  const descSnip  = (scene.visual_description || '').slice(0, 150).replace(/\n/g, ' ').trim();

  const prompt = `${setting} scene, ${emotion} mood. ${speaker}: ${descSnip}. Gentle movement, warm lighting, Pixar animation style, child-friendly Tamil village scene.`;
  // Clamp to 300 chars
  return prompt.slice(0, 300);
}

/**
 * Stage 5: Animate each scene with Wan 2.6 image-to-video (one by one, 10s delay between jobs).
 */
export async function runStage5(taskId, tracker, state = {}) {
  console.log('🎬 Stage 5: Scene animation (Wan 2.6)...');

  const { scenes, sceneImagePaths, characterMap, parentCardId, tmpDir } = state;
  if (!scenes) throw new Error('Stage 5: scenes not found');
  if (!sceneImagePaths) throw new Error('Stage 5: sceneImagePaths not found');

  const sb = getSupabase();
  const sceneAnimPaths = {};

  // Process scenes ONE BY ONE to avoid Wan rate limits
  const validScenes = scenes.filter(s => sceneImagePaths[s.scene_number]);
  const results = [];

  for (let i = 0; i < validScenes.length; i++) {
    const scene = validScenes[i];
    const result = await Promise.allSettled([
      animateScene({
        taskId, scene,
        imagePath: sceneImagePaths[scene.scene_number]?.imagePath,
        storagePath: sceneImagePaths[scene.scene_number]?.storagePath,
        characterMap, tmpDir, tracker
      })
    ]);
    results.push({ ...result[0], scene });

    // 10s delay between jobs (except after last)
    if (i < validScenes.length - 1) {
      console.log(`  ⏳ Waiting ${WAN_INTER_JOB_DELAY_MS / 1000}s before next Wan job...`);
      await new Promise(r => setTimeout(r, WAN_INTER_JOB_DELAY_MS));
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

  // Build concise Wan prompt (max 300 chars)
  const prompt = buildWanPrompt(scene);
  console.log(`  Submitting Wan 2.6 job for scene ${scene.scene_number}...`);
  console.log(`  Prompt: ${prompt}`);

  let currentImagePath = imagePath;
  let currentStoragePath = storagePath;

  const imageUrl = await resolveSignedUrl(currentStoragePath, scene.scene_number);
  const wanTaskId = await withRetry(
    () => submitWanJob({ imageUrl, prompt }),
    { maxRetries: 3, baseDelayMs: 30000, stage: STAGE, taskId }
  );

  // Poll for result
  const videoUrl = await withRetry(
    () => pollWanJob(wanTaskId, 600000),
    { maxRetries: 2, baseDelayMs: 15000, stage: STAGE, taskId }
  );

  const videoBuffer = await downloadWanVideo(videoUrl);

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

/**
 * Ensure we have a local copy of the scene image.
 * If imagePath is null (resume path — scene was skipped in stage 4), download from storage.
 */
async function ensureLocalImagePath({ imagePath, storagePath, sceneNumber, tmpDir }) {
  if (imagePath) return imagePath;
  // Download from Supabase Storage
  const buffer = await downloadFromStorage({ bucket: BUCKETS.scenes, path: storagePath });
  const scenesDir = join(tmpDir, 'scenes');
  await fs.mkdir(scenesDir, { recursive: true });
  const localPath = join(scenesDir, `scene_${String(sceneNumber).padStart(2, '0')}_image.png`);
  await fs.writeFile(localPath, buffer);
  console.log(`  ↩️  Downloaded scene ${sceneNumber} image from storage to ${localPath}`);
  return localPath;
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
