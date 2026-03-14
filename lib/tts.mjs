// lib/tts.mjs — ElevenLabs TTS + SSML builder
import 'dotenv/config';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

/**
 * Escape XML special characters for SSML.
 */
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build SSML for Tamil TTS with appropriate pacing for kids content.
 */
export function buildSSML(text, emotion, settings = {}) {
  const ssmlDefaults = settings.ssml_defaults || {};

  // Determine rate based on emotion
  let rate;
  if (emotion === 'excited') rate = 'medium';
  else if (emotion === 'calm') rate = 'x-slow';
  else rate = ssmlDefaults.narrator_rate || 'slow';

  const pauseMs = ssmlDefaults.pause_between_lines_ms ?? 600;

  // ElevenLabs supports a subset of SSML
  return `<speak>
  <prosody rate="${rate}">
    ${escapeXml(text)}
  </prosody>
  <break time="${pauseMs}ms"/>
</speak>`;
}

/**
 * Generate speech for a single line via ElevenLabs.
 * Returns a Buffer of the MP3.
 */
export async function generateSpeech({ text, voiceId, emotion = 'warm', settings = {} }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');
  if (!voiceId) throw new Error('voiceId is required');

  const ssml = buildSSML(text, emotion, settings);
  const ssmlDefaults = settings.ssml_defaults || {};

  const body = {
    text: ssml,
    model_id: 'eleven_multilingual_v2',
    voice_settings: {
      stability:         settings.tts_stability ?? 0.5,
      similarity_boost:  settings.tts_similarity_boost ?? 0.75,
      style:             settings.tts_style ?? 0.45,
      use_speaker_boost: true,
    },
    output_format: 'mp3_44100_128',
  };

  const response = await fetch(
    `${ELEVENLABS_BASE}/text-to-speech/${voiceId}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
 * Estimate TTS cost: ElevenLabs charges ~$0.30 per 1000 chars for multilingual v2.
 */
export function estimateTTSCost(textLength, takes = 1) {
  return (textLength * takes * 0.30) / 1000;
}
