/**
 * Stage ID constants for the YouTube pipeline.
 * Slice 1 of the stage number → string ID refactor.
 * Nothing imports this yet — it's the foundation for Slices 2-5.
 */

// String ID for each pipeline stage
export const STAGES = {
  CONCEPT:     'concept',
  SCRIPT:      'script',
  CHARACTERS:  'characters',
  TTS:         'tts',
  ILLUSTRATE:  'illustrate',
  ANIMATE:     'animate',
  ASSEMBLE:    'assemble',
  QUEUE:       'queue',
};

// Maps legacy integer stage numbers to string IDs
// Used in Slice 2 for DB backfill migration
export const STAGE_NUM_TO_ID = {
  1: 'concept',
  2: 'script',
  3: 'characters',
  6: 'tts',
  4: 'illustrate',
  5: 'animate',
  7: 'assemble',
  8: 'queue',
};

// Execution order — explicit array (JS sorts integer-like object keys numerically)
export const STAGE_ORDER = [
  'concept', 'script', 'characters', 'tts', 'illustrate', 'animate', 'assemble', 'queue'
];
