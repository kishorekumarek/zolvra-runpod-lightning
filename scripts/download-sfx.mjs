#!/usr/bin/env node
// scripts/download-sfx.mjs — Download SFX and BGM from Pixabay
// NOTE: Pixabay's public /api/ endpoint is image-only. The /api/sounds/ and /api/music/
// endpoints require a special API key or are Cloudflare-protected. This script attempts
// the documented Pixabay audio endpoints, validates any downloads as real audio via ffprobe,
// and generates 30s ambient sine-wave placeholders for any that fail so the pipeline can run.
// Run: node scripts/download-sfx.mjs

import 'dotenv/config';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ASSETS_SFX = join(ROOT, 'assets', 'sfx');
const ASSETS_BGM = join(ROOT, 'assets', 'bgm');
const FFMPEG = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');

const PIXABAY_KEY = process.env.PIXABAY_API_KEY;

const SFX_TRACKS = [
  { name: 'forest_day',     query: 'forest birds ambience',    freq: 220 },
  { name: 'forest_rain',    query: 'rain forest birds',         freq: 180 },
  { name: 'river',          query: 'river stream flowing',      freq: 260 },
  { name: 'village',        query: 'village ambient',           freq: 300 },
  { name: 'night',          query: 'night crickets forest',     freq: 160 },
  { name: 'sky',            query: 'wind open air',             freq: 200 },
  { name: 'crowd_children', query: 'children playing laughing', freq: 400 },
];

const BGM_TRACKS = [
  { name: 'kids_folk_01', query: 'Indian folk children gentle', freq: 330 },
  { name: 'kids_folk_02', query: 'gentle sitar kids',           freq: 370 },
  { name: 'kids_warm_01', query: 'warm kids storytelling',      freq: 350 },
];

/** Returns true if the file at path is a valid audio file (ffprobe can find an audio stream). */
function isValidAudio(filePath) {
  try {
    const out = execSync(
      `"${FFPROBE}" -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "${filePath}"`,
      { stdio: 'pipe' }
    ).toString().trim();
    return out === 'audio';
  } catch {
    return false;
  }
}

/** Generate a 30s ambient tone placeholder using ffmpeg. */
function generatePlaceholder(outputPath, freq = 220) {
  // Low-amplitude brown-noise-like sine tone — quiet enough to blend as "ambient"
  execSync([
    `"${FFMPEG}" -y -loglevel error`,
    `-f lavfi -i "aevalsrc=0.04*sin(${freq}*2*PI*t)+0.02*sin(${freq * 2}*2*PI*t)+0.01*sin(${freq * 3}*2*PI*t):s=44100"`,
    `-t 30`,
    `-c:a libmp3lame -b:a 64k`,
    `"${outputPath}"`,
  ].join(' '), { stdio: 'pipe' });
}

async function tryPixabayAudio(query, mediaType) {
  if (!PIXABAY_KEY || PIXABAY_KEY === 'your-pixabay-api-key') return null;

  // Try dedicated audio endpoints first
  const audioEndpoints = [
    `https://pixabay.com/api/sounds/?key=${PIXABAY_KEY}&q=${encodeURIComponent(query)}&safesearch=true`,
    `https://pixabay.com/api/music/?key=${PIXABAY_KEY}&q=${encodeURIComponent(query)}&safesearch=true`,
  ];

  for (const url of audioEndpoints) {
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'ZolvraBot/1.0' },
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.startsWith('<!')) continue; // HTML = Cloudflare block
      const data = JSON.parse(text);
      const hits = data.hits || [];
      if (!hits.length) continue;
      const hit = hits[0];
      const audioUrl = hit.audio?.download_url || hit.audio?.url || hit.audio ||
                       hit.previewURL || hit.preview_url || hit.audioURL;
      if (audioUrl && !audioUrl.match(/\.(jpg|jpeg|png|gif|webp)$/i)) return audioUrl;
    } catch {
      // try next
    }
  }
  return null;
}

async function downloadTrack(track, outputPath, mediaType) {
  const audioUrl = await tryPixabayAudio(track.query, mediaType);

  if (audioUrl) {
    const res = await fetch(audioUrl);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(outputPath, buf);
      if (isValidAudio(outputPath)) {
        return { source: 'pixabay', bytes: buf.length };
      }
      // Downloaded but not valid audio — delete and fall through to placeholder
      await fs.unlink(outputPath).catch(() => {});
    }
  }

  // Pixabay unavailable or returned non-audio — generate sine-wave placeholder
  generatePlaceholder(outputPath, track.freq);
  const stat = await fs.stat(outputPath);
  return { source: 'placeholder', bytes: stat.size };
}

async function main() {
  await fs.mkdir(ASSETS_SFX, { recursive: true });
  await fs.mkdir(ASSETS_BGM, { recursive: true });

  const downloaded = [];
  const placeholders = [];
  const skipped = [];

  console.log('📥 Downloading SFX tracks...');
  for (const track of SFX_TRACKS) {
    const outputPath = join(ASSETS_SFX, `${track.name}.mp3`);
    try {
      const { source, bytes } = await downloadTrack(track, outputPath, 'sound_effect');
      if (source === 'pixabay') {
        console.log(`  ✓ sfx/${track.name}.mp3 (${(bytes / 1024).toFixed(0)} KB) [pixabay]`);
        downloaded.push(`sfx/${track.name}.mp3`);
      } else {
        console.log(`  ～ sfx/${track.name}.mp3 (${(bytes / 1024).toFixed(0)} KB) [placeholder sine tone @${track.freq}Hz]`);
        placeholders.push(`sfx/${track.name}.mp3`);
      }
    } catch (e) {
      console.warn(`  ⚠️  sfx/${track.name}: ${e.message} — skipped`);
      skipped.push(`sfx/${track.name}.mp3`);
    }
  }

  console.log('\n🎵 Downloading BGM tracks...');
  for (const track of BGM_TRACKS) {
    const outputPath = join(ASSETS_BGM, `${track.name}.mp3`);
    try {
      const { source, bytes } = await downloadTrack(track, outputPath, 'music');
      if (source === 'pixabay') {
        console.log(`  ✓ bgm/${track.name}.mp3 (${(bytes / 1024).toFixed(0)} KB) [pixabay]`);
        downloaded.push(`bgm/${track.name}.mp3`);
      } else {
        console.log(`  ～ bgm/${track.name}.mp3 (${(bytes / 1024).toFixed(0)} KB) [placeholder sine tone @${track.freq}Hz]`);
        placeholders.push(`bgm/${track.name}.mp3`);
      }
    } catch (e) {
      console.warn(`  ⚠️  bgm/${track.name}: ${e.message} — skipped`);
      skipped.push(`bgm/${track.name}.mp3`);
    }
  }

  console.log(`\n✅ Real downloads : ${downloaded.length} files`);
  downloaded.forEach(f => console.log(`   ${f}`));
  if (placeholders.length) {
    console.log(`～  Placeholders   : ${placeholders.length} files (replace with real audio when Pixabay API grants audio access)`);
    placeholders.forEach(f => console.log(`   ${f}`));
  }
  if (skipped.length) {
    console.log(`⚠️  Skipped        : ${skipped.length} files`);
    skipped.forEach(f => console.log(`   ${f}`));
  }
}

main().catch(e => { console.error('✗', e.message); process.exit(1); });
