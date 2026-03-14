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
import { uploadSceneAnimation, getSignedUrl, BUCKETS } from '../lib/storage.mjs';
import { withRetry } from '../lib/retry.mjs';
import { calcAnimationCost } from '../lib/cost-tracker.mjs';

const STAGE = 5;
const MAX_SCENE_FAILURES = 2;

/**
 * Stage 5: Animate each scene with Kling image-to-video.
 */
export async function runStage5(taskId, tracker, state = {}) {
  console.log('🎬 Stage 5: Scene animation...');

  const { script, sceneImagePaths, parentCardId, tmpDir } = state;
  if (!script) throw new Error('Stage 5: script not found');
  if (!sceneImagePaths) throw new Error('Stage 5: sceneImagePaths not found');

  const sb = getSupabase();
  const sceneAnimPaths = {};

  // Process scenes in batches of 3 (avoid Kling rate limits)
  const scenes = script.scenes.filter(s => sceneImagePaths[s.scene_number]);
  const results = [];

  for (let i = 0; i < scenes.length; i += 3) {
    const batch = scenes.slice(i, i + 3);
    const batchResults = await Promise.allSettled(
      batch.map(scene => animateScene({
        taskId, scene,
        imagePath: sceneImagePaths[scene.scene_number]?.imagePath,
        storagePath: sceneImagePaths[scene.scene_number]?.storagePath,
        tmpDir, tracker
      }))
    );
    results.push(...batchResults.map((r, idx) => ({ ...r, scene: batch[idx] })));

    if (i + 3 < scenes.length) {
      // Small delay between batches
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  const failed = results.filter(r => r.status === 'rejected');

  if (failed.length > MAX_SCENE_FAILURES) {
    throw new Error(
      `Too many animation failures (${failed.length}/${scenes.length}). ` +
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

  console.log(`✅ Stage 5 complete. ${Object.keys(sceneAnimPaths).length}/${scenes.length} scenes animated`);
  return { ...state, sceneAnimPaths };
}

async function animateScene({ taskId, scene, imagePath, storagePath, tmpDir, tracker }) {
  if (!storagePath) throw new Error(`No storage path for scene ${scene.scene_number}`);

  // Get signed URL for Kling (needs public-accessible URL)
  let imageUrl;
  try {
    imageUrl = await getSignedUrl({ bucket: BUCKETS.scenes, path: storagePath, expiresInSeconds: 3600 });
  } catch (err) {
    throw new Error(`Could not get signed URL for scene ${scene.scene_number}: ${err.message}`);
  }

  const motionParams = await getKlingParams(scene.motion_type || 'dialogue');
  const prompt = `${scene.visual_description} — ${motionParams.prompt_suffix}, gentle children's animation style`;

  console.log(`  Submitting Kling job for scene ${scene.scene_number} (${scene.motion_type})...`);

  const taskIdKling = await withRetry(
    () => submitKlingJob({ imageUrl, prompt, motionParams }),
    { maxRetries: 3, baseDelayMs: 30000, stage: STAGE, taskId }
  );

  const videoUrl = await withRetry(
    () => pollKlingJob(taskIdKling, 300000),
    { maxRetries: 2, baseDelayMs: 10000, stage: STAGE, taskId }
  );

  // Download animation
  const videoBuffer = await downloadKlingVideo(videoUrl);

  // Save locally
  const sceneDir = join(tmpDir, 'scenes', `scene_${String(scene.scene_number).padStart(2, '0')}`);
  await fs.mkdir(sceneDir, { recursive: true });
  const animPath = join(sceneDir, 'animation.mp4');
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

  // Track cost
  const cost = calcAnimationCost(1);
  tracker.addCost(STAGE, cost);

  console.log(`  ✓ Scene ${scene.scene_number} animated ($${cost.toFixed(4)})`);
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
