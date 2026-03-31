#!/usr/bin/env node
// scripts/gen-jungle-jambu-brand-assets.mjs
// Generates Jungle Jambu intro + end card animations via Wan 2.6 (kie.ai)
import 'dotenv/config';
import { promises as fs } from 'fs';
import { execSync } from 'child_process';
import { generateSceneImage } from '../lib/image-gen.mjs';
import { uploadToStorage, getSignedUrl } from '../lib/storage.mjs';
import { submitWanJob, pollWanJob, downloadWanVideo } from '../lib/wan.mjs';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const BOT_TOKEN = process.env.TELEGRAM_APPROVAL_BOT_TOKEN;
const DARL_CHAT_ID = 7879469053;

const ASSETS_DIR = 'assets/series/jungle-jambu';

// ── Prompts ──────────────────────────────────────────────────────────────────

const INTRO_PROMPT = [
  '3D Pixar animation style, colorful and fun, child-friendly cartoon.',
  'A chubby cheerful man in his 20s wearing a khaki hunter uniform with a cross-body belt,',
  'binoculars hanging around his neck, and a wide-brimmed hunter hat.',
  'He runs into frame from the left side looking confident and energetic.',
  'He stops center frame, raises his rifle and aims it directly toward the camera.',
  'He turns slightly and flashes a smug smirk directly at the camera.',
  'Close-up shot: the rifle barrel zooms toward camera, the dark circular barrel hole fills the entire frame.',
  'Scene fades smoothly to black. Vibrant colors, comedic cartoon energy.',
  'No text, no watermarks.',
].join(' ');

const END_CARD_PROMPT = [
  '3D Pixar animation style, colorful and fun, child-friendly cartoon.',
  'The same chubby cheerful hunter man in khaki uniform stands proudly center frame',
  'looking directly at camera with a big grin.',
  'A giant glowing bright red SUBSCRIBE button with white text descends slowly from the top of the frame.',
  'The button bonks him squarely on the head with a comic thud.',
  'He stumbles, his eyes go wide and spiral dizzy, stars swirl around his head.',
  'Vibrant colors, comedic cartoon energy, slapstick humor.',
  'No text overlay other than the SUBSCRIBE button label.',
].join(' ');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!BOT_TOKEN) { console.warn('  No bot token — skipping Telegram'); return; }
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: DARL_CHAT_ID, text }),
  });
  const data = await res.json();
  if (data.ok) console.log('  Telegram notification sent to Darl');
  else console.warn(`  Telegram failed: ${data.description}`);
}

async function sendTelegramVideo(filePath, caption) {
  if (!BOT_TOKEN) { console.warn('  No bot token — skipping Telegram video'); return; }
  const fileBuffer = await fs.readFile(filePath);
  const blob = new Blob([fileBuffer], { type: 'video/mp4' });
  const formData = new FormData();
  formData.append('chat_id', String(DARL_CHAT_ID));
  formData.append('video', blob, filePath.split('/').pop());
  if (caption) formData.append('caption', caption);
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, {
    method: 'POST',
    body: formData,
  });
  const data = await res.json();
  if (data.ok) console.log(`  Telegram video sent: ${filePath}`);
  else console.warn(`  Telegram video failed: ${data.description}`);
}

async function generateAndUploadStill(name, prompt) {
  console.log(`\n[${name}] Generating source still via Gemini...`);
  const buffer = await generateSceneImage({
    prompt,
    sceneNumber: 0,
    aspectRatio: '9:16',
    resolution: '1K',
  });
  console.log(`  Generated ${buffer.length} bytes`);

  const storagePath = `brand-assets/jungle-jambu/${name}_source.png`;
  console.log(`  Uploading to storage: ${storagePath}`);
  await uploadToStorage({
    bucket: 'scenes',
    path: storagePath,
    buffer,
    contentType: 'image/png',
  });

  // Get signed URL valid for 2 hours (enough time for Wan to fetch)
  const signedUrl = await getSignedUrl({ bucket: 'scenes', path: storagePath, expiresInSeconds: 7200 });
  console.log(`  Signed URL: ${signedUrl.slice(0, 80)}...`);
  return signedUrl;
}

async function submitAndPoll(name, imageUrl, prompt) {
  console.log(`\n[${name}] Submitting Wan 2.6 job...`);
  const taskId = await submitWanJob({
    imageUrl,
    prompt,
    aspectRatio: '9:16',
    duration: '5',
  });
  console.log(`  Polling job ${taskId}...`);
  const videoUrl = await pollWanJob(taskId, 900000); // 15 min max
  console.log(`  Job complete: ${videoUrl.slice(0, 80)}...`);
  return videoUrl;
}

async function downloadAndSave(url, outputPath) {
  console.log(`  Downloading video to ${outputPath}...`);
  const buffer = await downloadWanVideo(url);
  await fs.writeFile(outputPath, buffer);
  console.log(`  Saved ${buffer.length} bytes`);
}

function trimVideo(inputPath, outputPath, durationSec) {
  console.log(`  Trimming ${inputPath} to ${durationSec}s -> ${outputPath}`);
  execSync(
    `${FFMPEG} -y -i "${inputPath}" -t ${durationSec} -c copy "${outputPath}"`,
    { stdio: 'inherit' }
  );
}

function verifyVideo(path) {
  console.log(`  Verifying ${path}...`);
  const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${path}"`).toString().trim();
  console.log(`  Duration: ${out}s`);
  return parseFloat(out);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Jungle Jambu Brand Asset Generator ===\n');

  // Step 1: Generate source stills in parallel
  console.log('Step 1: Generating source stills...');
  const [introImageUrl, endCardImageUrl] = await Promise.all([
    generateAndUploadStill('intro', INTRO_PROMPT),
    generateAndUploadStill('end_card', END_CARD_PROMPT),
  ]);

  // Step 2: Submit both Wan jobs in parallel
  console.log('\nStep 2: Submitting Wan 2.6 animation jobs...');
  const [introVideoUrl, endCardVideoUrl] = await Promise.all([
    submitAndPoll('intro', introImageUrl, INTRO_PROMPT),
    submitAndPoll('end_card', endCardImageUrl, END_CARD_PROMPT),
  ]);

  // Step 3: Download raw clips
  console.log('\nStep 3: Downloading raw clips...');
  const introRaw = `${ASSETS_DIR}/intro_raw.mp4`;
  const endCardRaw = `${ASSETS_DIR}/end_card_raw.mp4`;
  await Promise.all([
    downloadAndSave(introVideoUrl, introRaw),
    downloadAndSave(endCardVideoUrl, endCardRaw),
  ]);

  // Step 4: Trim to correct durations
  console.log('\nStep 4: Trimming clips...');
  const introOut = `${ASSETS_DIR}/intro.mp4`;
  const endCardOut = `${ASSETS_DIR}/end_card.mp4`;
  trimVideo(introRaw, introOut, 5);
  trimVideo(endCardRaw, endCardOut, 3);

  // Step 5: Verify
  console.log('\nStep 5: Verifying output files...');
  const introDur = verifyVideo(introOut);
  const endCardDur = verifyVideo(endCardOut);
  console.log(`  intro.mp4: ${introDur}s (target: 5s)`);
  console.log(`  end_card.mp4: ${endCardDur}s (target: 3s)`);

  // Step 6: Clean up raw files
  await fs.unlink(introRaw).catch(() => {});
  await fs.unlink(endCardRaw).catch(() => {});

  // Step 7: Telegram notification
  console.log('\nStep 6: Sending Telegram notifications to Darl...');
  await sendTelegram(
    '🎬 Jungle Jambu brand assets ready for review!\n\n' +
    '• intro.mp4 (~5s) — hunter runs in, aims rifle at camera, fade to black\n' +
    '• end_card.mp4 (~3s) — hunter gets bonked by SUBSCRIBE button\n\n' +
    'Files: assets/series/jungle-jambu/\n' +
    'Please review and approve.'
  );
  // Send videos directly
  await sendTelegramVideo(introOut, '🎬 Jungle Jambu INTRO (~5s)');
  await sendTelegramVideo(endCardOut, '🎬 Jungle Jambu END CARD (~3s)');

  console.log('\n=== Done ===');
  console.log(`  intro.mp4:    ${introOut}`);
  console.log(`  end_card.mp4: ${endCardOut}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
