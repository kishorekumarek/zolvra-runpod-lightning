// stages/stage-07-assemble.mjs — Simple 1:1 scene assembly (clip + audio → final)
// REWRITTEN for pipeline schema rewrite: reads all assets from DB + storage, writes to video_output.
import 'dotenv/config';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isFeedbackCollectionMode } from '../lib/settings.mjs';
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
import {
  getPipelineState, getConcept, getScenes, updateScene,
  insertVideoOutput, updatePipelineState,
} from '../lib/pipeline-db.mjs';

const STAGE = 7;
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'output');

/**
 * Merge a video clip with audio using full clip duration.
 */
async function mergeClipWithAudio({ clipPath, audioPath, sfxPath, outputPath, videoType = 'long' }) {
  const clipDuration = getDurationSeconds(clipPath);
  const audioDuration = getDurationSeconds(audioPath);

  const vScale = getVideoConfig(videoType).videoScale;
  const scaleFilter = `scale=${vScale}:force_original_aspect_ratio=increase,crop=${vScale}`;

  let effectiveClipPath = clipPath;
  let loopedPath = null;
  if (audioDuration > clipDuration + 0.5) {
    console.log(`    🔁 Simple looping clip (${clipDuration.toFixed(1)}s → ${audioDuration.toFixed(1)}s)`);
    loopedPath = await loopVideoToFill({ inputPath: clipPath, outputPath: clipPath.replace('.mp4', '_looped.mp4'), targetDuration: audioDuration });
    effectiveClipPath = loopedPath;
  }

  try {
    if (sfxPath) {
      const fc = [
        `[0:v]${scaleFilter}[vout]`,
        `[1:a]volume=1.0[voice]`,
        `[2:a]volume=0.15[sfx]`,
        `[voice][sfx]amix=inputs=2:duration=first[aout]`,
      ].join(';');

      const cmd = [
        `"${FFMPEG}" -y`,
        `-i "${effectiveClipPath}"`,
        `-i "${audioPath}"`,
        `-stream_loop -1 -i "${sfxPath}"`,
        `-filter_complex "${fc}"`,
        `-map "[vout]"`,
        `-map "[aout]"`,
        `-c:v libx264 -preset fast -crf 22`,
        `-c:a aac -b:a 192k`,
        `-shortest`,
        `"${outputPath}"`,
      ].join(' ');
      execSync(cmd, { stdio: 'pipe' });
    } else {
      const cmd = [
        `"${FFMPEG}" -y`,
        `-i "${effectiveClipPath}"`,
        `-i "${audioPath}"`,
        `-vf "${scaleFilter}"`,
        `-c:v libx264 -preset fast -crf 22`,
        `-c:a aac -b:a 192k`,
        `-shortest`,
        `"${outputPath}"`,
      ].join(' ');
      execSync(cmd, { stdio: 'pipe' });
    }
  } finally {
    if (loopedPath) {
      await fs.unlink(loopedPath).catch(() => {});
    }
  }

  return clipDuration > audioDuration ? clipDuration : audioDuration;
}

/**
 * Assign environment tags to scenes using Claude Haiku.
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
  } catch (err) {
    console.warn(`  ⚠️  Environment assignment failed (${err.message}) — using forest_day defaults`);
  }
}

/**
 * Apply continuous BGM over the final concatenated video.
 */
function applyFinalBgm({ inputPath, bgmPath, outputPath }) {
  const totalDuration = getDurationSeconds(inputPath);
  const fadeOutStart = Math.max(0, totalDuration - 3);

  const fc = [
    `[1:a]volume=0.2,afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=3[bgm_faded]`,
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
 *
 * NEW: reads all scene assets from DB + storage. Writes final video to persistent
 * output dir + video_output table.
 */
export async function runStage7(taskId, tracker, state = {}) {
  console.log('🎞️  Stage 7: Video assembly...');

  // ── Read from DB ───────────────────────────────────────────────────
  const ps = await getPipelineState(taskId);
  if (!ps?.concept_id) throw new Error('Stage 7: pipeline_state not found or missing concept_id');

  const concept = await getConcept(ps.concept_id);
  const videoType = concept.video_type || 'short';
  console.log(`  video_type=${videoType}`);

  const scenes = await getScenes(taskId);
  if (!scenes || scenes.length === 0) throw new Error('Stage 7: no scenes found in DB');

  const tmpDir = `/tmp/zolvra-pipeline/${taskId}`;
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

  // Write environment tags back to DB
  for (const s of scenes) {
    if (s.environment) {
      await updateScene(taskId, s.scene_number, { environment: s.environment });
    }
  }

  // ── Download all assets from storage ───────────────────────────────
  const scenesDir = join(tmpDir, 'scenes');
  await fs.mkdir(scenesDir, { recursive: true });

  const sceneFinalPaths = [];

  for (const scene of scenes) {
    const sceneNum = scene.scene_number;
    const sceneLabel = String(sceneNum).padStart(2, '0');

    // Download audio from storage (NEW — was local /tmp path before)
    let audioPath = null;
    if (scene.audio_url) {
      try {
        const audioBuf = await downloadFromStorage({ bucket: BUCKETS.scenes, path: scene.audio_url });
        audioPath = join(scenesDir, `scene_${sceneLabel}_audio.mp3`);
        await fs.writeFile(audioPath, audioBuf);
      } catch (dlErr) {
        console.warn(`  ⚠️  Scene ${sceneNum}: audio download failed: ${dlErr.message}`);
      }
    }

    if (!audioPath) {
      console.warn(`  ⚠️  No audio for scene ${sceneNum} — skipping`);
      continue;
    }

    // Download animation or image from storage
    let animPath = null;
    let imagePath = null;

    if (scene.animation_url) {
      try {
        const animBuf = await downloadFromStorage({ bucket: BUCKETS.scenes, path: scene.animation_url });
        animPath = join(scenesDir, `scene_${sceneLabel}_anim.mp4`);
        await fs.writeFile(animPath, animBuf);
      } catch (dlErr) {
        console.warn(`  ⚠️  Scene ${sceneNum}: animation download failed: ${dlErr.message}`);
      }
    }

    if (!animPath && scene.image_url) {
      try {
        const imgBuf = await downloadFromStorage({ bucket: BUCKETS.scenes, path: scene.image_url });
        imagePath = join(scenesDir, `scene_${sceneLabel}_image.png`);
        await fs.writeFile(imagePath, imgBuf);
      } catch (dlErr) {
        console.warn(`  ⚠️  Scene ${sceneNum}: image download failed: ${dlErr.message}`);
      }
    }

    // Resolve SFX
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

  // Concatenate all scene finals
  console.log(`  📼 Concat ${sceneFinalPaths.length} scenes (plain)...`);
  const concatPath = join(assemblyDir, 'concat.mp4');
  await assembleVideo({ sceneCombinedPaths: sceneFinalPaths, outputPath: concatPath });

  // Apply continuous BGM overlay
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

  // Logo overlay
  const logoPath = join(__dirname, '..', 'assets', 'channel-logo.png');
  let logoApplied = false;
  try {
    await fs.access(logoPath);
    const withLogoPath = join(assemblyDir, 'with-logo.mp4');
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

  // End card
  const endCardFilename = videoType === 'short' ? 'shorts_end_card.mp4' : 'end-card.mp4';
  const endCardVideoPath = join(__dirname, '..', 'assets', endCardFilename);
  const endCardAudioPath = join(__dirname, '..', 'assets', 'end_card_audio.mp3');
  let endCardAppended = false;
  try {
    await fs.access(endCardVideoPath);
    await fs.access(endCardAudioPath);

    const mainDims = execSync(
      `"${FFPROBE}" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${finalPath}"`
    ).toString().trim().split(',');
    const [mW, mH] = mainDims.map(Number);

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

    const mainReencoded = join(assemblyDir, 'main-reencoded.mp4');
    execSync([
      `"${FFMPEG}" -y`,
      `-i "${finalPath}"`,
      `-c:v libx264 -preset fast -crf 23 -r 30`,
      `-c:a aac -b:a 128k`,
      `"${mainReencoded}"`,
    ].join(' '), { stdio: 'pipe' });

    const concatEndPath = join(assemblyDir, 'concat-end.txt');
    await fs.writeFile(concatEndPath, `file '${mainReencoded}'\nfile '${endCardReencoded}'\n`);
    const withEndCardPath = join(assemblyDir, 'with-endcard.mp4');
    execSync(`"${FFMPEG}" -y -f concat -safe 0 -i "${concatEndPath}" -c copy "${withEndCardPath}"`, { stdio: 'pipe' });

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

  // ── Save to persistent output dir + write to video_output table ────
  const outputDir = join(OUTPUT_DIR, taskId);
  await fs.mkdir(outputDir, { recursive: true });
  const persistentVideoPath = join(outputDir, 'final.mp4');
  await fs.copyFile(finalPath, persistentVideoPath);
  console.log(`  💾 Final video saved: ${persistentVideoPath}`);

  const videoOutputId = await insertVideoOutput({
    local_video_path: persistentVideoPath,
    video_url: null,
    final_duration_seconds: duration,
  });
  await updatePipelineState(taskId, { video_output_id: videoOutputId });
  console.log(`  ✓ video_output saved (id: ${videoOutputId})`);

  if (await isFeedbackCollectionMode()) {
    await sendTelegramMessage(`🎞️ Assembly complete: ${duration.toFixed(1)}s — ${persistentVideoPath}`);
  }

  console.log(`✅ Stage 7 complete. Final video: ${persistentVideoPath}`);

}
