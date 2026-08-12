// stages/stage-07b-teaser-assemble.mjs — Assemble 9:16 teaser Shorts from dual-generated assets
// Gated on concept.teasers_enabled + video_type='long'. Runs AFTER Stage 7 (long video assembly).
//
// Per teaser:
//   1. Generate 2 fresh TTS calls: the shortened character hook line + the contextual narrator outro
//   2. Build the last teaser scene: 9:16 animation + hook audio (0s→hook_dur) + narrator outro (hook_dur→end)
//   3. For earlier teaser scenes: use the long-form audio as-is, merged with the 9:16 animation
//   4. Concatenate → BGM overlay → logo overlay → save to output/{taskId}/teaser_{N}.mp4
//   5. Update teasers row status + local_video_path
//
// A failure on one teaser does NOT abort the stage — it marks that teaser as 'failed' and moves on.
import 'dotenv/config';
import { execSync } from 'child_process';
import { promises as fs, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { sendTelegramMessage } from '../lib/telegram.mjs';
import { downloadFromStorage, BUCKETS } from '../lib/storage.mjs';
import { getBgmPath } from '../lib/bgm-selector.mjs';
import { getDurationSeconds, FFMPEG, FFPROBE } from '../lib/ffmpeg.mjs';
import { VOICE_POOLS, VOICE_MAP, V3_VOICE_SETTINGS } from '../lib/voice-config.mjs';
import { calcTTSCost } from '../lib/cost-tracker.mjs';
import {
  getPipelineState, getConcept, getScenes, getEpisodeCharacter,
  getTeasers, updateTeaser,
} from '../lib/pipeline-db.mjs';

const STAGE = 7.5;
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'output');
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

const NARRATOR_VOICE_ID = VOICE_POOLS.narrator[0];

async function callElevenLabs({ text, voiceId }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

  const response = await fetch(
    `${ELEVENLABS_BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_v3',
        voice_settings: V3_VOICE_SETTINGS,
      }),
    },
  );

  if (!response.ok) {
    let errText;
    try { errText = JSON.stringify(await response.json()); } catch { errText = await response.text(); }
    throw new Error(`ElevenLabs error (${response.status}): ${errText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Resolve a character's voice ID for the teaser last-scene hook TTS.
 * Priority: episode_characters → character_library VOICE_MAP → narrator default.
 */
async function resolveCharacterVoice(taskId, speaker) {
  if (!speaker || speaker.toLowerCase() === 'narrator') return NARRATOR_VOICE_ID;
  const epChar = await getEpisodeCharacter(taskId, speaker);
  if (epChar?.voice_id && epChar.voice_id !== 'PLACEHOLDER') return epChar.voice_id;
  const mapped = VOICE_MAP[speaker.toLowerCase()];
  if (mapped) return mapped;
  return NARRATOR_VOICE_ID;
}

/**
 * Merge a 9:16 animation clip with a mono audio track, scaling to 1080x1920.
 * Used for non-last teaser scenes (reuses long-form audio).
 */
function mergeClipWith9x16Audio({ clipPath, audioPath, outputPath }) {
  const scaleFilter = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';
  const cmd = [
    `"${FFMPEG}" -y`,
    `-i "${clipPath}"`,
    `-i "${audioPath}"`,
    `-vf "${scaleFilter}"`,
    `-c:v libx264 -preset fast -crf 22`,
    `-c:a aac -b:a 192k`,
    `-shortest`,
    `"${outputPath}"`,
  ].join(' ');
  execSync(cmd, { stdio: 'pipe' });
}

/**
 * Build the last teaser scene: 9:16 animation + (hook audio → narrator outro) audio track.
 * Audio: hook_audio plays first, narrator_outro follows immediately. If combined < video duration,
 * silence pads the end. If combined > video duration, `-t <videoDur>` truncates.
 */
function buildLastTeaserScene({ clipPath, hookAudioPath, outroAudioPath, outputPath }) {
  const scaleFilter = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';
  const videoDur = getDurationSeconds(clipPath);
  const fc = [
    `[0:v]${scaleFilter}[vout]`,
    // concat hook + outro audio, then pad with silence to video length
    `[1:a][2:a]concat=n=2:v=0:a=1[concat_a]`,
    `[concat_a]apad=whole_dur=${videoDur.toFixed(3)}[aout]`,
  ].join(';');

  const cmd = [
    `"${FFMPEG}" -y`,
    `-i "${clipPath}"`,
    `-i "${hookAudioPath}"`,
    `-i "${outroAudioPath}"`,
    `-filter_complex "${fc}"`,
    `-map "[vout]" -map "[aout]"`,
    `-c:v libx264 -preset fast -crf 22`,
    `-c:a aac -b:a 192k`,
    `-t ${videoDur.toFixed(3)}`,
    `"${outputPath}"`,
  ].join(' ');
  execSync(cmd, { stdio: 'pipe' });
}

/**
 * Concat a list of already-formatted scene clips into one video (same codec/dims).
 */
function concatClips({ sceneFinalPaths, outputPath, tmpDir }) {
  const listPath = join(tmpDir, `concat_${Date.now()}.txt`);
  // Single-quoted paths per ffmpeg concat demuxer spec; paths that contain a literal single quote
  // would break this, but taskId + scene_XX filenames never contain quotes.
  const listContent = sceneFinalPaths.map(p => `file '${p}'`).join('\n') + '\n';
  writeFileSync(listPath, listContent, 'utf8');
  const cmd = `"${FFMPEG}" -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`;
  execSync(cmd, { stdio: 'pipe' });
}

/**
 * Apply BGM overlay to the concatenated teaser video. Same pattern as Stage 7.
 */
function applyBgmOverlay({ inputPath, bgmPath, outputPath }) {
  const totalDuration = getDurationSeconds(inputPath);
  const fadeOutStart = Math.max(0, totalDuration - 2);

  const fc = [
    `[1:a]volume=0.2,afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=2[bgm_faded]`,
    `[0:a][bgm_faded]amix=inputs=2:duration=first:normalize=0[aout]`,
  ].join(';');

  const cmd = [
    `"${FFMPEG}" -y`,
    `-i "${inputPath}"`,
    `-stream_loop -1 -i "${bgmPath}"`,
    `-t ${totalDuration.toFixed(3)}`,
    `-filter_complex "${fc}"`,
    `-map 0:v -map "[aout]"`,
    `-c:v copy -c:a aac -b:a 192k`,
    `"${outputPath}"`,
  ].join(' ');
  execSync(cmd, { stdio: 'pipe' });
}

/**
 * Apply channel logo overlay to the teaser (top-right, 12% of video width).
 */
function applyLogoOverlay({ inputPath, logoPath, outputPath }) {
  const dims = execSync(
    `"${FFPROBE}" -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "${inputPath}"`,
  ).toString().trim();
  const vidW = parseInt(dims) || 1080;
  const logoW = Math.round(vidW * 0.12);

  const cmd = [
    `"${FFMPEG}" -y`,
    `-i "${inputPath}"`,
    `-i "${logoPath}"`,
    `-filter_complex "[1:v]scale=${logoW}:-1[logo];[0:v][logo]overlay=W-w-40:50[vout]"`,
    `-map "[vout]" -map 0:a`,
    `-c:v libx264 -preset fast -crf 23 -c:a copy`,
    `"${outputPath}"`,
  ].join(' ');
  execSync(cmd, { stdio: 'pipe' });
}

/**
 * Stage 7b: Assemble teaser MP4s. Skipped unless concept.teasers_enabled + video_type='long'.
 */
export async function runStage7b(taskId, tracker, state = {}) {
  console.log('🎬 Stage 7b: Teaser assembly...');

  // ── Gate on concept flags ─────────────────────────────────────────
  const ps = await getPipelineState(taskId);
  if (!ps?.concept_id) throw new Error('Stage 7b: pipeline_state not found or missing concept_id');
  const concept = await getConcept(ps.concept_id);
  if (!concept.teasers_enabled || concept.video_type !== 'long') {
    console.log('  ↩️  Teasers not enabled for this concept — skipping Stage 7b');
    return;
  }

  const teasers = await getTeasers(taskId);
  if (teasers.length === 0) {
    console.log('  ↩️  No teasers in DB — skipping Stage 7b');
    return;
  }

  const scenes = await getScenes(taskId);
  const sceneByNumber = Object.fromEntries(scenes.map(s => [s.scene_number, s]));

  const tmpDir = `/tmp/zolvra-pipeline/${taskId}/teasers`;
  await fs.mkdir(tmpDir, { recursive: true });

  const bgmPath = getBgmPath();
  const logoPath = join(__dirname, '..', 'assets', 'channel-logo.png');
  let logoExists = false;
  try { await fs.access(logoPath); logoExists = true; } catch {}

  let totalChars = 0;
  let assembled = 0;

  for (const teaser of teasers) {
    const teaserDir = join(tmpDir, `teaser_${teaser.teaser_number}`);
    await fs.mkdir(teaserDir, { recursive: true });

    // Resume: already assembled and file still exists → skip
    if (teaser.status === 'assembled' && teaser.local_video_path) {
      try {
        await fs.access(teaser.local_video_path);
        console.log(`  ↩️  Teaser ${teaser.teaser_number} already assembled — skipping`);
        assembled++;
        continue;
      } catch {
        // file missing, re-assemble
      }
    }

    try {
      // ── Verify all teaser scenes have 9:16 animation ───────────────
      const missing = teaser.scene_numbers.filter(n => !sceneByNumber[n]?.animation_url_teaser);
      if (missing.length > 0) {
        throw new Error(`missing 9:16 animations for scenes: ${missing.join(', ')}`);
      }

      // ── Generate TTS: character hook line + narrator outro ──────────
      const lastSceneNum = teaser.scene_numbers[teaser.scene_numbers.length - 1];
      const lastScene = sceneByNumber[lastSceneNum];
      const characterVoiceId = await resolveCharacterVoice(taskId, lastScene.speaker);

      console.log(`  🎙️  Teaser ${teaser.teaser_number}: generating hook TTS (${lastScene.speaker})...`);
      const hookAudioBuf = await callElevenLabs({
        text: teaser.teaser_last_scene_dialogue,
        voiceId: characterVoiceId,
      });
      totalChars += teaser.teaser_last_scene_dialogue.length;
      const hookAudioPath = join(teaserDir, 'hook_audio.mp3');
      await fs.writeFile(hookAudioPath, hookAudioBuf);

      console.log(`  🎙️  Teaser ${teaser.teaser_number}: generating narrator outro TTS...`);
      const outroAudioBuf = await callElevenLabs({
        text: teaser.narrator_outro_tamil,
        voiceId: NARRATOR_VOICE_ID,
      });
      totalChars += teaser.narrator_outro_tamil.length;
      const outroAudioPath = join(teaserDir, 'narrator_outro.mp3');
      await fs.writeFile(outroAudioPath, outroAudioBuf);

      // ── Per-scene assembly ───────────────────────────────────────
      const sceneFinalPaths = [];
      for (let i = 0; i < teaser.scene_numbers.length; i++) {
        const sceneNum = teaser.scene_numbers[i];
        const scene = sceneByNumber[sceneNum];
        const isLast = i === teaser.scene_numbers.length - 1;

        // Download 9:16 animation
        const animBuf = await downloadFromStorage({ bucket: BUCKETS.scenes, path: scene.animation_url_teaser });
        const animPath = join(teaserDir, `scene_${String(sceneNum).padStart(2, '0')}_anim.mp4`);
        await fs.writeFile(animPath, animBuf);

        const sceneFinalPath = join(teaserDir, `scene_${String(sceneNum).padStart(2, '0')}_final.mp4`);

        if (isLast) {
          // Last scene: hook TTS + narrator outro layered over the 9:16 animation
          buildLastTeaserScene({
            clipPath: animPath,
            hookAudioPath,
            outroAudioPath,
            outputPath: sceneFinalPath,
          });
        } else {
          // Earlier scenes: reuse long-form audio as-is
          if (!scene.audio_url) throw new Error(`scene ${sceneNum} missing audio_url`);
          const audioBuf = await downloadFromStorage({ bucket: BUCKETS.scenes, path: scene.audio_url });
          const audioPath = join(teaserDir, `scene_${String(sceneNum).padStart(2, '0')}_audio.mp3`);
          await fs.writeFile(audioPath, audioBuf);
          mergeClipWith9x16Audio({ clipPath: animPath, audioPath, outputPath: sceneFinalPath });
        }

        sceneFinalPaths.push(sceneFinalPath);
      }

      // ── Concat → BGM → logo → persist ────────────────────────────
      const concatPath = join(teaserDir, 'concat.mp4');
      concatClips({ sceneFinalPaths, outputPath: concatPath, tmpDir: teaserDir });

      let withBgmPath = concatPath;
      if (bgmPath) {
        withBgmPath = join(teaserDir, 'with_bgm.mp4');
        applyBgmOverlay({ inputPath: concatPath, bgmPath, outputPath: withBgmPath });
      }

      let finalInterimPath = withBgmPath;
      if (logoExists) {
        finalInterimPath = join(teaserDir, 'with_logo.mp4');
        applyLogoOverlay({ inputPath: withBgmPath, logoPath, outputPath: finalInterimPath });
      }

      // Persist to output dir alongside the long video
      const outputDir = join(OUTPUT_DIR, taskId);
      await fs.mkdir(outputDir, { recursive: true });
      const persistentPath = join(outputDir, `teaser_${teaser.teaser_number}.mp4`);
      await fs.copyFile(finalInterimPath, persistentPath);

      const duration = getDurationSeconds(persistentPath);

      await updateTeaser(taskId, teaser.teaser_number, {
        local_video_path: persistentPath,
        final_duration_seconds: duration,
        status: 'assembled',
      });

      assembled++;
      console.log(`  ✓ Teaser ${teaser.teaser_number} (${teaser.archetype}) assembled: ${duration.toFixed(1)}s → ${persistentPath}`);
    } catch (err) {
      console.warn(`  ⚠️  Teaser ${teaser.teaser_number} failed: ${err.message}`);
      await updateTeaser(taskId, teaser.teaser_number, { status: 'failed' }).catch(() => {});
      await sendTelegramMessage(`⚠️ Teaser ${teaser.teaser_number} (${teaser.archetype}) failed: ${err.message}`);
    }
  }

  // Cost: TTS for teasers
  if (totalChars > 0) {
    const cost = calcTTSCost(totalChars, 1);
    tracker.addCost(STAGE, cost);
    console.log(`  Teaser TTS total: ${totalChars} chars = $${cost.toFixed(4)}`);
  }

  await sendTelegramMessage(`✅ Stage 7b complete — ${assembled}/${teasers.length} teasers assembled`);
  console.log(`✅ Stage 7b complete. ${assembled}/${teasers.length} teasers assembled`);
}
