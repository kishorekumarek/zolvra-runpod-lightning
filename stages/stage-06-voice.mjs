// stages/stage-06-voice.mjs — ElevenLabs TTS per scene using voice-config emotion settings
// Auto-stage — checks isFeedbackCollectionMode()
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode } from '../lib/settings.mjs';
import { createNexusCard } from '../lib/nexus-client.mjs';
import { withRetry } from '../lib/retry.mjs';
import { calcTTSCost } from '../lib/cost-tracker.mjs';
import { VOICE_MAP, EMOTION_SETTINGS } from '../lib/voice-config.mjs';

const STAGE = 6;
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

/**
 * Call ElevenLabs TTS directly with per-emotion voice settings.
 * Returns a Buffer of the MP3.
 */
async function callElevenLabs({ text, voiceId, voiceSettings }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

  const response = await fetch(
    `${ELEVENLABS_BASE}/text-to-speech/${voiceId}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        language_code: 'ta',
        voice_settings: voiceSettings,
        output_format: 'mp3_44100_128',
      }),
    }
  );

  if (!response.ok) {
    let errText;
    try {
      const errData = await response.json();
      errText = JSON.stringify(errData);
    } catch {
      errText = await response.text();
    }
    throw new Error(`ElevenLabs error (${response.status}): ${errText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Stage 6: Generate voice audio for each scene using per-speaker voice IDs
 * and per-emotion TTS settings from voice-config.mjs.
 */
export async function runStage6(taskId, tracker, state = {}) {
  console.log('🎙️  Stage 6: Voice generation...');

  const { scenes, tmpDir, parentCardId } = state;
  if (!scenes) throw new Error('Stage 6: scenes not found');
  if (!tmpDir) throw new Error('Stage 6: tmpDir not found');

  const sb = getSupabase();
  const audioDir = join(tmpDir, 'audio');
  await fs.mkdir(audioDir, { recursive: true });

  const sceneAudioPaths = {}; // sceneNumber → audio file path
  let totalChars = 0;

  for (const scene of scenes) {
    const sceneLabel = String(scene.scene_number).padStart(2, '0');
    const voiceId = VOICE_MAP[scene.speaker?.toLowerCase()] ?? VOICE_MAP.default;
    const voiceSettings = EMOTION_SETTINGS[scene.emotion?.toLowerCase()] ?? EMOTION_SETTINGS.normal;

    console.log(`  Scene ${scene.scene_number}: speaker=${scene.speaker} → voice=${voiceId}, emotion=${scene.emotion}`);

    const audioBuffer = await withRetry(
      () => callElevenLabs({ text: scene.text, voiceId, voiceSettings }),
      { maxRetries: 3, baseDelayMs: 10000, stage: STAGE, taskId }
    );

    const audioPath = join(audioDir, `scene_${sceneLabel}_audio.mp3`);
    await fs.writeFile(audioPath, audioBuffer);

    sceneAudioPaths[scene.scene_number] = audioPath;
    totalChars += scene.text.length;
    console.log(`  ✓ Scene ${scene.scene_number} voiced`);
  }

  const cost = calcTTSCost(totalChars, 1);
  tracker.addCost(STAGE, cost);
  console.log(`  TTS total: ${totalChars} chars = $${cost.toFixed(4)}`);

  // Feedback collection mode — review audio
  if (await isFeedbackCollectionMode()) {
    await feedbackReviewAudio({ taskId, sceneAudioPaths, parentCardId, sb });
  }

  console.log(`✅ Stage 6 complete. ${Object.keys(sceneAudioPaths).length} scenes voiced`);
  return { ...state, sceneAudioPaths };
}

async function feedbackReviewAudio({ taskId, sceneAudioPaths, parentCardId, sb }) {
  console.log('  📋 Feedback collection mode: requesting audio review...');

  const pathList = Object.entries(sceneAudioPaths)
    .map(([n, path]) => `Scene ${n}: ${path}`)
    .join('\n');

  const cardId = await createNexusCard({
    title: `[Feedback] Stage 6: Voice Audio Review`,
    description: [
      `Feedback collection mode: Please review the Tamil voice audio for all scenes.`,
      `\n**Audio files (local paths):**\n${pathList}`,
      `\nApprove to continue, or Request Changes with specific feedback (e.g., "too fast", "wrong emotion for scene 3").`,
    ].join('\n'),
    task_type: 'stage_review',
    priority: 'medium',
    parent_id: parentCardId,
    stream: 'youtube',
  });

  console.log(`  NEXUS audio review card created: ${cardId} (non-blocking)`);
}
