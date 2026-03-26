// lib/voice-config.mjs — ElevenLabs voice IDs for Tiny Tamil Tales
// Updated 2026-03-23: Voice pools for auto-assignment based on character type.
// Emotion is controlled via [audio_tags], ... pauses, and CAPITALS in the dialogue text.

// ── Voice pools by character type ─────────────────────────────────────
// Each pool contains multiple voices to distribute across characters (avoids same voice for all)

export const VOICE_POOLS = {
  kid: [
    'oDV9OTaNLmINQYHfVOXe',
    'RorsnEh2ruIScbiOoQ0U',
    'L4XxUDcjnpYCE7Ta4dei',
    'a49ffQsGpRBw28CL67GF',
    'gqFUMFHCD2nbbcYVtPGB',
    'IC6fkbI5BN65xFmhUCbY',
    'gCr8TeSJgJaeaIoV4RWH',
  ],
  elder_male: [
    'cjOGFz1Snb7UCL8fUnQS',
    'wXxycuulqRIQdKfvqnVR',
    'JL7VCc7O6rY87Cfz9kIO',
    'T4QhgFpOCsg0hCcSOUYw',
    'KNmZI8RXLqk94uYj1GaH',
    'qDuRKMlYmrm8trt5QyBn',
  ],
  elder_female: [
    '2zRM7PkgwBPiau2jvVXc',
    'Sm1seazb4gs7RSlUVw7c',
    'DNLl3gCCSh2dfn1WDBpZ',
  ],
  narrator: [
    'XCVlHBLvc3SVXhH7pRkb',
  ],
};

// ── Legacy per-character map (still used as first lookup in Stage 6) ──
export const VOICE_MAP = {
  narrator:  'XCVlHBLvc3SVXhH7pRkb',
  kavin:     'oDV9OTaNLmINQYHfVOXe',
  arjun:     'oDV9OTaNLmINQYHfVOXe',
  kaavya:    '2zRM7PkgwBPiau2jvVXc',
  kaviya:    '2zRM7PkgwBPiau2jvVXc',
  meenu:     'RorsnEh2ruIScbiOoQ0U',
  kitti:     'T4QhgFpOCsg0hCcSOUYw',
  valli:     '2zRM7PkgwBPiau2jvVXc',
  sparrows:  'KNmZI8RXLqk94uYj1GaH',
  children:  'KNmZI8RXLqk94uYj1GaH',
  elder:     'JL7VCc7O6rY87Cfz9kIO',
  siva:      'cjOGFz1Snb7UCL8fUnQS',
  seetha:    '2zRM7PkgwBPiau2jvVXc',
  shopkeeper:'wXxycuulqRIQdKfvqnVR',
  villagers: 'KNmZI8RXLqk94uYj1GaH',
  default:   'XCVlHBLvc3SVXhH7pRkb',
};

// ElevenLabs v3: voice_settings must be {} (empty).
// All emotion is controlled via audio tags in the text:
//   [excited], [surprised], [whispers], [sighs], [mischievously],
//   [curious], [gently], [hopeful], [thoughtful], [laughing], [giggling]
// Pauses: ... (ellipses)  |  Emphasis: CAPITAL LETTERS
export const V3_VOICE_SETTINGS = {};

/**
 * Pick a voice ID from the appropriate pool based on character type.
 * Uses a simple round-robin within each pool to distribute voices across characters.
 *
 * @param {'kid'|'elder_male'|'elder_female'|'narrator'} characterType
 * @param {Set<string>} [usedVoiceIds] - voices already assigned to other characters in this episode
 * @returns {string} voice ID
 */
export function pickVoiceFromPool(characterType, usedVoiceIds = new Set()) {
  const pool = VOICE_POOLS[characterType] || VOICE_POOLS.kid;

  // Prefer a voice not yet used in this episode
  const unused = pool.filter(v => !usedVoiceIds.has(v));
  if (unused.length > 0) return unused[0];

  // All used — pick the first in pool (some voice reuse is inevitable)
  return pool[0];
}
