// stages/stage-07-assemble.mjs — Simple 1:1 scene assembly (clip + audio → final)
// Auto-stage — checks isFeedbackCollectionMode()
import 'dotenv/config';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode, getVideoType } from '../lib/settings.mjs';
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
function mergeClipWithAudio({ clipPath, audioPath, sfxPath, bgmPath, bgmOffset, outputPath, videoType = 'long' }) {
  const clipDuration = getDurationSeconds(clipPath);
  const audioDuration = getDurationSeconds(audioPath);
  const sceneDur = audioDuration > 0 ? audioDuration : clipDuration;

  // Scale/crop filter depends on video format
  const scaleFilter = videoType === 'short'
    ? 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'
    : 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720';

  if (sfxPath && bgmPath) {
    // 3-audio mix: voice (1.0) + SFX loop (0.3) + BGM segment (0.12)
    // input 0: video (stream_loop -1)
    // input 1: voice audio
    // input 2: SFX (stream_loop -1)
    // input 3: BGM (stream_loop -1, seek to bgmOffset)
    const fc = [
      `[0:v]${scaleFilter}[vout]`,
      `[1:a]volume=1.0[voice]`,
      `[2:a]atrim=duration=${sceneDur},asetpts=PTS-STARTPTS,volume=0.3[sfx]`,
      `[3:a]atrim=duration=${sceneDur},asetpts=PTS-STARTPTS,volume=0.12[bgm]`,
      `[voice][sfx][bgm]amix=inputs=3:duration=longest[aout]`,
    ].join(';');

    const cmd = [
      `"${FFMPEG}" -y`,
      `-i "${clipPath}"`,
      `-i "${audioPath}"`,
      `-stream_loop -1 -i "${sfxPath}"`,
      `-ss ${bgmOffset.toFixed(3)} -stream_loop -1 -i "${bgmPath}"`,
      `-t ${sceneDur}`,
      `-filter_complex "${fc}"`,
      `-map "[vout]"`,
      `-map "[aout]"`,
      `-c:v libx264 -preset fast -crf 22`,
      `-c:a aac -b:a 192k`,
      `"${outputPath}"`,
    ].join(' ');
    execSync(cmd, { stdio: 'pipe' });
  } else {
    // Fallback: voice only, clip plays once trimmed to audio duration
    const cmd = [
      `"${FFMPEG}" -y`,
      `-i "${clipPath}"`,
      `-i "${audioPath}"`,
      `-t ${sceneDur}`,
      `-map 0:v -map 1:a`,
      `-vf "${scaleFilter}"`,
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

  const videoType = state.videoType ?? await getVideoType(); // 'long' | 'short'
  console.log(`  video_type=${videoType}`);

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
        videoType,
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

  // Concatenate all scene finals — plain concat (no transitions)
  console.log(`  📼 Concat ${sceneFinalPaths.length} scenes (plain)...`);
  const concatPath = join(assemblyDir, 'concat.mp4');
  await assembleVideo({ sceneCombinedPaths: sceneFinalPaths, outputPath: concatPath });

  // Apply continuous BGM overlay (vol 0.1, fade in 2s, fade out 3s)
  const finalPath = join(assemblyDir, 'final.mp4');
  if (bgmPath) {
    console.log('  🎵 Applying continuous BGM overlay...');
    applyFinalBgm({ inputPath: concatPath, bgmPath, outputPath: finalPath });
    await fs.unlink(concatPath).catch(() => {});
  } else {
    await fs.rename(concatPath, finalPath);
  }

  const preFinalDuration = getDurationSeconds(finalPath);
  console.log(`  ✓ Pre-final video: ${preFinalDuration.toFixed(1)}s`);

  // Logo overlay (top-right, ~12% of video width, 20px padding)
  const logoPath = join(import.meta.dirname, '..', 'assets', 'channel-logo.png');
  let logoApplied = false;
  try {
    await fs.access(logoPath);
    const withLogoPath = join(assemblyDir, 'with-logo.mp4');
    // Get video width for logo scaling
    const dims = execSync(
      `"${FFPROBE}" -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "${finalPath}"`
    ).toString().trim();
    const vidW = parseInt(dims) || 1080;
    const logoW = Math.round(vidW * 0.12);
    execSync([
      `"${FFMPEG}" -y`,
      `-i "${finalPath}"`,
      `-i "${logoPath}"`,
      `-filter_complex "[1:v]scale=${logoW}:-1[logo];[0:v][logo]overlay=W-w-20:20[vout]"`,
      `-map "[vout]" -map 0:a`,
      `-c:v libx264 -preset fast -crf 23 -c:a copy`,
      `"${withLogoPath}"`,
    ].join(' '), { stdio: 'pipe' });
    await fs.unlink(finalPath).catch(() => {});
    await fs.rename(withLogoPath, finalPath);
    logoApplied = true;
    console.log(`  🏷️  Logo overlay applied (${logoW}px, top-right)`);
  } catch {
    console.warn('  ⚠️  Logo file not found — skipping overlay');
  }

  // End card (append shorts_end_card.mp4 + end_card_audio.mp3 if they exist)
  const endCardVideoPath = join(import.meta.dirname, '..', 'assets', 'shorts_end_card.mp4');
  const endCardAudioPath = join(import.meta.dirname, '..', 'assets', 'end_card_audio.mp3');
  let endCardAppended = false;
  try {
    await fs.access(endCardVideoPath);
    await fs.access(endCardAudioPath);

    // Get main video dimensions for end card scaling
    const mainDims = execSync(
      `"${FFPROBE}" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${finalPath}"`
    ).toString().trim().split(',');
    const [mW, mH] = mainDims.map(Number);

    // Re-encode end card to match main video
    const endCardReencoded = join(assemblyDir, 'end-card-reencoded.mp4');
    execSync([
      `"${FFMPEG}" -y`,
      `-i "${endCardVideoPath}"`,
      `-i "${endCardAudioPath}"`,
      `-map 0:v -map 1:a`,
      `-c:v libx264 -preset fast -crf 23`,
      `-vf "scale=${mW}:${mH}:force_original_aspect_ratio=decrease,pad=${mW}:${mH}:(ow-iw)/2:(oh-ih)/2"`,
      `-c:a aac -b:a 128k -r 30`,
      `"${endCardReencoded}"`,
    ].join(' '), { stdio: 'pipe' });

    // Re-encode main to ensure matching params for concat
    const mainReencoded = join(assemblyDir, 'main-reencoded.mp4');
    execSync([
      `"${FFMPEG}" -y`,
      `-i "${finalPath}"`,
      `-c:v libx264 -preset fast -crf 23 -r 30`,
      `-c:a aac -b:a 128k`,
      `"${mainReencoded}"`,
    ].join(' '), { stdio: 'pipe' });

    // Concat main + end card
    const concatEndPath = join(assemblyDir, 'concat-end.txt');
    await fs.writeFile(concatEndPath, `file '${mainReencoded}'\nfile '${endCardReencoded}'\n`);
    const withEndCardPath = join(assemblyDir, 'with-endcard.mp4');
    execSync(`"${FFMPEG}" -y -f concat -safe 0 -i "${concatEndPath}" -c copy "${withEndCardPath}"`, { stdio: 'pipe' });

    // Fix sync drift with -shortest
    const syncedPath = join(assemblyDir, 'synced-final.mp4');
    execSync([
      `"${FFMPEG}" -y`,
      `-i "${withEndCardPath}"`,
      `-c:v libx264 -preset fast -crf 23`,
      `-c:a aac -b:a 128k -shortest`,
      `"${syncedPath}"`,
    ].join(' '), { stdio: 'pipe' });

    await fs.unlink(finalPath).catch(() => {});
    await fs.rename(syncedPath, finalPath);
    endCardAppended = true;
    console.log('  📌 End card appended + sync fixed');
  } catch (err) {
    console.warn(`  ⚠️  End card not appended: ${err.message}`);
  }

  const duration = getDurationSeconds(finalPath);
  console.log(`  ✓ Final video: ${duration.toFixed(1)}s (logo: ${logoApplied ? '✅' : '❌'}, end card: ${endCardAppended ? '✅' : '❌'})`);

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
