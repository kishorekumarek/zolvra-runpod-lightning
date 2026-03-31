// scripts/assemble-jungle-jambu.mjs — Jungle Jambu series-aware video assembly
//
// Series-specific assembly that:
//   - Prepends assets/series/jungle-jambu/intro.mp4 (skip gracefully if missing)
//   - Applies Noto Sans Tamil text overlay (EP number + title) on intro
//   - Appends assets/series/jungle-jambu/end_card.mp4 (skip gracefully if missing)
//   - BGM at 11% volume (kids_folk_02.mp3)
//   - Logo overlay top-right (12% of width)
//   - Final re-encode with -shortest
//
// Usage: node scripts/assemble-jungle-jambu.mjs <task_id> <ep_number> [ep_title_tamil]

import 'dotenv/config';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  getDurationSeconds,
  assembleVideo,
  stillImageToVideo,
  loopVideoToFill,
  FFMPEG,
  FFPROBE,
} from '../lib/ffmpeg.mjs';
import { getSfxPath } from '../lib/sfx-mixer.mjs';
import { downloadFromStorage, BUCKETS } from '../lib/storage.mjs';
import {
  getPipelineState, getConcept, getScenes, updateScene,
  insertVideoOutput, updatePipelineState,
} from '../lib/pipeline-db.mjs';
import { getVideoConfig } from '../lib/video-config.mjs';
import { callClaude } from '../../shared/claude.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(ROOT, 'output');
const ASSETS_DIR = join(ROOT, 'assets');

const JJ_INTRO_PATH    = join(ASSETS_DIR, 'series', 'jungle-jambu', 'intro.mp4');
const JJ_END_CARD_PATH = join(ASSETS_DIR, 'series', 'jungle-jambu', 'end_card.mp4');
const BGM_PATH         = join(ASSETS_DIR, 'bgm', 'kids_folk_02.mp3');
const LOGO_PATH        = join(ASSETS_DIR, 'channel-logo.png');

// Noto Sans Tamil font search paths (macOS + common Linux locations)
const NOTO_TAMIL_FONT_PATHS = [
  '/Library/Fonts/NotoSansTamil-Regular.ttf',
  '/Library/Fonts/NotoSansTamil.ttf',
  '/System/Library/Fonts/Supplemental/NotoSansTamil-Regular.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansTamil-Regular.ttf',
  '/usr/share/fonts/noto/NotoSansTamil-Regular.ttf',
];

function findNotoTamilFont() {
  for (const p of NOTO_TAMIL_FONT_PATHS) {
    try {
      execSync(`test -f "${p}"`, { stdio: 'pipe' });
      return p;
    } catch { /* not found */ }
  }
  return null;
}

const VALID_ENVS = ['forest_day', 'forest_rain', 'river', 'village', 'night', 'sky', 'crowd_children'];

async function assignSceneEnvironments(scenes) {
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
      messages: [{ role: 'user', content: `Classify these scenes:\n${JSON.stringify(sceneDescriptions, null, 2)}` }],
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

async function mergeClipWithAudio({ clipPath, audioPath, sfxPath, outputPath, videoType = 'short' }) {
  const clipDuration = getDurationSeconds(clipPath);
  const audioDuration = getDurationSeconds(audioPath);
  const sceneDur = (audioDuration > 0 && audioDuration > clipDuration) ? audioDuration : clipDuration;

  const vScale = getVideoConfig(videoType).videoScale;
  const scaleFilter = `scale=${vScale}:force_original_aspect_ratio=increase,crop=${vScale}`;

  let effectiveClipPath = clipPath;
  let loopedPath = null;
  if (audioDuration > clipDuration + 0.5) {
    console.log(`    🔁 Looping clip (${clipDuration.toFixed(1)}s → ${sceneDur.toFixed(1)}s)`);
    loopedPath = await loopVideoToFill({
      inputPath: clipPath,
      outputPath: clipPath.replace('.mp4', '_looped.mp4'),
      targetDuration: sceneDur,
    });
    effectiveClipPath = loopedPath;
  }

  try {
    if (sfxPath) {
      let fc;
      if (clipDuration > audioDuration + 0.5 && audioDuration > 0) {
        fc = [
          `[0:v]${scaleFilter}[vout]`,
          `[1:a]volume=1.0,apad=whole_dur=${sceneDur}[voice_padded]`,
          `[2:a]atrim=duration=${sceneDur},asetpts=PTS-STARTPTS,volume=0.15[sfx]`,
          `[voice_padded][sfx]amix=inputs=2:duration=longest:normalize=0[aout]`,
        ].join(';');
      } else {
        fc = [
          `[0:v]${scaleFilter}[vout]`,
          `[1:a]volume=1.0[voice]`,
          `[2:a]atrim=duration=${sceneDur},asetpts=PTS-STARTPTS,volume=0.15[sfx]`,
          `[voice][sfx]amix=inputs=2:duration=longest:normalize=0[aout]`,
        ].join(';');
      }
      execSync([
        `"${FFMPEG}" -y`,
        `-i "${effectiveClipPath}"`,
        `-i "${audioPath}"`,
        `-stream_loop -1 -i "${sfxPath}"`,
        `-t ${sceneDur}`,
        `-filter_complex "${fc}"`,
        `-map "[vout]" -map "[aout]"`,
        `-c:v libx264 -preset fast -crf 22`,
        `-c:a aac -b:a 192k`,
        `"${outputPath}"`,
      ].join(' '), { stdio: 'pipe' });
    } else {
      let audioFilter;
      if (clipDuration > audioDuration + 0.5 && audioDuration > 0) {
        audioFilter = `-filter_complex "[1:a]apad=whole_dur=${sceneDur}[aout]" -map 0:v -map "[aout]" -vf "${scaleFilter}"`;
      } else {
        audioFilter = `-map 0:v -map 1:a -vf "${scaleFilter}"`;
      }
      execSync([
        `"${FFMPEG}" -y`,
        `-i "${effectiveClipPath}"`,
        `-i "${audioPath}"`,
        `-t ${sceneDur}`,
        audioFilter,
        `-c:v libx264 -preset fast -crf 22`,
        `-c:a aac -b:a 192k`,
        `"${outputPath}"`,
      ].join(' '), { stdio: 'pipe' });
    }
  } finally {
    if (loopedPath) await fs.unlink(loopedPath).catch(() => {});
  }

  return sceneDur;
}

// BGM at 11% (middle of the 10-12% target range)
function applyFinalBgm({ inputPath, bgmPath, outputPath }) {
  const totalDuration = getDurationSeconds(inputPath);
  const fadeOutStart = Math.max(0, totalDuration - 3);

  const fc = [
    `[1:a]volume=0.11,afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=3[bgm_faded]`,
    `[0:a][bgm_faded]amix=inputs=2:duration=first:normalize=0[aout]`,
  ].join(';');

  execSync([
    `"${FFMPEG}" -y`,
    `-i "${inputPath}"`,
    `-stream_loop -1 -i "${bgmPath}"`,
    `-t ${totalDuration}`,
    `-filter_complex "${fc}"`,
    `-map 0:v -map "[aout]"`,
    `-c:v copy -c:a aac -b:a 192k`,
    `"${outputPath}"`,
  ].join(' '), { stdio: 'pipe' });
}

/**
 * Assemble a Jungle Jambu episode.
 *
 * @param {string} taskId
 * @param {number} epNumber
 * @param {string|null} epTitleTamil - Episode title in Tamil script (used for intro text overlay)
 * @returns {string} Path to the assembled video file
 */
export async function assembleJungleJambu(taskId, epNumber, epTitleTamil = null) {
  console.log(`🦁 Jungle Jambu Assembly — EP${epNumber}${epTitleTamil ? ': ' + epTitleTamil : ''}`);

  const ps = await getPipelineState(taskId);
  if (!ps?.concept_id) throw new Error('JJ Assembly: pipeline_state not found or missing concept_id');

  const concept = await getConcept(ps.concept_id);
  const videoType = concept.video_type || 'short';
  console.log(`  video_type=${videoType}`);

  const scenes = await getScenes(taskId);
  if (!scenes || scenes.length === 0) throw new Error('JJ Assembly: no scenes found in DB');

  const tmpDir = `/tmp/zolvra-pipeline/${taskId}`;
  const assemblyDir = join(tmpDir, 'jj-assembly');
  await fs.mkdir(assemblyDir, { recursive: true });

  // Assign environment tags for SFX
  await assignSceneEnvironments(scenes);
  for (const s of scenes) {
    if (s.environment) await updateScene(taskId, s.scene_number, { environment: s.environment });
  }

  // Download and merge scenes
  const scenesDir = join(tmpDir, 'scenes');
  await fs.mkdir(scenesDir, { recursive: true });
  const sceneFinalPaths = [];

  for (const scene of scenes) {
    const sceneNum = scene.scene_number;
    const sceneLabel = String(sceneNum).padStart(2, '0');

    let audioPath = null;
    if (scene.audio_url) {
      try {
        const buf = await downloadFromStorage({ bucket: BUCKETS.scenes, path: scene.audio_url });
        audioPath = join(scenesDir, `scene_${sceneLabel}_audio.mp3`);
        await fs.writeFile(audioPath, buf);
      } catch (err) {
        console.warn(`  ⚠️  Scene ${sceneNum}: audio download failed: ${err.message}`);
      }
    }
    if (!audioPath) {
      console.warn(`  ⚠️  No audio for scene ${sceneNum} — skipping`);
      continue;
    }

    let animPath = null;
    let imagePath = null;

    if (scene.animation_url) {
      try {
        const buf = await downloadFromStorage({ bucket: BUCKETS.scenes, path: scene.animation_url });
        animPath = join(scenesDir, `scene_${sceneLabel}_anim.mp4`);
        await fs.writeFile(animPath, buf);
      } catch (err) {
        console.warn(`  ⚠️  Scene ${sceneNum}: animation download failed: ${err.message}`);
      }
    }
    if (!animPath && scene.image_url) {
      try {
        const buf = await downloadFromStorage({ bucket: BUCKETS.scenes, path: scene.image_url });
        imagePath = join(scenesDir, `scene_${sceneLabel}_image.png`);
        await fs.writeFile(imagePath, buf);
      } catch (err) {
        console.warn(`  ⚠️  Scene ${sceneNum}: image download failed: ${err.message}`);
      }
    }

    const sfxPath = getSfxPath(scene.environment || 'forest_day');
    const finalPath = join(assemblyDir, `scene_${sceneLabel}_final.mp4`);

    if (animPath) {
      const clipDuration = getDurationSeconds(animPath);
      console.log(`  🔧 Scene ${sceneNum}: merging clip+audio+SFX[${scene.environment || 'forest_day'}] (${clipDuration.toFixed(1)}s)...`);
      await mergeClipWithAudio({ clipPath: animPath, audioPath, sfxPath, outputPath: finalPath, videoType });
    } else if (imagePath) {
      const audioDuration = getDurationSeconds(audioPath);
      console.log(`  🖼️  Scene ${sceneNum}: still image (${audioDuration.toFixed(1)}s)...`);
      await stillImageToVideo({ imagePath, audioPath, outputPath: finalPath, videoType });
    } else {
      console.warn(`  ⚠️  Scene ${sceneNum}: no clip or image — skipping`);
      continue;
    }

    sceneFinalPaths.push(finalPath);
    console.log(`  ✓ Scene ${sceneNum} assembled`);
  }

  if (sceneFinalPaths.length === 0) throw new Error('No scenes assembled — cannot create final video');

  // Concatenate scenes
  console.log(`  📼 Concatenating ${sceneFinalPaths.length} scenes...`);
  const concatPath = join(assemblyDir, 'concat.mp4');
  await assembleVideo({ sceneCombinedPaths: sceneFinalPaths, outputPath: concatPath });

  // Apply BGM at 11%
  let mainPath = join(assemblyDir, 'main.mp4');
  try {
    await fs.access(BGM_PATH);
    console.log('  🎵 Applying BGM (11%)...');
    applyFinalBgm({ inputPath: concatPath, bgmPath: BGM_PATH, outputPath: mainPath });
    await fs.unlink(concatPath).catch(() => {});
  } catch {
    console.warn('  ⚠️  BGM file not found — skipping BGM mix');
    await fs.rename(concatPath, mainPath);
  }

  const preFinalDuration = getDurationSeconds(mainPath);
  console.log(`  ✓ Scenes assembled: ${preFinalDuration.toFixed(1)}s`);

  // Logo overlay (top-right, 12% of width)
  let logoApplied = false;
  try {
    await fs.access(LOGO_PATH);
    const withLogoPath = join(assemblyDir, 'with-logo.mp4');
    const dims = execSync(
      `"${FFPROBE}" -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "${mainPath}"`
    ).toString().trim();
    const vidW = parseInt(dims) || 1080;
    const logoW = Math.round(vidW * 0.12);
    execSync([
      `"${FFMPEG}" -y`,
      `-i "${mainPath}"`,
      `-i "${LOGO_PATH}"`,
      `-filter_complex "[1:v]scale=${logoW}:-1[logo];[0:v][logo]overlay=W-w-40:50[vout]"`,
      `-map "[vout]" -map 0:a`,
      `-c:v libx264 -preset fast -crf 23 -c:a copy`,
      `"${withLogoPath}"`,
    ].join(' '), { stdio: 'pipe' });
    await fs.unlink(mainPath).catch(() => {});
    await fs.rename(withLogoPath, mainPath);
    logoApplied = true;
    console.log(`  🏷️  Logo overlay applied (${logoW}px, top-right)`);
  } catch {
    console.warn('  ⚠️  Logo file not found — skipping overlay');
  }

  // Get main video dimensions for matching intro/end-card
  const mainDimsRaw = execSync(
    `"${FFPROBE}" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${mainPath}"`
  ).toString().trim().split(',');
  const [mW, mH] = mainDimsRaw.map(Number);

  const partsToConcat = [];

  // Prepare JJ intro with text overlay
  let introApplied = false;
  try {
    await fs.access(JJ_INTRO_PATH);

    // Re-encode intro to match main video dimensions
    const introReencoded = join(assemblyDir, 'intro-reencoded.mp4');
    execSync([
      `"${FFMPEG}" -y`,
      `-i "${JJ_INTRO_PATH}"`,
      `-c:v libx264 -preset fast -crf 23`,
      `-vf "scale=${mW}:${mH}:force_original_aspect_ratio=decrease,pad=${mW}:${mH}:(ow-iw)/2:(oh-ih)/2"`,
      `-c:a aac -b:a 128k -r 30`,
      `"${introReencoded}"`,
    ].join(' '), { stdio: 'pipe' });

    // Apply text overlay with Noto Sans Tamil
    const introFinal = join(assemblyDir, 'intro-final.mp4');
    const fontPath = findNotoTamilFont();

    if (fontPath && epTitleTamil) {
      // Write text to file to safely handle Tamil Unicode characters
      const textFile = join(assemblyDir, 'intro-text.txt');
      await fs.writeFile(textFile, `EP${epNumber}\n${epTitleTamil}`, 'utf8');

      const drawFilter = [
        `drawtext=fontfile='${fontPath}'`,
        `textfile='${textFile}'`,
        `x=(w-text_w)/2`,
        `y=(h*0.65)`,
        `fontsize=52`,
        `fontcolor=white`,
        `line_spacing=10`,
        `box=1`,
        `boxcolor=black@0.5`,
        `boxborderw=12`,
      ].join(':');

      execSync([
        `"${FFMPEG}" -y`,
        `-i "${introReencoded}"`,
        `-vf "${drawFilter}"`,
        `-c:v libx264 -preset fast -crf 23`,
        `-c:a copy`,
        `"${introFinal}"`,
      ].join(' '), { stdio: 'pipe' });
      await fs.unlink(introReencoded).catch(() => {});
      console.log(`  🎬 Intro text overlay applied (EP${epNumber} + Tamil title)`);
    } else {
      if (!fontPath) console.warn('  ⚠️  Noto Sans Tamil font not found — intro text overlay skipped');
      if (!epTitleTamil) console.warn('  ⚠️  No Tamil title provided — intro text overlay skipped');
      await fs.rename(introReencoded, introFinal);
    }

    partsToConcat.push(introFinal);
    introApplied = true;
    console.log('  🎬 JJ intro prepared');
  } catch (err) {
    console.warn(`  ⚠️  JJ intro not applied: ${err.message}`);
  }

  // Re-encode main to normalize frame rate/codec before concat
  const mainReencoded = join(assemblyDir, 'main-reencoded.mp4');
  execSync([
    `"${FFMPEG}" -y`,
    `-i "${mainPath}"`,
    `-c:v libx264 -preset fast -crf 23 -r 30`,
    `-c:a aac -b:a 128k`,
    `"${mainReencoded}"`,
  ].join(' '), { stdio: 'pipe' });
  partsToConcat.push(mainReencoded);

  // Prepare JJ end card
  let endCardApplied = false;
  try {
    await fs.access(JJ_END_CARD_PATH);
    const endCardReencoded = join(assemblyDir, 'end-card-reencoded.mp4');
    execSync([
      `"${FFMPEG}" -y`,
      `-i "${JJ_END_CARD_PATH}"`,
      `-c:v libx264 -preset fast -crf 23`,
      `-vf "scale=${mW}:${mH}:force_original_aspect_ratio=decrease,pad=${mW}:${mH}:(ow-iw)/2:(oh-ih)/2"`,
      `-c:a aac -b:a 128k -r 30`,
      `"${endCardReencoded}"`,
    ].join(' '), { stdio: 'pipe' });
    partsToConcat.push(endCardReencoded);
    endCardApplied = true;
    console.log('  📌 JJ end card prepared');
  } catch (err) {
    console.warn(`  ⚠️  JJ end card not applied: ${err.message}`);
  }

  // Concatenate intro + main + end card
  const concatListPath = join(assemblyDir, 'concat-list.txt');
  await fs.writeFile(concatListPath, partsToConcat.map(p => `file '${p}'`).join('\n') + '\n');

  const combinedPath = join(assemblyDir, 'combined.mp4');
  execSync([
    `"${FFMPEG}" -y -f concat -safe 0`,
    `-i "${concatListPath}"`,
    `-c copy`,
    `"${combinedPath}"`,
  ].join(' '), { stdio: 'pipe' });

  // Final re-encode with -shortest
  const finalPath = join(assemblyDir, 'final.mp4');
  execSync([
    `"${FFMPEG}" -y`,
    `-i "${combinedPath}"`,
    `-c:v libx264 -preset fast -crf 23`,
    `-c:a aac -b:a 128k -shortest`,
    `"${finalPath}"`,
  ].join(' '), { stdio: 'pipe' });

  const duration = getDurationSeconds(finalPath);
  console.log(`  ✓ Final: ${duration.toFixed(1)}s | logo:${logoApplied ? '✅' : '❌'} intro:${introApplied ? '✅' : '❌'} end-card:${endCardApplied ? '✅' : '❌'}`);

  // Save to persistent output directory
  const outputDir = join(OUTPUT_DIR, taskId);
  await fs.mkdir(outputDir, { recursive: true });
  const epLabel = String(epNumber).padStart(2, '0');
  const outputFileName = `jungle-jambu-ep${epLabel}.mp4`;
  const persistentVideoPath = join(outputDir, outputFileName);
  await fs.copyFile(finalPath, persistentVideoPath);
  console.log(`  💾 Saved: ${persistentVideoPath}`);

  // Write to video_output table + update pipeline_state
  const videoOutputId = await insertVideoOutput({
    local_video_path: persistentVideoPath,
    video_url: null,
    final_duration_seconds: duration,
  });
  await updatePipelineState(taskId, { video_output_id: videoOutputId });
  console.log(`  ✓ video_output saved (id: ${videoOutputId})`);

  console.log(`✅ Jungle Jambu EP${epNumber} assembly complete. Final: ${persistentVideoPath}`);
  return persistentVideoPath;
}

// ── CLI entry ─────────────────────────────────────────────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const [, , taskId, epNumberStr, ...titleParts] = process.argv;
  if (!taskId || !epNumberStr) {
    console.error('Usage: node scripts/assemble-jungle-jambu.mjs <task_id> <ep_number> [ep_title_tamil]');
    process.exit(1);
  }
  const epNumber = parseInt(epNumberStr, 10);
  const epTitleTamil = titleParts.length > 0 ? titleParts.join(' ') : null;

  assembleJungleJambu(taskId, epNumber, epTitleTamil)
    .catch(err => { console.error('❌', err.message); process.exit(1); });
}
