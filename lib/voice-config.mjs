// lib/voice-config.mjs — ElevenLabs voice IDs for Tiny Tamil Tales
// Updated 2026-03-17: ElevenLabs v3 uses empty voice_settings + audio tags in text.
// Emotion is controlled via [audio_tags], ... pauses, and CAPITALS in the dialogue text.

export const VOICE_MAP = {
  narrator:  'XCVlHBLvc3SVXhH7pRkb',  // Narrator Female TTT
  kavin:     'oDV9OTaNLmINQYHfVOXe',  // Cubbie (male child)
  arjun:     'oDV9OTaNLmINQYHfVOXe',  // Cubbie (male child)
  kaavya:    '2zRM7PkgwBPiau2jvVXc',  // Female child (updated 2026-03-17)
  kaviya:    '2zRM7PkgwBPiau2jvVXc',  // Alias → same as kaavya
  meenu:     'Sm1seazb4gs7RSlUVw7c',  // Female child younger (updated 2026-03-17)
  kitti:     'T4QhgFpOCsg0hCcSOUYw',  // Hunter 1 TTT
  valli:     '2zRM7PkgwBPiau2jvVXc',  // Uses kaavya voice (old Mridula ID is dead)
  sparrows:  'KNmZI8RXLqk94uYj1GaH',  // Hunter 2 TTT (group children)
  children:  'KNmZI8RXLqk94uYj1GaH',  // Hunter 2 TTT (group children)
  elder:     'JL7VCc7O6rY87Cfz9kIO',  // Mukundan
  default:   'XCVlHBLvc3SVXhH7pRkb',
};

// ElevenLabs v3: voice_settings must be {} (empty).
// All emotion is controlled via audio tags in the text:
//   [excited], [surprised], [whispers], [sighs], [mischievously],
//   [curious], [gently], [hopeful], [thoughtful], [laughing], [giggling]
// Pauses: ... (ellipses)  |  Emphasis: CAPITAL LETTERS
export const V3_VOICE_SETTINGS = {};

// Legacy EMOTION_SETTINGS kept for backward compatibility but NOT used with v3.
// Stage 6 now passes V3_VOICE_SETTINGS instead.
export const EMOTION_SETTINGS = {
  excited:  {},
  happy:    {},
  sad:      {},
  scared:   {},
  gentle:   {},
  whisper:  {},
  angry:    {},
  normal:   {},
  awe:      {},
  wonder:   {},
};
