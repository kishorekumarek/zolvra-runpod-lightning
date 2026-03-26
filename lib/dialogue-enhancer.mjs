// lib/dialogue-enhancer.mjs — Enhance dialogue with ElevenLabs v3 audio tags
// Uses Haiku to add [audio_tags], extended vowels for emphasis, and ... for pauses
import { callClaude } from '../../shared/claude.mjs';

const ENHANCE_SYSTEM_PROMPT = `You are an AI assistant specializing in enhancing Tamil dialogue text for ElevenLabs v3 speech generation.

Your PRIMARY GOAL is to dynamically integrate audio tags (e.g., [laughing], [sighs], [birds chirping]) into dialogue, making it more expressive and immersive for auditory experiences, while STRICTLY preserving the original Tamil words and meaning.

CORE RULES:
- DO integrate voice direction tags, non-verbal tags, AND environmental sound effect tags from the lists below.
- DO place audio tags strategically before or after the dialogue segment they modify (e.g., "[excited] நான் ரொம்பாாா குஷி!" or "[birds chirping] நான் குஷி... [sighs] ஆனா என்ன செய்ய?").
- DO add environmental sound effects that match the scene's visual description to create an immersive audio experience.
- DO add emphasis by extending vowels for excitement (e.g., ரொம்பாாா!, சூப்பர்ர்ர்!, wowwww!), and use !, ?, ... for emotional punctuation.
- DO add ... (ellipses) for natural pauses where dramatic effect helps.
- DO NOT use CAPITALS for emphasis — Tamil script has no uppercase. Use extended vowels and punctuation instead.
- DO NOT alter, add, or remove any Tamil words from the original text. Only add tags, emphasis, and punctuation.
- DO NOT use visual-only tags like [standing], [grinning], [pacing] — tags must produce SOUND.
- DO NOT invent new dialogue lines.
- DO NOT overload a single line with too many tags — 2-3 tags per scene is ideal, max 4.

VOICE DIRECTION TAGS:
[happy], [sad], [excited], [angry], [whisper], [annoyed], [thoughtful], [surprised], [gentle], [curious], [hopeful], [mischievously]

NON-VERBAL VOICE TAGS:
[laughing], [chuckles], [sighs], [clears throat], [short pause], [long pause], [exhales sharply], [inhales deeply], [giggling], [gasps]

ENVIRONMENTAL SOUND EFFECT TAGS (use based on visual_description context):
Nature: [birds chirping], [wind blowing], [thunder], [rain], [water flowing], [leaves rustling], [crickets]
Actions: [footsteps], [splash], [knock], [clapping], [applause]
Animals: [rooster crowing], [dog barking], [cat meowing]

OUTPUT FORMAT:
Return ONLY a JSON array of objects with scene_number and enhanced_text. No markdown fences, no explanation.
Example: [{"scene_number": 1, "enhanced_text": "[birds chirping] [gentle] ஒரு நாள்... ஒரு அழகான காட்டுல, ஒரு சின்ன மயில் இருந்துச்சு."}]`;

/**
 * Enhance all scenes' dialogue with v3 audio tags in a single batched Haiku call.
 * @param {Array<{scene_number: number, speaker: string, emotion: string, text: string}>} scenes
 * @returns {Promise<Record<number, string>>} Map of scene_number → enhanced text
 */
export async function enhanceDialoguesForTTS(scenes) {
  if (!scenes || scenes.length === 0) return {};

  const userContent = scenes.map(s =>
    `Scene ${s.scene_number} | Speaker: ${s.speaker} | Emotion: ${s.emotion} | Visual: ${s.visual_description || 'none'} | Text: ${s.text}`
  ).join('\n');

  const message = await callClaude({
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 4096,
    system: ENHANCE_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Enhance the following Tamil script dialogue lines for ElevenLabs v3 TTS. Use the speaker and emotion context to choose appropriate audio tags, extended vowels for emphasis, and punctuation. Do NOT use CAPITALS — Tamil has no uppercase.\n\n${userContent}\n\nReturn ONLY a JSON array. No markdown fences.`,
    }],
  });

  let text = message.content[0]?.text?.trim() || '';
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error('  ⚠️  Failed to parse dialogue enhancement response:', err.message);
    console.error('  Raw response:', text.slice(0, 500));
    // Fallback: return original texts with emotion tag prepended
    return fallbackEnhance(scenes);
  }

  if (!Array.isArray(parsed)) {
    console.warn('  ⚠️  Enhancement response is not an array — using fallback');
    return fallbackEnhance(scenes);
  }

  const result = {};
  for (const item of parsed) {
    if (item.scene_number && item.enhanced_text) {
      result[item.scene_number] = item.enhanced_text;
    }
  }

  // Fill in any missing scenes with fallback
  for (const scene of scenes) {
    if (!result[scene.scene_number]) {
      result[scene.scene_number] = `[${scene.emotion}] ${scene.text}`;
    }
  }

  return result;
}

/**
 * Enhance a single scene's dialogue (used for re-enhancement after modification).
 * @param {{scene_number: number, speaker: string, emotion: string, text: string}} scene
 * @returns {Promise<string>} Enhanced text
 */
export async function enhanceSingleDialogue(scene) {
  const result = await enhanceDialoguesForTTS([scene]);
  return result[scene.scene_number] || `[${scene.emotion}] ${scene.text}`;
}

/**
 * Fallback: prepend emotion as audio tag if LLM call fails.
 */
function fallbackEnhance(scenes) {
  const result = {};
  for (const scene of scenes) {
    result[scene.scene_number] = `[${scene.emotion}] ${scene.text}`;
  }
  return result;
}
