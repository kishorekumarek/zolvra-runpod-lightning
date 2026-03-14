// lib/tts-takes.mjs — 2-take TTS generation + auto-select (shortest = best)
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { generateSpeech } from './tts.mjs';
import 'dotenv/config';

/**
 * Get audio duration in milliseconds via ffprobe.
 */
async function getAudioDurationMs(buffer) {
  const ffmpegPath = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
  const ffprobePath = ffmpegPath.replace('ffmpeg', 'ffprobe');
  const tmpPath = `/tmp/take-check-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;

  try {
    await fs.writeFile(tmpPath, buffer);
    const result = execSync(
      `"${ffprobePath}" -v error -show_entries format=duration -of csv=p=0 "${tmpPath}"`
    ).toString().trim();
    return parseFloat(result) * 1000;
  } finally {
    try { await fs.unlink(tmpPath); } catch {}
  }
}

/**
 * Generate 2 TTS takes and auto-select the best one.
 * Selection criterion: shorter duration (fewer trailing silences).
 * Returns { buffer, takeNumber, durations }
 */
export async function generateTwoTakesAndPick({ text, voiceId, emotion, settings }) {
  const [take1, take2] = await Promise.all([
    generateSpeech({ text, voiceId, emotion, settings }),
    generateSpeech({ text, voiceId, emotion, settings }),
  ]);

  let dur1, dur2;
  try {
    [dur1, dur2] = await Promise.all([
      getAudioDurationMs(take1),
      getAudioDurationMs(take2),
    ]);
  } catch (err) {
    // If duration check fails, default to take1
    console.warn('Duration check failed, defaulting to take 1:', err.message);
    return { buffer: take1, takeNumber: 1, durations: [null, null] };
  }

  const picked = dur1 <= dur2 ? take1 : take2;
  const takeNumber = dur1 <= dur2 ? 1 : 2;

  console.log(`  TTS takes: take1=${dur1?.toFixed(0)}ms, take2=${dur2?.toFixed(0)}ms → picked take${takeNumber}`);

  return {
    buffer: picked,
    takeNumber,
    durations: [dur1, dur2],
  };
}

/**
 * Generate audio for all lines in a scene.
 * Returns array of { buffer, speaker, emotion, lineIndex }
 */
export async function generateSceneAudio({ scene, characterMap, settings }) {
  const results = [];

  for (let i = 0; i < scene.lines.length; i++) {
    const line = scene.lines[i];
    const speakerName = line.speaker ?? line.character;
    // Fuzzy match: exact → case-insensitive first-word match → NARRATOR fallback
    const character = characterMap[speakerName]
      ?? Object.entries(characterMap).find(([k]) =>
           k.toLowerCase().startsWith(speakerName.toLowerCase()) ||
           speakerName.toLowerCase().startsWith(k.toLowerCase().split(' ')[0])
         )?.[1]
      ?? characterMap['NARRATOR'];

    if (!character) {
      throw new Error(`Character not found: ${speakerName}`);
    }

    const voiceId = character.voice_id;
    console.log(`  Generating TTS: scene ${scene.scene_number}, line ${i + 1} (${line.speaker ?? line.character})`);

    const { buffer } = await generateTwoTakesAndPick({
      text: line.text,
      voiceId,
      emotion: line.emotion || 'warm',
      settings,
    });

    results.push({
      buffer,
      speaker: line.speaker,
      emotion: line.emotion,
      lineIndex: i,
      text: line.text,
    });
  }

  return results;
}
