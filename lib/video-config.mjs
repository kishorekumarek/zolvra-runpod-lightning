// lib/video-config.mjs — Central video type configuration
// Single source of truth for all video format parameters.
// To switch from shorts to long-form, change DEFAULT_VIDEO_TYPE or pass videoType at pipeline launch.

export const DEFAULT_VIDEO_TYPE = 'short';

export const VIDEO_CONFIGS = {
  short: {
    sceneCount: 9,
    clipDurationSeconds: 10,
    totalDurationSeconds: 90,
    aspectRatio: '9:16',
    resolution: '720p',
    videoScale: '1080:1920',
    minWordsPerScene: 8,
    promptDurationText: '~90s total',
    promptFormatText: 'YouTube Short',
    storyArc: [
      'Intro (scenes 1–2): establish setting, introduce characters',
      'Rising action (scenes 3–5): build tension or adventure',
      'Climax (scenes 6–7): peak emotion or challenge',
      'Resolution (scenes 8–9): resolution and lesson',
    ],
  },
  long: {
    sceneCount: 15,
    clipDurationSeconds: 10,
    totalDurationSeconds: 150,
    aspectRatio: '16:9',
    resolution: '1080p',
    videoScale: '1920:1080',
    minWordsPerScene: 0,
    promptDurationText: '~2.5 minutes',
    promptFormatText: 'Long-form YouTube video',
    storyArc: [
      'Intro (scenes 1–3): establish setting, introduce ALL characters, gentle tone',
      'Rising action (scenes 4–9): build tension or adventure',
      'Climax (scenes 10–12): peak emotion or challenge',
      'Resolution (scenes 13–15): resolution and lesson',
    ],
  },
};

export const DEFAULTS = {
  artStyle: '3D Pixar animation still',
  targetAge: '3-7',
  promptMaxChars: 300,
};

/**
 * Get config for a video type. Falls back to DEFAULT_VIDEO_TYPE if invalid.
 * @param {string} videoType - 'short' or 'long'
 * @returns {object} config object
 */
export function getVideoConfig(videoType) {
  return VIDEO_CONFIGS[videoType] || VIDEO_CONFIGS[DEFAULT_VIDEO_TYPE];
}
