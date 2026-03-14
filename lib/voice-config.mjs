// lib/voice-config.mjs — ElevenLabs voice IDs and emotion-based TTS settings

export const VOICE_MAP = {
  narrator:  'XCVlHBLvc3SVXhH7pRkb',
  pandi:     'oDV9OTaNLmINQYHfVOXe',
  kitti:     'T4QhgFpOCsg0hCcSOUYw',
  valli:     'DNLl3gCCSh2dfb1WDBpZ',
  children:  'KNmZI8RXLqk94uYj1GaH',
  elder:     'JL7VCc7O6rY87Cfz9kIO',
  default:   'XCVlHBLvc3SVXhH7pRkb',
};

export const EMOTION_SETTINGS = {
  excited:  { stability: 0.25, similarity_boost: 0.75, style: 0.8,  use_speaker_boost: true  },
  happy:    { stability: 0.3,  similarity_boost: 0.75, style: 0.7,  use_speaker_boost: true  },
  sad:      { stability: 0.4,  similarity_boost: 0.8,  style: 0.6,  use_speaker_boost: false },
  scared:   { stability: 0.2,  similarity_boost: 0.8,  style: 0.9,  use_speaker_boost: true  },
  gentle:   { stability: 0.6,  similarity_boost: 0.75, style: 0.3,  use_speaker_boost: false },
  whisper:  { stability: 0.7,  similarity_boost: 0.9,  style: 0.1,  use_speaker_boost: false },
  angry:    { stability: 0.2,  similarity_boost: 0.7,  style: 0.95, use_speaker_boost: true  },
  normal:   { stability: 0.5,  similarity_boost: 0.75, style: 0.4,  use_speaker_boost: false },
};
