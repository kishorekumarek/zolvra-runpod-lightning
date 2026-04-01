// stages/stage-05-animate.mjs — Wan 2.6 image-to-video per scene
// REWRITTEN for pipeline schema rewrite: reads from DB, writes to scenes table.
// Dual-write: returns old sceneAnimPaths for un-rewritten Stage 7.
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { isFeedbackCollectionMode, getSetting } from '../lib/settings.mjs';
import { sendTelegramMessage, sendTelegramMessageWithButtons, sendApprovalBotMedia, waitForTelegramResponse } from '../lib/telegram.mjs';
import * as kieaiWan from '../lib/wan.mjs';
import * as runpodWan from '../lib/runpod-wan.mjs';
import { uploadSceneAnimation, getSignedUrl, downloadFromStorage, BUCKETS } from '../lib/storage.mjs';
import { stillImageToVideo } from '../lib/ffmpeg.mjs';
import { withRetry } from '../lib/retry.mjs';
import { calcAnimationCost } from '../lib/cost-tracker.mjs';
import { callClaude } from '../../shared/claude.mjs';
import { getVideoConfig } from '../lib/video-config.mjs';
import {
  getPipelineState, getConcept, getScenes, updateScene,
} from '../lib/pipeline-db.mjs';

async function getAnimationProvider(videoType = 'short') {
  // 1. Env var takes precedence — allows per-process override without touching DB
  const envFlag = process.env.USE_RUNPOD;
  if (envFlag === 'true' || envFlag === '1') return runpodWan;
  if (envFlag === 'false' || envFlag === '0') return kieaiWan;

  // 2. Fall back to DB setting (pipeline_settings.animation_provider_*)
  try {
    const key = videoType === 'short' ? 'animation_provider_short' : 'animation_provider_long';
    const provider = await getSetting(key);
    if (provider === 'runpod') return runpodWan;
    if (provider === 'kieai') return kieaiWan;
  } catch {}

  // 3. Safe default: kie.ai
  return kieaiWan;
}

const STAGE = 5;
const STAGE_ID = 'animate';
const NSFW_HALT_RATIO = 0.8;
const WAN_INTER_JOB_DELAY_MS = 10000;

/**
 * Build a concise animation prompt from scene data (max ~300 chars).
 */
function buildWanPrompt(scene, artStyle = '3D Pixar animation style', aspectRatio = '16:9') {
  const setting   = scene.environment || 'Tamil village';
  const speaker   = scene.speaker   || 'characters';
  const emotion   = scene.emotion   || 'happy';
  const descSnip  = (scene.visual_description || '').slice(0, 150).replace(/\n/g, ' ').trim();
  const orientation = aspectRatio === '9:16' ? '9:16 vertical portrait' : '16:9 widescreen';

  const prompt = `${setting} scene, ${emotion} mood, ${orientation}. ${speaker}: ${descSnip}. Smooth animation, ${artStyle}, natural fluid motion, dynamic movement, warm cinematic lighting, child-friendly.`;
  return prompt.slice(0, 300);
}

/**
 * Refine a Wan animation prompt based on reviewer feedback via Claude.
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
    return refined.slice(0, 300);
  } catch (err) {
    console.warn(`  ⚠️  Wan prompt refinement failed: ${err.message} — reusing previous prompt`);
    return currentPrompt;
  }
}

/**
 * Stage 5: Animate each scene with Wan 2.6 image-to-video.
 *
 * NEW: reads scenes (image_url) from DB, writes animation_url to scenes table.
 * Writes animation_url/animation_status/animation_approved to scenes table.
 */
export async function runStage5(taskId, tracker, state = {}) {
  console.log('🎬 Stage 5: Scene animation (Wan 2.6)...');

  // ── Read from DB ───────────────────────────────────────────────────
  const ps = await getPipelineState(taskId);
  if (!ps?.concept_id) throw new Error('Stage 5: pipeline_state not found or missing concept_id');

  const concept = await getConcept(ps.concept_id);
  const videoType = concept.video_type || 'short';
  const artStyle = concept.art_style || '3D Pixar animation style';
  const aspectRatio = getVideoConfig(videoType).aspectRatio;

  const allScenes = await getScenes(taskId);
  if (!allScenes || allScenes.length === 0) throw new Error('Stage 5: no scenes found in DB');

  // Only animate scenes that have images
  const validScenes = allScenes.filter(s => s.image_url);

  const tmpDir = state.tmpDir || `/tmp/zolvra-pipeline/${taskId}`;
  await fs.mkdir(join(tmpDir, 'scenes'), { recursive: true });

  const sceneAnimPaths = {}; // local paths for within-run use only
  const approvedAnims = {};

  const feedbackMode = await isFeedbackCollectionMode();
  let failureCount = 0;

  if (feedbackMode) {
    await sendTelegramMessage(`🎬 Stage 5: Animating ${validScenes.length} scenes (one at a time with approval)`);
  }

  for (let i = 0; i < validScenes.length; i++) {
    const scene = validScenes[i];
    const sceneNum = scene.scene_number;

    // Skip already-completed (resume from DB)
    if (scene.animation_status === 'completed') {
      sceneAnimPaths[sceneNum] = { animPath: null, storagePath: scene.animation_url };
      approvedAnims[sceneNum] = { approved: true };
      console.log(`  Scene ${sceneNum}: animation already completed — skipping`);
      continue;
    }

    // Generate animation
    let animResult;
    try {
      animResult = await animateScene({
        taskId, scene,
        storagePath: scene.image_url,
        tmpDir, tracker, artStyle, aspectRatio, videoType,
      });
      sceneAnimPaths[sceneNum] = { animPath: animResult.animPath, storagePath: animResult.storagePath };
    } catch (err) {
      failureCount++;
      console.warn(`  ⚠️  Scene ${sceneNum} animation failed: ${err.message}`);

      // Try static fallback
      try {
        const localImagePath = await ensureLocalImagePath({
          storagePath: scene.image_url,
          sceneNumber: sceneNum, tmpDir,
        });
        const fallback = await staticImageFallback({ taskId, scene, imagePath: localImagePath, storagePath: scene.image_url, tmpDir, tracker, videoType });
        sceneAnimPaths[sceneNum] = { animPath: fallback.animPath, storagePath: fallback.storagePath };
        animResult = fallback;
      } catch (fallbackErr) {
        console.warn(`  ⚠️  Scene ${sceneNum} static fallback also failed: ${fallbackErr.message}`);
        await sendTelegramMessage(`⚠️ Manual animation needed: Scene ${sceneNum}\nAnimation failed: ${err.message}\nFallback failed: ${fallbackErr.message}`);
        await updateScene(taskId, sceneNum, { animation_status: 'failed' });
        if (failureCount / validScenes.length > NSFW_HALT_RATIO) {
          throw new Error(`Too many animation failures (${failureCount}/${validScenes.length})`);
        }
        continue;
      }
    }

    if (!feedbackMode) {
      approvedAnims[sceneNum] = { approved: true };
      await updateScene(taskId, sceneNum, { animation_approved: true });
      if (i < validScenes.length - 1) await new Promise(r => setTimeout(r, WAN_INTER_JOB_DELAY_MS));
      continue;
    }

    // Feedback mode — send for approval
    let approved = false;
    while (!approved) {
      const entry = sceneAnimPaths[sceneNum];

      if (entry.animPath) {
        const caption = `🎬 Scene ${sceneNum}/${validScenes.length} (${scene.speaker}, ${scene.emotion})\nDuration: 10s | Resolution: 1080p\n${scene.visual_description?.slice(0, 200) || ''}`;
        await sendApprovalBotMedia({ filePath: entry.animPath, type: 'video', caption });
      }

      const callbackPrefix = `s5_${sceneNum}`;
      const telegramMessageId = await sendTelegramMessageWithButtons(
        `🎬 Scene ${sceneNum}/${validScenes.length} Animation Review\nApprove or reject with feedback to regenerate`,
        callbackPrefix
      );

      const decision = await waitForTelegramResponse(telegramMessageId, callbackPrefix);

      if (decision.approved) {
        approvedAnims[sceneNum] = { approved: true };
        await updateScene(taskId, sceneNum, { animation_approved: true });
        approved = true;
        console.log(`  ✓ Scene ${sceneNum} animation approved`);
      } else {
        console.log(`  ✗ Scene ${sceneNum} animation rejected: ${decision.comment}`);

        const currentPrompt = buildWanPrompt(scene, artStyle, aspectRatio);
        const refinedPrompt = decision.comment
          ? await refineWanPrompt(currentPrompt, decision.comment)
          : currentPrompt;
        console.log(`  ↩️  Regenerating scene ${sceneNum} animation with refined prompt...`);
        try {
          const regen = await animateScene({
            taskId, scene,
            storagePath: scene.image_url,
            tmpDir, tracker, artStyle, aspectRatio, videoType,
            promptOverride: refinedPrompt,
          });
          sceneAnimPaths[sceneNum] = { animPath: regen.animPath, storagePath: regen.storagePath };
        } catch (regenErr) {
          console.warn(`  ⚠️  Regeneration failed: ${regenErr.message} — using static fallback`);
          const localImagePath = await ensureLocalImagePath({
            storagePath: scene.image_url,
            sceneNumber: sceneNum, tmpDir,
          });
          const fallback = await staticImageFallback({ taskId, scene, imagePath: localImagePath, storagePath: scene.image_url, tmpDir, tracker, videoType });
          sceneAnimPaths[sceneNum] = { animPath: fallback.animPath, storagePath: fallback.storagePath };
        }
      }
    }

    // Delay before next Wan job
    if (i < validScenes.length - 1) {
      await new Promise(r => setTimeout(r, WAN_INTER_JOB_DELAY_MS));
    }
  }

  console.log(`✅ Stage 5 complete. ${Object.keys(sceneAnimPaths).length}/${validScenes.length} scenes animated`);

}

async function animateScene({ taskId, scene, storagePath, tmpDir, tracker, artStyle, aspectRatio = '16:9', videoType = 'short', promptOverride = null }) {
  if (!storagePath) throw new Error(`No storage path for scene ${scene.scene_number}`);

  const prompt = promptOverride || buildWanPrompt(scene, artStyle, aspectRatio);
  const wan = await getAnimationProvider(videoType);
  const providerLabel = wan === runpodWan ? 'RunPod Wan 2.2' : 'Wan 2.6 (kie.ai)';
  console.log(`  Submitting ${providerLabel} job for scene ${scene.scene_number}...`);
  console.log(`  Prompt: ${prompt}`);

  const imageUrl = await resolveSignedUrl(storagePath, scene.scene_number);

  const wanTaskId = await withRetry(
    () => wan.submitWanJob({ imageUrl, prompt, aspectRatio }),
    { maxRetries: 3, baseDelayMs: 30000, stage: STAGE, taskId }
  );
  const videoUrl = await withRetry(
    () => wan.pollWanJob(wanTaskId, 600000),
    { maxRetries: 2, baseDelayMs: 15000, stage: STAGE, taskId }
  );
  const videoBuffer = await wan.downloadWanVideo(videoUrl);

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

  // Write to scenes table
  await updateScene(taskId, scene.scene_number, {
    animation_url: animStoragePath,
    animation_status: 'completed',
  });

  const providerName = wan === runpodWan ? 'runpod' : 'kieai';
  const cost = calcAnimationCost(1, providerName);
  tracker.addCost(STAGE, cost);

  console.log(`  ✓ Scene ${scene.scene_number} animated via ${providerLabel} ($${cost.toFixed(4)})`);
  return { scene, animPath, storagePath: animStoragePath };
}

async function ensureLocalImagePath({ storagePath, sceneNumber, tmpDir }) {
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

  // Write to scenes table
  await updateScene(taskId, scene.scene_number, {
    animation_url: animStoragePath,
    animation_status: 'completed',
  });

  console.log(`  ✓ Scene ${scene.scene_number} using static fallback (freeze frame, 10s)`);
  return { scene, animPath, storagePath: animStoragePath };
}
