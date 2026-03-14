// lib/motion-params.mjs — Kling motion type → params mapping
import { getSetting } from './settings.mjs';

const DEFAULTS = {
  dialogue: {
    duration: 10,
    cfg_scale: 0.4,
    mode: 'std',
    prompt_suffix: 'character talking gently, subtle body movement, stable frame',
  },
  action: {
    duration: 10,
    cfg_scale: 0.6,
    mode: 'std',
    prompt_suffix: 'dynamic movement, camera follows character, lively motion',
  },
  landscape: {
    duration: 10,
    cfg_scale: 0.3,
    mode: 'std',
    prompt_suffix: 'slow parallax pan, peaceful drift, establishing mood',
  },
  emotional: {
    duration: 10,
    cfg_scale: 0.5,
    mode: 'std',
    prompt_suffix: 'gentle breathing, subtle facial expression, close emotional moment',
  },
};

/**
 * Get Kling parameters for a given motion type.
 * Merges pipeline_settings overrides if available.
 */
export async function getKlingParams(motionType) {
  const base = DEFAULTS[motionType] ?? DEFAULTS.dialogue;

  // Try to get overrides from pipeline_settings
  let overrides = {};
  try {
    const settingsOverrides = await getSetting('kling_motion_type_defaults');
    if (settingsOverrides && settingsOverrides[motionType]) {
      overrides = settingsOverrides[motionType];
    }
  } catch {
    // Settings not available yet — use defaults
  }

  return { ...base, ...overrides };
}

/**
 * Synchronous version using raw settings object (when already fetched).
 */
export function getKlingParamsSync(motionType, settingsOverrides = {}) {
  const base = DEFAULTS[motionType] ?? DEFAULTS.dialogue;
  const override = settingsOverrides[motionType] ?? {};
  return { ...base, ...override };
}

export { DEFAULTS as KLING_DEFAULTS };
