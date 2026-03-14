// lib/sfx-mixer.mjs — SFX path resolver for per-scene environment audio
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_SFX = join(__dirname, '..', 'assets', 'sfx');

/**
 * Returns the absolute path to the SFX file for the given environment,
 * or null if the file doesn't exist (so callers can skip gracefully).
 *
 * Known environments: forest_day, forest_rain, river, village, night, sky, crowd_children
 */
export function getSfxPath(environment) {
  const env = (environment || 'forest_day').trim();
  const path = join(ASSETS_SFX, `${env}.mp3`);
  return existsSync(path) ? path : null;
}
