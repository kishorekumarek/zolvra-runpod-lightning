// stages/stage-07-assemble.mjs — Simple 1:1 scene assembly (clip + audio → final)
// Auto-stage — checks isFeedbackCollectionMode()
import 'dotenv/config';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode, getVideoType } from '../lib/settings.mjs';
import { sendTelegramMessage } from '../lib/telegram.mjs';
import { getVideoConfig } from '../lib/video-config.mjs';
import {
  getDurationSeconds,
  assembleVideo,
  stillImageToVideo,
  loopVideoToFill,
  FFMPEG,
  FFPROBE,
} from '../lib/ffmpeg.mjs';
import { getSfxPath } from '../lib/sfx-mixer.mjs';
import { getBgmPath } from '../lib/bgm-selector.mjs';
import { callClaude } from '../../shared/claude.mjs';
import { downloadFromStorage, BUCKETS } from '../lib/storage.mjs';

const STAGE = 7;

/**
 * Merge a video clip with audio using full clip duration.
 * Voice + SFX loop mixed via filter_complex. BGM is applied once on the final
 * concatenated video by applyFinalBgm (not per-scene, to avoid double BGM).
 *
 * Handles duration mismatches:
 * - Audio > Video (>0.5s): ping-pong loops the clip to fill audio duration
 * - Video > Audio (>0.5s): pads voice with silence, SFX continues as ambient bed
 */
async function mergeClipWithAudio({ clipPath, audioPath, sfxPath, outputPath, videoType = 'long' }) {
  const clipDuration = getDurationSeconds(clipPath);
  const audioDuration = getDurationSeconds(audioPath);
  const sceneDur = audioDuration > 0 ? audioDuration : clipDuration;

  // Scale/crop filter depends on video format
  const vScale = getVideoConfig(videoType).videoScale;
  const scaleFilter = `scale=${vScale}:force_original_aspect_ratio=increase,crop=${vScale}`;

  // Case 3: Audio > Video — ping-pong loop the clip
  let effectiveClipPath = clipPath;
  let loopedPath = null;
  if (audioDuration > clipDuration + 0.5) {
    console.log(`    🔁 Simple looping clip (${clipDuration.toFixed(1)}s → ${sceneDur.toFixed(1)}s)`);
    loopedPath = await loopVideoToFill({ inputPath: clipPath, outputPath: clipPath.replace('.mp4', '_looped.mp4'), targetDuration: sceneDur });
    effectiveClipPath = loopedPath;
  }

  try {
    if (sfxPath) {
      let fc;
      if (clipDuration > audioDuration + 0.5 && audioDuration > 0) {
        // Case 2: Video > Audio — pad voice with silence, SFX as ambient bed
        fc = [
          `[0:v]${scaleFilter}[vout]`,
          `[1:a]volume=1.0,apad=whole_dur=${sceneDur}[voice_padded]`,
          `[2:a]atrim=duration=${sceneDur},asetpts=PTS-STARTPTS,volume=0.15[sfx]`,
          `[voice_padded][sfx]amix=inputs=2:duration=longest:normalize=0[aout]`,
        ].join(';');
      } else {
        // Normal or small difference: standard mix
        fc = [
          `[0:v]${scaleFilter}[vout]`,
          `[1:a]volume=1.0[voice]`,
          `[2:a]atrim=duration=${sceneDur},asetpts=PTS-STARTPTS,volume=0.15[sfx]`,
          `[voice][sfx]amix=inputs=2:duration=longest:normalize=0[aout]`,
        ].join(';');
      }

      const cmd = [
        `"${FFMPEG}" -y`,
        `-i "${effectiveClipPath}"`,
        `-i "${audioPath}"`,
        `-stream_loop -1 -i "${sfxPath}"`,
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
      // Fallback: voice only, pad with silence if video > audio
      let audioFilter;
      if (clipDuration > audioDuration + 0.5 && audioDuration > 0) {
        audioFilter = `-filter_complex "[1:a]apad=whole_dur=${sceneDur}[aout]" -map 0:v -map "[aout]" -vf "${scaleFilter}"`;
      } else {
        audioFilter = `-map 0:v -map 1:a -vf "${scaleFilter}"`;
      }

      const cmd = [
        `"${FFMPEG}" -y`,
        `-i "${effectiveClipPath}"`,
        `-i "${audioPath}"`,
        `-t ${sceneDur}`,
        audioFilter,
        `-c:v libx264 -preset fast -crf 22`,
        `-c:a aac -b:a 192k`,
        `"${outputPath}"`,
      ].join(' ');
      execSync(cmd, { stdio: 'pipe' });
    }
  } finally {
    // Clean up ping-pong temp file
    if (loopedPath) {
      await fs.unlink(loopedPath).catch(() => {});
    }
  }

  return sceneDur;
}

/**
 * Assign environment tags to scenes using Claude Haiku.
 * Maps visual_description + emotion → one of 7 environment categories for SFX selection.
 */
async function assignSceneEnvironments(scenes) {
  const VALID_ENVS = ['forest_day', 'forest_rain', 'river', 'village', 'night', 'sky', 'crowd_children'];

  try {
    const sceneDescriptions = scenes.map(s => ({
      scene_number: s.scene_number,
      visual_description: s.visual_description || '',
      emotion: s.emotion || '',
    }));

    const response = await callClaude({
      system: `You classify animated story scenes into environment categories for sound effects.
Return ONLY a JSON array of objects with scene_number and environment.
Valid environments: ${VALID_ENVS.join(', ')}
Choose the best match based on the visual description and emotion.`,
      messages: [{
        role: 'user',
        content: `Classify these scenes:\n${JSON.stringify(sceneDescriptions, null, 2)}`,
      }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 1024,
    });

    const text = response.content[0]?.text || '';
    // Extract JSON array from response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in response');

    const assignments = JSON.parse(jsonMatch[0]);
    let assigned = 0;
    for (const a of assignments) {
      const scene = scenes.find(s => s.scene_number === a.scene_number);
      if (scene && VALID_ENVS.includes(a.environment)) {
        scene.environment = a.environment;
        assigned++;
      }
    }
    console.log(`  🌍 Environments assigned: ${assigned}/${scenes.length} scenes`);
    for (const s of scenes) {
      console.log(`    Scene ${s.scene_number}: ${s.environment || 'forest_day'}`);
    }
  } catch (err) {
    console.warn(`  ⚠️  Environment assignment failed (${err.message}) — using forest_day defaults`);
  }
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
    `[0:a][bgm_faded]amix=inputs=2:duration=first:normalize=0[aout]`,
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

  const { scenes, sceneImagePaths, sceneAnimPaths, sceneAudioPaths, tmpDir } = state;
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

  // Assign environment tags for SFX selection via Claude
  await assignSceneEnvironments(scenes);

  const sceneFinalPaths = []; // ordered list of assembled scene paths

  for (const scene of scenes) {
    const sceneNum = scene.scene_number;
    const sceneLabel = String(sceneNum).padStart(2, '0');

    const audioPath = sceneAudioPaths?.[sceneNum];
    if (!audioPath) {
      console.warn(`  ⚠️  No audio for scene ${sceneNum} — skipping`);
      continue;
    }

    let animPath = sceneAnimPaths?.[sceneNum]?.animPath ?? null;
    const animStoragePath = sceneAnimPaths?.[sceneNum]?.storagePath ?? null;
    const imagePath = sceneImagePaths?.[sceneNum]?.imagePath ?? null;

    // Bug 1 fix: if animPath is null but storagePath exists, download from Supabase
    if (!animPath && animStoragePath) {
      try {
        console.log(`  ⬇️  Scene ${sceneNum}: animPath missing — downloading from Supabase (${animStoragePath})...`);
        const scenesDir = join(tmpDir, 'scenes');
        await fs.mkdir(scenesDir, { recursive: true });
        const localAnimPath = join(scenesDir, `scene_${sceneLabel}_anim.mp4`);
        const buffer = await downloadFromStorage({ bucket: BUCKETS.scenes, path: animStoragePath });
        await fs.writeFile(localAnimPath, buffer);
        animPath = localAnimPath;
        console.log(`  ✓ Scene ${sceneNum}: animation downloaded (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
      } catch (downloadErr) {
        console.warn(`  ⚠️  Scene ${sceneNum}: failed to download animation from Supabase — ${downloadErr.message}`);
      }
    }

    // Resolve SFX for this scene's environment
    const environment = scene.environment || 'forest_day';
    const sfxPath = getSfxPath(environment);

    const finalPath = join(assemblyDir, `scene_${sceneLabel}_final.mp4`);

    if (animPath) {
      const clipDuration = getDurationSeconds(animPath);
      console.log(`  🔧 Scene ${sceneNum}: merging clip + audio + SFX[${environment}] (clip ${clipDuration.toFixed(1)}s)...`);
      await mergeClipWithAudio({
        clipPath: animPath,
        audioPath,
        sfxPath,
        outputPath: finalPath,
        videoType,
      });
    } else if (imagePath) {
      // No animation — use still image + audio (zoompan)
      const audioDuration = getDurationSeconds(audioPath);
      console.log(`  🖼️  Scene ${sceneNum}: still image + audio (${audioDuration.toFixed(1)}s)...`);
      await stillImageToVideo({ imagePath, audioPath, outputPath: finalPath, videoType });
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
      `-filter_complex "[1:v]scale=${logoW}:-1[logo];[0:v][logo]overlay=W-w-40:50[vout]"`,
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

  // End card — pick the right one based on video format
  const endCardFilename = videoType === 'short' ? 'shorts_end_card.mp4' : 'end-card.mp4';
  const endCardVideoPath = join(import.meta.dirname, '..', 'assets', endCardFilename);
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

    await fs.rename(syncedPath, finalPath);
    endCardAppended = true;
    console.log('  📌 End card appended + sync fixed');
  } catch (err) {
    console.warn(`  ⚠️  End card not appended: ${err.message}`);
  }

  const duration = getDurationSeconds(finalPath);
  console.log(`  ✓ Final video: ${duration.toFixed(1)}s (logo: ${logoApplied ? '✅' : '❌'}, end card: ${endCardAppended ? '✅' : '❌'})`);

  // Feedback collection mode — notify Telegram
  if (await isFeedbackCollectionMode()) {
    await sendTelegramMessage(`🎞️ Assembly complete: ${duration.toFixed(1)}s — ${finalPath}`);
  }

  console.log(`✅ Stage 7 complete. Final video: ${finalPath}`);
  return { ...state, finalVideoPath: finalPath, finalDurationSeconds: duration };
}
