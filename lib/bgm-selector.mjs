// lib/bgm-selector.mjs — BGM track selector
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_BGM = join(__dirname, '..', 'assets', 'bgm');

/**
 * Returns the path to the primary BGM track, or null if not yet downloaded.
 * Run scripts/download-sfx.mjs first to populate assets/bgm/.
 */
export function getBgmPath() {
  const path = join(ASSETS_BGM, 'kids_folk_01.mp3');
  return existsSync(path) ? path : null;
}
