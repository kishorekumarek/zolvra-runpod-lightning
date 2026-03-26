// lib/ffmpeg.mjs — ffmpeg assembly helpers
import { execSync, spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import 'dotenv/config';

const FFMPEG = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');

/**
 * Get audio/video duration in seconds via ffprobe.
 */
export function getDurationSeconds(filePath) {
  const result = execSync(
    `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${filePath}"`
  ).toString().trim();
  return parseFloat(result);
}

/**
 * Merge an animation (mp4) with audio (mp3) into a single mp4.
 * Uses the animation as video track, audio as audio track.
 */
export async function mergeAnimationWithAudio({ animationPath, audioPath, outputPath }) {
  const cmd = [
    `"${FFMPEG}" -y`,
    `-i "${animationPath}"`,
    `-i "${audioPath}"`,
    `-c:v copy`,
    `-c:a aac -b:a 192k`,
    `-shortest`,
    `"${outputPath}"`,
  ].join(' ');

  execSync(cmd, { stdio: 'pipe' });
  return outputPath;
}

/**
 * Create a video from a still image + audio (for scenes without animation).
 */
export async function stillImageToVideo({ imagePath, audioPath, duration, outputPath, videoType = 'long' }) {
  if (!imagePath || imagePath === 'none' || imagePath === 'undefined') {
    throw new Error('stillImageToVideo: imagePath is required but got: ' + imagePath);
  }

  const outputScale = videoType === 'short' ? '1080x1920' : '1920x1080';
  const intermediateScale = videoType === 'short' ? '4500x8000' : '8000x4500';
  let cmd;

  if (audioPath) {
    // Use audio track to determine duration
    cmd = [
      `"${FFMPEG}" -y`,
      `-loop 1 -i "${imagePath}"`,
      `-i "${audioPath}"`,
      `-c:v libx264`,
      `-c:a aac -b:a 192k`,
      `-shortest`,
      `-vf "scale=${intermediateScale},zoompan=z='min(zoom+0.0015,1.5)':d=125:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',scale=${outputScale}"`,
      `"${outputPath}"`,
    ].join(' ');
  } else if (duration) {
    // Use explicit duration (no audio track)
    cmd = [
      `"${FFMPEG}" -y`,
      `-loop 1 -i "${imagePath}"`,
      `-t ${duration}`,
      `-c:v libx264`,
      `-an`,
      `-vf "scale=${intermediateScale},zoompan=z='min(zoom+0.0015,1.5)':d=125:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',scale=${outputScale}"`,
      `"${outputPath}"`,
    ].join(' ');
  } else {
    throw new Error('stillImageToVideo requires either audioPath or duration');
  }

  execSync(cmd, { stdio: 'pipe' });
  return outputPath;
}

/**
 * Concatenate all audio buffers for a scene into one mp3.
 */
export async function concatAudioFiles(inputPaths, outputPath) {
  if (inputPaths.length === 1) {
    await fs.copyFile(inputPaths[0], outputPath);
    return outputPath;
  }

  // Create a concat list
  const concatListPath = outputPath + '.concat.txt';
  const lines = inputPaths.map(p => `file '${p}'`).join('\n');
  await fs.writeFile(concatListPath, lines);

  const cmd = [
    `"${FFMPEG}" -y`,
    `-f concat -safe 0`,
    `-i "${concatListPath}"`,
    `-c copy`,
    `"${outputPath}"`,
  ].join(' ');

  execSync(cmd, { stdio: 'pipe' });
  await fs.unlink(concatListPath).catch(() => {});
  return outputPath;
}

/**
 * Concatenate scene videos + mix in background music.
 * Creates the final assembled video.
 */
export async function assembleVideo({ sceneCombinedPaths, musicPath, outputPath }) {
  const concatListPath = outputPath + '.concat.txt';
  const lines = sceneCombinedPaths.map(p => `file '${p}'`).join('\n');
  await fs.writeFile(concatListPath, lines);

  let cmd;

  if (musicPath) {
    // With background music at 15% volume mixed in
    cmd = [
      `"${FFMPEG}" -y`,
      `-f concat -safe 0 -i "${concatListPath}"`,
      `-i "${musicPath}"`,
      `-filter_complex "[1:a]volume=0.15[bg];[0:a][bg]amix=inputs=2:duration=first[aout]"`,
      `-map 0:v -map "[aout]"`,
      `-c:v libx264 -preset medium -crf 23`,
      `-c:a aac -b:a 192k`,
      `"${outputPath}"`,
    ].join(' ');
  } else {
    // No music
    cmd = [
      `"${FFMPEG}" -y`,
      `-f concat -safe 0 -i "${concatListPath}"`,
      `-c:v libx264 -preset medium -crf 23`,
      `-c:a aac -b:a 192k`,
      `"${outputPath}"`,
    ].join(' ');
  }

  execSync(cmd, { stdio: 'pipe' });
  await fs.unlink(concatListPath).catch(() => {});
  return outputPath;
}

/**
 * Get video resolution (width x height) via ffprobe.
 */
export function getVideoResolution(filePath) {
  const result = execSync(
    `"${FFPROBE}" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`
  ).toString().trim();
  const [width, height] = result.split(',').map(Number);
  return { width, height };
}

/**
 * Create a temp directory for a video pipeline run.
 */
export async function createTmpDir(videoId) {
  const dir = `/tmp/zolvra-pipeline/${videoId}`;
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(join(dir, 'scenes'), { recursive: true });
  await fs.mkdir(join(dir, 'audio'), { recursive: true });
  await fs.mkdir(join(dir, 'assembly'), { recursive: true });
  return dir;
}

/**
 * Clean up tmp directory for a video.
 */
export async function cleanupTmpDir(videoId) {
  const dir = `/tmp/zolvra-pipeline/${videoId}`;
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Assemble multiple shots into a single scene video using xfade transitions.
 * shots = [{ sourcePath, duration, transition, transitionDuration }]
 */
export async function assembleSceneShots({ shots, outputPath }) {
  // Filter out shots with invalid sourcePaths
  const validShots = shots.filter(s => {
    if (!s.sourcePath || s.sourcePath === 'none' || s.sourcePath === 'undefined') {
      console.warn('assembleSceneShots: skipping shot with invalid sourcePath:', s.sourcePath);
      return false;
    }
    return true;
  });

  if (validShots.length === 0) throw new Error('assembleSceneShots: no valid shots after filtering invalid paths');

  if (validShots.length === 1) {
    // Scale to 1920x1080 so resolution is consistent for downstream xfade assembly
    const cmd = [
      `"${FFMPEG}" -y`,
      `-i "${validShots[0].sourcePath}"`,
      `-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1"`,
      `-c:v libx264 -preset fast -crf 22`,
      `-c:a copy`,
      `"${outputPath}"`,
    ].join(' ');
    execSync(cmd, { stdio: 'pipe' });
    return outputPath;
  }

  const transitionMap = {
    fade: 'fade',
    dissolve: 'dissolve',
    wipeleft: 'wipeleft',
    slideleft: 'slideleft',
  };

  // Build ffmpeg xfade filter chain
  const inputs = validShots.map(s => `-i "${s.sourcePath}"`).join(' ');
  const SCALE = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1';
  const filters = [];

  // Normalise every input to 1920x1080
  for (let i = 0; i < validShots.length; i++) {
    filters.push(`[${i}:v]${SCALE}[s${i}]`);
  }

  let prevLabel = 's0';

  for (let i = 1; i < validShots.length; i++) {
    const trans = transitionMap[validShots[i].transition] || 'fade';
    const transDur = validShots[i].transitionDuration || 0.5;

    // offset = sum of durations of all previous segments minus sum of previous transition durations
    let offset = 0;
    for (let j = 0; j < i; j++) {
      offset += validShots[j].duration;
    }
    for (let j = 1; j < i; j++) {
      offset -= (validShots[j].transitionDuration || 0.5);
    }
    offset -= transDur;
    offset = Math.max(0, offset);

    const outLabel = i < validShots.length - 1 ? `v${i}` : 'vout';
    filters.push(`[${prevLabel}][s${i}]xfade=transition=${trans}:duration=${transDur}:offset=${offset.toFixed(3)}[${outLabel}]`);
    prevLabel = outLabel;
  }

  const filterComplex = filters.join(';');

  const cmd = [
    `"${FFMPEG}" -y`,
    inputs,
    `-filter_complex "${filterComplex}"`,
    `-map "[vout]"`,
    `-c:v libx264 -preset fast -crf 22`,
    `-c:a aac -b:a 192k`,
    `"${outputPath}"`,
  ].join(' ');

  execSync(cmd, { stdio: 'pipe' });
  return outputPath;
}

/**
 * Assemble all scene videos into the final video with optional xfade transitions and background music.
 * scenePaths = [{ path, transition, transitionDuration }]
 */
export async function assembleAllScenes({ scenePaths, musicPath, outputPath }) {
  if (scenePaths.length === 0) throw new Error('No scenes to assemble');

  if (scenePaths.length === 1 && !musicPath) {
    // Scale to 1920x1080 so resolution is consistent
    const cmd = [
      `"${FFMPEG}" -y`,
      `-i "${scenePaths[0].path}"`,
      `-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1"`,
      `-c:v libx264 -preset medium -crf 22`,
      `-c:a copy`,
      `"${outputPath}"`,
    ].join(' ');
    execSync(cmd, { stdio: 'pipe' });
    return outputPath;
  }

  let videoMap = '0:v';
  let filterComplex = '';

  if (scenePaths.length > 1) {
    const transitionMap = {
      fade: 'fade',
      dissolve: 'dissolve',
      wipeleft: 'wipeleft',
      slideleft: 'slideleft',
    };

    const SCALE = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1';
    const filters = [];

    // Normalise every input to 1920x1080
    for (let i = 0; i < scenePaths.length; i++) {
      filters.push(`[${i}:v]${SCALE}[s${i}]`);
    }

    let prevLabel = 's0';

    for (let i = 1; i < scenePaths.length; i++) {
      const trans = transitionMap[scenePaths[i].transition] || 'fade';
      const transDur = scenePaths[i].transitionDuration || 0.5;

      // Calculate offset: need actual durations from the files
      // For scene assembly, we measure durations from the files
      let offset = 0;
      for (let j = 0; j < i; j++) {
        offset += getDurationSeconds(scenePaths[j].path);
      }
      for (let j = 1; j < i; j++) {
        offset -= (scenePaths[j].transitionDuration || 0.5);
      }
      offset -= transDur;
      offset = Math.max(0, offset);

      const outLabel = i < scenePaths.length - 1 ? `sv${i}` : 'svout';
      filters.push(`[${prevLabel}][s${i}]xfade=transition=${trans}:duration=${transDur}:offset=${offset.toFixed(3)}[${outLabel}]`);
      prevLabel = outLabel;
    }

    filterComplex = filters.join(';');
    videoMap = '"[svout]"';
  }

  const inputs = scenePaths.map(s => `-i "${s.path}"`).join(' ');
  const musicInput = musicPath ? `-i "${musicPath}"` : '';
  const musicIdx = scenePaths.length;

  let audioFilter = '';
  let audioMap = '';

  if (musicPath) {
    // Concatenate all scene audio tracks, then mix with background music at 15%
    const audioInputs = scenePaths.map((_, i) => `[${i}:a]`).join('');
    const concatAudio = `${audioInputs}concat=n=${scenePaths.length}:v=0:a=1[aconcat];[${musicIdx}:a]volume=0.15[bg];[aconcat][bg]amix=inputs=2:duration=first[aout]`;

    if (filterComplex) {
      filterComplex += ';' + concatAudio;
    } else {
      filterComplex = concatAudio;
    }
    audioMap = '-map "[aout]"';
  } else {
    // Concatenate audio from all scenes
    if (scenePaths.length > 1) {
      const audioInputs = scenePaths.map((_, i) => `[${i}:a]`).join('');
      const concatAudio = `${audioInputs}concat=n=${scenePaths.length}:v=0:a=1[aout]`;
      if (filterComplex) {
        filterComplex += ';' + concatAudio;
      } else {
        filterComplex = concatAudio;
      }
      audioMap = '-map "[aout]"';
    } else {
      audioMap = '-map 0:a';
    }
  }

  const filterArg = filterComplex ? `-filter_complex "${filterComplex}"` : '';

  const cmd = [
    `"${FFMPEG}" -y`,
    inputs,
    musicInput,
    filterArg,
    `-map ${videoMap}`,
    audioMap,
    `-c:v libx264 -preset medium -crf 22`,
    `-c:a aac -b:a 192k`,
    `"${outputPath}"`,
  ].filter(Boolean).join(' ');

  execSync(cmd, { stdio: 'pipe' });
  return outputPath;
}

/**
 * Loop a video to fill a target duration.
 */
export async function loopVideoToFill({ inputPath, outputPath, targetDuration }) {
  const cmd = [
    `"${FFMPEG}" -y`,
    `-stream_loop -1`,
    `-i "${inputPath}"`,
    `-t ${targetDuration}`,
    `-c:v libx264 -preset fast -crf 22`,
    `-c:a aac -b:a 192k`,
    `"${outputPath}"`,
  ].join(' ');

  execSync(cmd, { stdio: 'pipe' });
  return outputPath;
}

/**
 * Ping-pong loop a video clip to fill a target duration.
 * Plays forward then reversed to avoid visible jump cuts at loop boundaries.
 */
export async function pingPongLoop(inputPath, targetDuration) {
  const dir = inputPath.replace(/[^/]+$/, '');
  const base = inputPath.replace(/^.*\//, '').replace(/\.\w+$/, '');
  const reversedPath = join(dir, `${base}_reversed.mp4`);
  const cyclePath = join(dir, `${base}_cycle.mp4`);
  const concatListPath = join(dir, `${base}_pp_concat.txt`);
  const loopedPath = join(dir, `${base}_looped.mp4`);

  try {
    // 1. Reverse the clip (video only, no audio)
    execSync([
      `"${FFMPEG}" -y`,
      `-i "${inputPath}"`,
      `-vf reverse -an`,
      `-c:v libx264 -preset fast -crf 22`,
      `"${reversedPath}"`,
    ].join(' '), { stdio: 'pipe' });

    // 2. Concat original + reversed into one seamless cycle
    await fs.writeFile(concatListPath, `file '${inputPath}'\nfile '${reversedPath}'\n`);
    execSync([
      `"${FFMPEG}" -y`,
      `-f concat -safe 0`,
      `-i "${concatListPath}"`,
      `-an -c:v libx264 -preset fast -crf 22`,
      `"${cyclePath}"`,
    ].join(' '), { stdio: 'pipe' });

    // 3. Loop the cycle to fill target duration
    execSync([
      `"${FFMPEG}" -y`,
      `-stream_loop -1`,
      `-i "${cyclePath}"`,
      `-t ${targetDuration}`,
      `-an -c:v libx264 -preset fast -crf 22`,
      `"${loopedPath}"`,
    ].join(' '), { stdio: 'pipe' });
  } finally {
    // Clean up intermediates
    await fs.unlink(reversedPath).catch(() => {});
    await fs.unlink(cyclePath).catch(() => {});
    await fs.unlink(concatListPath).catch(() => {});
  }

  return loopedPath;
}

export { FFMPEG, FFPROBE };
