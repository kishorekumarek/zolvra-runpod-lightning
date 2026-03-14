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
  excited:  { stability: 0.5 },
  happy:    { stability: 0.5 },
  sad:      { stability: 0.5 },
  scared:   { stability: 0.5 },
  gentle:   { stability: 0.5 },
  whisper:  { stability: 0.5 },
  angry:    { stability: 0.5 },
  normal:   { stability: 0.5 },
};
