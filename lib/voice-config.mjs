// lib/voice-config.mjs — ElevenLabs voice IDs and emotion-based TTS settings

export const VOICE_MAP = {
  narrator:  'XCVlHBLvc3SVXhH7pRkb',
  paandi:    'oDV9OTaNLmINQYHfVOXe',
  kitti:     'T4QhgFpOCsg0hCcSOUYw',
  valli:     'DNLl3gCCSh2dfb1WDBpZ',
  children:  'KNmZI8RXLqk94uYj1GaH',
  elder:     'JL7VCc7O6rY87Cfz9kIO',
  default:   'XCVlHBLvc3SVXhH7pRkb',
};

export const EMOTION_SETTINGS = {
  excited:  { stability: 0.45, similarity_boost: 0.42, style: 0.20, use_speaker_boost: true, speed: 0.95 },
  happy:    { stability: 0.5,  similarity_boost: 0.42, style: 0.18, use_speaker_boost: true, speed: 0.92 },
  sad:      { stability: 0.6,  similarity_boost: 0.42, style: 0.12, use_speaker_boost: true, speed: 0.88 },
  scared:   { stability: 0.4,  similarity_boost: 0.42, style: 0.15, use_speaker_boost: true, speed: 0.90 },
  gentle:   { stability: 0.55, similarity_boost: 0.42, style: 0.15, use_speaker_boost: true, speed: 0.92 },
  whisper:  { stability: 0.65, similarity_boost: 0.42, style: 0.08, use_speaker_boost: true, speed: 0.88 },
  angry:    { stability: 0.4,  similarity_boost: 0.42, style: 0.20, use_speaker_boost: true, speed: 0.95 },
  normal:   { stability: 0.55, similarity_boost: 0.42, style: 0.15, use_speaker_boost: true, speed: 0.92 },
};
