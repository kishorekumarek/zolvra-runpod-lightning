// stages/stage-05-animate.mjs — Wan 2.6 image-to-video per scene
// Auto-stage — checks isFeedbackCollectionMode()
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode } from '../lib/settings.mjs';
import { sendTelegramMessage, sendTelegramMessageWithButtons, sendApprovalBotMedia, waitForTelegramResponse } from '../lib/telegram.mjs';
import { submitWanJob, pollWanJob, downloadWanVideo } from '../lib/wan.mjs';
import { uploadSceneAnimation, uploadSceneImage, getSignedUrl, downloadFromStorage, BUCKETS } from '../lib/storage.mjs';
import { generateSceneImage, buildScenePrompt } from '../lib/image-gen.mjs';
import { stillImageToVideo } from '../lib/ffmpeg.mjs';
import { withRetry } from '../lib/retry.mjs';
import { calcAnimationCost, calcImageCost } from '../lib/cost-tracker.mjs';
import { callClaude } from '../../shared/claude.mjs';
import { getVideoConfig } from '../lib/video-config.mjs';

const STAGE = 5;
const NSFW_HALT_RATIO = 0.8; // halt pipeline if >80% of scenes fail
const WAN_INTER_JOB_DELAY_MS = 10000; // 10s delay between Wan jobs

/**
 * Build a concise animation prompt from scene data (max ~300 chars).
 * "Scene setting. Character name + key visual. Gentle movement, warm lighting, Pixar animation style, child-friendly Tamil village scene."
 */
function buildWanPrompt(scene, artStyle = '3D Pixar animation style', aspectRatio = '16:9') {
  const setting   = scene.environment || 'Tamil village';
  const speaker   = scene.speaker   || 'characters';
  const emotion   = scene.emotion   || 'happy';
  const descSnip  = (scene.visual_description || '').slice(0, 150).replace(/\n/g, ' ').trim();
  const orientation = aspectRatio === '9:16' ? '9:16 vertical portrait' : '16:9 widescreen';

  const prompt = `${setting} scene, ${emotion} mood, ${orientation}. ${speaker}: ${descSnip}. Smooth animation, ${artStyle}, gentle movement, warm cinematic lighting, child-friendly.`;
  // Clamp to 300 chars
  return prompt.slice(0, 300);
}

/**
 * Refine a Wan animation prompt based on reviewer feedback via Claude.
 * Returns the refined prompt, or the original if refinement fails.
 */
async function refineWanPrompt(currentPrompt, feedback) {
  try {
    const msg = await callClaude({
      model: 'claude-sonnet-4-6',
      maxTokens: 256,
      system: 'You are an animation prompt editor for a children\'s YouTube channel. Given a current image-to-video animation prompt and reviewer feedback, return ONLY an updated prompt string (max 300 characters). Focus on motion, camera movement, character actions, and mood. No JSON, no explanation, just the prompt text.',
      messages: [{
        role: 'user',
        content: `Current animation prompt: "${currentPrompt}"\n\nReviewer feedback: "${feedback}"\n\nReturn the updated prompt.`,
      }],
    });
    const refined = msg.content[0]?.text?.trim() || currentPrompt;
    return refined.slice(0, 300); // Wan max 300 chars
  } catch (err) {
    console.warn(`  ⚠️  Wan prompt refinement failed: ${err.message} — reusing previous prompt`);
    return currentPrompt;
  }
}

/**
 * Stage 5: Animate each scene with Wan 2.6 image-to-video.
 * Generate one → send for approval (Telegram) → approved or regenerate → next scene.
 */
export async function runStage5(taskId, tracker, state = {}) {
  console.log('🎬 Stage 5: Scene animation (Wan 2.6)...');

  const { scenes, sceneImagePaths, characterMap, tmpDir, videoType, artStyle } = state;
  const aspectRatio = getVideoConfig(videoType).aspectRatio;
  if (!scenes) throw new Error('Stage 5: scenes not found');
  if (!sceneImagePaths) throw new Error('Stage 5: sceneImagePaths not found');

  const sb = getSupabase();
  const sceneAnimPaths = state.sceneAnimPaths || {};
  const approvedAnims = state.approvedAnims || {};
  const feedbackMode = await isFeedbackCollectionMode();
  let failureCount = 0;

  const validScenes = scenes.filter(s => sceneImagePaths[s.scene_number]);

  if (feedbackMode) {
    await sendTelegramMessage(`🎬 Stage 5: Animating ${validScenes.length} scenes (one at a time with approval)`);
  }

  for (let i = 0; i < validScenes.length; i++) {
    const scene = validScenes[i];
    const sceneNum = scene.scene_number;

    // Skip already-approved (resume support)
    if (approvedAnims[sceneNum]?.approved) {
      console.log(`  Scene ${sceneNum}: animation already approved — skipping`);
      continue;
    }

    // Generate animation
    let animResult;
    try {
      animResult = await animateScene({
        taskId, scene,
        imagePath: sceneImagePaths[sceneNum]?.imagePath,
        storagePath: sceneImagePaths[sceneNum]?.storagePath,
        characterMap, tmpDir, tracker, artStyle, aspectRatio,
      });
      sceneAnimPaths[sceneNum] = { animPath: animResult.animPath, storagePath: animResult.storagePath };
    } catch (err) {
      failureCount++;
      console.warn(`  ⚠️  Scene ${sceneNum} animation failed: ${err.message}`);

      // Try static fallback
      try {
        const localImagePath = await ensureLocalImagePath({
          imagePath: sceneImagePaths[sceneNum]?.imagePath,
          storagePath: sceneImagePaths[sceneNum]?.storagePath,
          sceneNumber: sceneNum, tmpDir,
        });
        const fallback = await staticImageFallback({ taskId, scene, imagePath: localImagePath, storagePath: sceneImagePaths[sceneNum]?.storagePath, tmpDir, tracker, videoType });
        sceneAnimPaths[sceneNum] = { animPath: fallback.animPath, storagePath: fallback.storagePath };
        animResult = fallback;
      } catch (fallbackErr) {
        console.warn(`  ⚠️  Scene ${sceneNum} static fallback also failed: ${fallbackErr.message}`);
        await sendTelegramMessage(`⚠️ Manual animation needed: Scene ${sceneNum}\nAnimation failed: ${err.message}\nFallback failed: ${fallbackErr.message}`);
        if (failureCount / validScenes.length > NSFW_HALT_RATIO) {
          throw new Error(`Too many animation failures (${failureCount}/${validScenes.length})`);
        }
        continue;
      }
    }

    if (!feedbackMode) {
      // Auto mode — no approval, move to next
      approvedAnims[sceneNum] = { approved: true };
      if (i < validScenes.length - 1) await new Promise(r => setTimeout(r, WAN_INTER_JOB_DELAY_MS));
      continue;
    }

    // Feedback mode — send for approval
    let approved = false;
    while (!approved) {
      const entry = sceneAnimPaths[sceneNum];

      // Send video to Telegram
      if (entry.animPath) {
        const caption = `🎬 Scene ${sceneNum}/${validScenes.length} (${scene.speaker}, ${scene.emotion})\nDuration: 10s | Resolution: 1080p\n${scene.visual_description?.slice(0, 200) || ''}`;
        await sendApprovalBotMedia({ filePath: entry.animPath, type: 'video', caption });
      }

      // Send approve/reject buttons (prefixed callback)
      const callbackPrefix = `s5_${sceneNum}`;
      const telegramMessageId = await sendTelegramMessageWithButtons(
        `🎬 Scene ${sceneNum}/${validScenes.length} Animation Review\nApprove or reject with feedback to regenerate`,
        callbackPrefix
      );

      // Wait for response from Telegram
      const decision = await waitForTelegramResponse(telegramMessageId, callbackPrefix);

      if (decision.approved) {
        approvedAnims[sceneNum] = { approved: true };
        approved = true;
        console.log(`  ✓ Scene ${sceneNum} animation approved`);
      } else {
        console.log(`  ✗ Scene ${sceneNum} animation rejected: ${decision.comment}`);

        // Refine Wan prompt based on feedback, then regenerate
        const currentPrompt = buildWanPrompt(scene, artStyle, aspectRatio);
        const refinedPrompt = decision.comment
          ? await refineWanPrompt(currentPrompt, decision.comment)
          : currentPrompt;
        console.log(`  ↩️  Regenerating scene ${sceneNum} animation with refined prompt...`);
        try {
          const regen = await animateScene({
            taskId, scene,
            imagePath: sceneImagePaths[sceneNum]?.imagePath,
            storagePath: sceneImagePaths[sceneNum]?.storagePath,
            characterMap, tmpDir, tracker, artStyle, aspectRatio,
            promptOverride: refinedPrompt,
          });
          sceneAnimPaths[sceneNum] = { animPath: regen.animPath, storagePath: regen.storagePath };
        } catch (regenErr) {
          console.warn(`  ⚠️  Regeneration failed: ${regenErr.message} — using static fallback`);
          const localImagePath = await ensureLocalImagePath({
            imagePath: sceneImagePaths[sceneNum]?.imagePath,
            storagePath: sceneImagePaths[sceneNum]?.storagePath,
            sceneNumber: sceneNum, tmpDir,
          });
          const fallback = await staticImageFallback({ taskId, scene, imagePath: localImagePath, storagePath: sceneImagePaths[sceneNum]?.storagePath, tmpDir, tracker, videoType });
          sceneAnimPaths[sceneNum] = { animPath: fallback.animPath, storagePath: fallback.storagePath };
        }
      }

      // Save intermediate state for resume safety
      await sb.from('video_pipeline_runs').upsert({
        task_id: taskId,
        stage: STAGE,
        status: 'in_progress',
        pipeline_state: { ...state, sceneAnimPaths, approvedAnims },
      }, { onConflict: 'task_id,stage' });
    }

    // Delay before next Wan job
    if (i < validScenes.length - 1) {
      await new Promise(r => setTimeout(r, WAN_INTER_JOB_DELAY_MS));
    }
  }

  console.log(`✅ Stage 5 complete. ${Object.keys(sceneAnimPaths).length}/${validScenes.length} scenes animated`);
  return { ...state, sceneAnimPaths, approvedAnims };
}

async function animateScene({ taskId, scene, imagePath, storagePath, characterMap, tmpDir, tracker, artStyle, aspectRatio = '16:9', promptOverride = null }) {
  if (!storagePath) throw new Error(`No storage path for scene ${scene.scene_number}`);

  // Use override prompt if provided (from feedback refinement), otherwise build fresh
  const prompt = promptOverride || buildWanPrompt(scene, artStyle, aspectRatio);
  console.log(`  Submitting Wan 2.6 job for scene ${scene.scene_number}...`);
  console.log(`  Prompt: ${prompt}`);

  let currentImagePath = imagePath;
  let currentStoragePath = storagePath;

  const imageUrl = await resolveSignedUrl(currentStoragePath, scene.scene_number);
  const wanTaskId = await withRetry(
    () => submitWanJob({ imageUrl, prompt, aspectRatio }),
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
async function regenerateSafeImage({ taskId, scene, characterMap, tmpDir, tracker, aspectRatio = '9:16' }) {
  // Look up character by scene.speaker (flat format — no scene.lines)
  const character = characterMap?.[scene.speaker]
    ?? characterMap?.[scene.speaker?.toUpperCase()]
    ?? characterMap?.['NARRATOR']
    ?? null;

  const extraSuffix = 'minimal characters, simple background, no physical contact between characters, wide shot, child-friendly';
  const prompt = buildScenePrompt(scene, character, { extraSuffix, aspectRatio });

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
async function staticImageFallback({ taskId, scene, imagePath, storagePath, tmpDir, tracker, videoType }) {
  const scenesDir = join(tmpDir, 'scenes');
  await fs.mkdir(scenesDir, { recursive: true });
  const animPath = join(scenesDir, `scene_${String(scene.scene_number).padStart(2, '0')}_anim.mp4`);

  await stillImageToVideo({ imagePath, duration: 10, outputPath: animPath, videoType });

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

