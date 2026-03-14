#!/usr/bin/env node
// scripts/download-audio.mjs
// Downloads CC0/public domain SFX and BGM from archive.org and freesound previews
// Run: node scripts/download-audio.mjs

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SFX_DIR = join(ROOT, 'assets', 'sfx');
const BGM_DIR = join(ROOT, 'assets', 'bgm');

// All CC0 / Public Domain sources from archive.org
const SFX_FILES = [
  {
    name: 'forest_day',
    file: 'forest_day.mp3',
    url: 'https://www.soundsnap.com/download_sound/1534825', // fallback below
    urls: [
      'https://archive.org/download/SoundEffects_201410/Birds%20in%20Forest.mp3',
      'https://archive.org/download/free-sound-effects-nature/birds-forest-nature-ambience.mp3',
    ]
  },
  {
    name: 'forest_rain',
    file: 'forest_rain.mp3',
    urls: [
      'https://archive.org/download/rainforest_ambient/rainforest_ambient.mp3',
      'https://archive.org/download/free-sound-effects-nature/rain-in-forest.mp3',
      'https://archive.org/download/SoundEffects_201410/Rain%20in%20Forest.mp3',
    ]
  },
  {
    name: 'river',
    file: 'river.mp3',
    urls: [
      'https://archive.org/download/free-sound-effects-nature/river-stream.mp3',
      'https://archive.org/download/SoundEffects_201410/River%20Stream.mp3',
    ]
  },
  {
    name: 'village',
    file: 'village.mp3',
    urls: [
      'https://archive.org/download/free-sound-effects-nature/village-ambient.mp3',
      'https://archive.org/download/SoundEffects_201410/Village%20Ambient.mp3',
    ]
  },
  {
    name: 'night',
    file: 'night.mp3',
    urls: [
      'https://archive.org/download/free-sound-effects-nature/night-crickets-frogs.mp3',
      'https://archive.org/download/SoundEffects_201410/Night%20Crickets.mp3',
    ]
  },
  {
    name: 'sky',
    file: 'sky.mp3',
    urls: [
      'https://archive.org/download/free-sound-effects-nature/wind-open-air.mp3',
      'https://archive.org/download/SoundEffects_201410/Wind%20Howling.mp3',
    ]
  },
  {
    name: 'crowd_children',
    file: 'crowd_children.mp3',
    urls: [
      'https://archive.org/download/free-sound-effects-people/children-playing-outside.mp3',
      'https://archive.org/download/SoundEffects_201410/Children%20Playing.mp3',
    ]
  },
];

const BGM_FILES = [
  {
    name: 'kids_folk_01',
    file: 'kids_folk_01.mp3',
    urls: [
      // Kevin MacLeod - CC BY (incompetech.com) — warm Indian-ish folk
      'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Carefree.mp3',
      'https://archive.org/download/kevin-macleod-music/Carefree.mp3',
    ]
  },
  {
    name: 'kids_folk_02',
    file: 'kids_folk_02.mp3',
    urls: [
      'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Ukulele.mp3',
      'https://archive.org/download/kevin-macleod-music/Ukulele.mp3',
    ]
  },
  {
    name: 'kids_warm_01',
    file: 'kids_warm_01.mp3',
    urls: [
      'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Friendly%20Day.mp3',
      'https://archive.org/download/kevin-macleod-music/Friendly_Day.mp3',
    ]
  },
];

async function tryDownload(urls, destPath) {
  for (const url of urls) {
    try {
      execSync(
        `curl -fsSL --max-time 15 -A "Mozilla/5.0" -o "${destPath}" "${url}"`,
        { stdio: 'pipe' }
      );
      // Validate it's real audio
      execSync(`ffprobe -v quiet -show_streams "${destPath}"`, { stdio: 'pipe' });
      return url;
    } catch {
      // try next
    }
  }
  return null;
}

async function main() {
  await fs.mkdir(SFX_DIR, { recursive: true });
  await fs.mkdir(BGM_DIR, { recursive: true });

  console.log('📥 Downloading SFX...\n');
  for (const sfx of SFX_FILES) {
    const dest = join(SFX_DIR, sfx.file);
    const used = await tryDownload(sfx.urls, dest);
    if (used) {
      const stat = await fs.stat(dest);
      console.log(`  ✅ ${sfx.name} (${(stat.size/1024).toFixed(0)}KB)`);
    } else {
      console.log(`  ⚠️  ${sfx.name} — all URLs failed, keeping placeholder`);
    }
  }

  console.log('\n📥 Downloading BGM...\n');
  for (const bgm of BGM_FILES) {
    const dest = join(BGM_DIR, bgm.file);
    const used = await tryDownload(bgm.urls, dest);
    if (used) {
      const stat = await fs.stat(dest);
      console.log(`  ✅ ${bgm.name} (${(stat.size/1024).toFixed(0)}KB)`);
    } else {
      console.log(`  ⚠️  ${bgm.name} — all URLs failed, keeping placeholder`);
    }
  }

  console.log('\nDone.');
}

main().catch(e => { console.error('✗', e.message); process.exit(1); });
