#!/usr/bin/env node
// scripts/upload-ep02-v3.mjs — Upload EP02 Minmini v3 to YouTube as UNLISTED
import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { uploadVideoUnlisted } from '../lib/youtube.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const pkg = JSON.parse(
  await readFile(resolve(root, 'output/ep02-upload-package.json'), 'utf8')
);

const videoPath = resolve(root, 'output/ep02-minminni-v3-final.mp4');

const script = {
  youtube_seo: {
    title:       pkg.title,
    description: pkg.description,
    tags:        pkg.tags,
  },
  metadata: {
    title:   pkg.title,
    episode: 2,
  },
};

console.log(`Uploading: ${videoPath}`);
console.log(`Title: ${script.youtube_seo.title}`);

const videoId = await uploadVideoUnlisted({
  videoPath,
  script,
  taskId: 'ep02-minmini-v3',
});

const url = `https://youtu.be/${videoId}`;
console.log(`\nYouTube URL: ${url}`);
