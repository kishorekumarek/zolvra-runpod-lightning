// stages/stage-07-assemble.mjs — Simple 1:1 scene assembly (clip + audio → final)
// Auto-stage — checks isFeedbackCollectionMode()
import 'dotenv/config';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode } from '../lib/settings.mjs';
import { createNexusCard } from '../lib/nexus-client.mjs';
import {
  getDurationSeconds,
  assembleVideo,
  stillImageToVideo,
  FFMPEG,
  FFPROBE,
} from '../lib/ffmpeg.mjs';
import { getSfxPath } from '../lib/sfx-mixer.mjs';
import { getBgmPath } from '../lib/bgm-selector.mjs';

const STAGE = 7;

/**
 * Merge a video clip with audio using full clip duration.
 * Voice + SFX loop + BGM segment mixed via filter_complex when available.
 * Audio is overlaid within the clip window; remaining clip plays silently (ambient fills it).
 */
function mergeClipWithAudio({ clipPath, audioPath, sfxPath, bgmPath, bgmOffset, outputPath }) {
  const clipDuration = getDurationSeconds(clipPath);
  const audioDuration = getDurationSeconds(audioPath);
  const sceneDur = Math.max(clipDuration, audioDuration);

  if (sfxPath && bgmPath) {
    // 3-audio mix: voice (1.0) + SFX loop (0.3) + BGM segment (0.12)
    // input 0: video (stream_loop -1)
    // input 1: voice audio
    // input 2: SFX (stream_loop -1)
    // input 3: BGM (stream_loop -1, seek to bgmOffset)
    const fc = [
      `[1:a]volume=1.0[voice]`,
      `[2:a]atrim=duration=${sceneDur},asetpts=PTS-STARTPTS,volume=0.3[sfx]`,
      `[3:a]atrim=duration=${sceneDur},asetpts=PTS-STARTPTS,volume=0.12[bgm]`,
      `[voice][sfx][bgm]amix=inputs=3:duration=longest[aout]`,
    ].join(';');

    const cmd = [
      `"${FFMPEG}" -y`,
      `-stream_loop -1 -i "${clipPath}"`,
      `-i "${audioPath}"`,
      `-stream_loop -1 -i "${sfxPath}"`,
      `-ss ${bgmOffset.toFixed(3)} -stream_loop -1 -i "${bgmPath}"`,
      `-t ${sceneDur}`,
      `-map 0:v`,
      `-filter_complex "${fc}"`,
      `-map "[aout]"`,
      `-c:v libx264 -preset fast -crf 22`,
      `-c:a aac -b:a 192k`,
      `"${outputPath}"`,
    ].join(' ');
    execSync(cmd, { stdio: 'pipe' });
  } else {
    // Fallback: voice only, loop clip to cover full scene duration
    const cmd = [
      `"${FFMPEG}" -y`,
      `-stream_loop -1 -i "${clipPath}"`,
      `-i "${audioPath}"`,
      `-t ${sceneDur}`,
      `-map 0:v -map 1:a`,
      `-c:v libx264 -preset fast -crf 22`,
      `-c:a aac -b:a 192k`,
      `"${outputPath}"`,
    ].join(' ');
    execSync(cmd, { stdio: 'pipe' });
  }

  return sceneDur;
}

/**
 * Apply continuous BGM over the final concatenated video.
 * Loops BGM to fill full duration, vol 0.1, fade in 2s, fade out 3s.
 */
function applyFinalBgm({ inputPath, bgmPath, outputPath }) {
  const totalDuration = getDurationSeconds(inputPath);
  const fadeOutStart = Math.max(0, totalDuration - 3);

  const fc = [
    `[1:a]volume=0.1,afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=3[bgm_faded]`,
    `[0:a][bgm_faded]amix=inputs=2:duration=first[aout]`,
  ].join(';');

  const cmd = [
    `"${FFMPEG}" -y`,
    `-i "${inputPath}"`,
    `-stream_loop -1 -i "${bgmPath}"`,
    `-t ${totalDuration}`,
    `-filter_complex "${fc}"`,
    `-map 0:v -map "[aout]"`,
    `-c:v copy -c:a aac -b:a 192k`,
    `"${outputPath}"`,
  ].join(' ');
  execSync(cmd, { stdio: 'pipe' });
}

/**
 * Stage 7: Simple paired assembly.
 * For each scene N: clip + audio (+ SFX + BGM segment) → scene_N_final.mp4 (full clip duration).
 * Then concat all scene finals → concat.mp4 → apply continuous BGM → final.mp4.
 */
export async function runStage7(taskId, tracker, state = {}) {
  console.log('🎞️  Stage 7: Video assembly...');

  const { scenes, sceneImagePaths, sceneAnimPaths, sceneAudioPaths, tmpDir, parentCardId } = state;
  if (!scenes) throw new Error('Stage 7: scenes not found');
  if (!tmpDir) throw new Error('Stage 7: tmpDir not found');

  const sb = getSupabase();
  const assemblyDir = join(tmpDir, 'assembly');
  await fs.mkdir(assemblyDir, { recursive: true });

  const bgmPath = getBgmPath();
  if (bgmPath) {
    console.log(`  🎵 BGM: ${bgmPath}`);
  } else {
    console.warn('  ⚠️  No BGM found — skipping BGM mix');
  }

  const sceneFinalPaths = []; // ordered list of assembled scene paths
  let bgmOffset = 0; // cumulative BGM offset across scenes

  for (const scene of scenes) {
    const sceneNum = scene.scene_number;
    const sceneLabel = String(sceneNum).padStart(2, '0');

    const audioPath = sceneAudioPaths?.[sceneNum];
    if (!audioPath) {
      console.warn(`  ⚠️  No audio for scene ${sceneNum} — skipping`);
      continue;
    }

    const animPath = sceneAnimPaths?.[sceneNum]?.animPath ?? null;
    const imagePath = sceneImagePaths?.[sceneNum]?.imagePath ?? null;

    // Resolve SFX for this scene's environment
    const environment = scene.environment || 'forest_day';
    const sfxPath = getSfxPath(environment);

    const finalPath = join(assemblyDir, `scene_${sceneLabel}_final.mp4`);

    if (animPath) {
      const clipDuration = getDurationSeconds(animPath);
      console.log(`  🔧 Scene ${sceneNum}: merging clip + audio + SFX[${environment}] (clip ${clipDuration.toFixed(1)}s)...`);
      const sceneDur = mergeClipWithAudio({
        clipPath: animPath,
        audioPath,
        sfxPath,
        bgmPath,
        bgmOffset,
        outputPath: finalPath,
      });
      bgmOffset += sceneDur;
    } else if (imagePath) {
      // No animation — use still image + audio (zoompan)
      const audioDuration = getDurationSeconds(audioPath);
      console.log(`  🖼️  Scene ${sceneNum}: still image + audio (${audioDuration.toFixed(1)}s)...`);
      await stillImageToVideo({ imagePath, audioPath, outputPath: finalPath });
      bgmOffset += getDurationSeconds(finalPath);
    } else {
      console.warn(`  ⚠️  Scene ${sceneNum}: no clip or image — skipping`);
      continue;
    }

    sceneFinalPaths.push(finalPath);
    console.log(`  ✓ Scene ${sceneNum} assembled`);
  }

  if (sceneFinalPaths.length === 0) {
    throw new Error('No scenes were assembled — cannot create final video');
  }

  // Concatenate all scene finals into one video
  console.log(`  📼 Concatenating ${sceneFinalPaths.length} scenes...`);
  const concatPath = join(assemblyDir, 'concat.mp4');

  await assembleVideo({
    sceneCombinedPaths: sceneFinalPaths,
    musicPath: null,
    outputPath: concatPath,
  });

  // Apply continuous BGM overlay (vol 0.1, fade in 2s, fade out 3s)
  const finalPath = join(assemblyDir, 'final.mp4');
  if (bgmPath) {
    console.log('  🎵 Applying continuous BGM overlay...');
    applyFinalBgm({ inputPath: concatPath, bgmPath, outputPath: finalPath });
    await fs.unlink(concatPath).catch(() => {});
  } else {
    await fs.rename(concatPath, finalPath);
  }

  const duration = getDurationSeconds(finalPath);
  console.log(`  ✓ Final video: ${duration.toFixed(1)}s`);

  // Feedback collection mode — review assembled video
  if (await isFeedbackCollectionMode()) {
    await feedbackReviewAssembly({ taskId, finalPath, duration, parentCardId, sb });
  }

  console.log(`✅ Stage 7 complete. Final video: ${finalPath}`);
  return { ...state, finalVideoPath: finalPath, finalDurationSeconds: duration };
}

async function feedbackReviewAssembly({ taskId, finalPath, duration, parentCardId, sb }) {
  console.log('  📋 Feedback collection mode: requesting assembly review...');

  const cardId = await createNexusCard({
    title: `[Feedback] Stage 7: Assembled Video Review`,
    description: [
      `Feedback collection mode: Please review the assembled video before upload.`,
      `\n**File:** ${finalPath}`,
      `**Duration:** ${duration.toFixed(1)}s`,
      `\nApprove to upload to YouTube (unlisted), or Request Changes.`,
    ].join('\n'),
    task_type: 'stage_review',
    priority: 'medium',
    parent_id: parentCardId,
    stream: 'youtube',
  });

  console.log(`  NEXUS assembly review card created: ${cardId} (non-blocking)`);
}
