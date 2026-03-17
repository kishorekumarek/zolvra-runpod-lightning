// lib/tts.mjs — ElevenLabs TTS v3 wrapper
// Updated 2026-03-17: v3 uses audio tags in text for emotion, NOT voice_settings or SSML.
import 'dotenv/config';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

/**
 * Generate speech for a single line via ElevenLabs v3.
 * Emotion is controlled via audio tags in the text:
 *   [excited], [surprised], [whispers], [sighs], [laughing], etc.
 * Pauses via ... (ellipses), emphasis via CAPITAL LETTERS.
 * voice_settings must be {} (empty) for v3.
 *
 * Returns a Buffer of the MP3.
 */
export async function generateSpeech({ text, voiceId }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');
  if (!voiceId) throw new Error('voiceId is required');

  const response = await fetch(
    `${ELEVENLABS_BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_v3',
        voice_settings: {},
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
 * Estimate TTS cost: ElevenLabs v3 pricing (~$0.30 per 1000 chars).
 */
export function estimateTTSCost(textLength, takes = 1) {
  return (textLength * takes * 0.30) / 1000;
}
