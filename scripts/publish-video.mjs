#!/usr/bin/env node
// scripts/publish-video.mjs — On-demand YouTube publisher
// Uploads a queued video from Supabase to YouTube as private, updates video_queue, notifies Telegram.
//
// Usage:
//   node scripts/publish-video.mjs <task_id>
//   node scripts/publish-video.mjs "Malar and the Lost Kitten"   # title substring search
//
// What it does:
//   1. Looks up the video_queue row (status='ready') by task_id OR title substring
//   2. Downloads the video from Supabase `videos` bucket to /tmp/
//   3. Uploads to YouTube as private via uploadVideoPrivate()
//   4. For shorts: ensures #Shorts is in title + description; adds to shorts playlist
//      For long:   skips #Shorts; adds to long-form playlist
//   5. Updates video_queue: status='uploaded', youtube_video_id, uploaded_at=now()
//   6. Sends Telegram notification with private YouTube URL
//   7. Cleans up /tmp/ download

import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getSupabase } from '../lib/supabase.mjs';
import { downloadFromStorage, BUCKETS } from '../lib/storage.mjs';
import { uploadVideoPrivate, getYouTubeClient } from '../lib/youtube.mjs';
import { sendTelegramMessage } from '../lib/telegram.mjs';
import { getSetting } from '../lib/settings.mjs';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Add video to the correct playlist based on video_type.
 * Reads youtube_shorts_playlist_id or youtube_long_playlist_id from settings.
 * Falls back to youtube_default_playlist_id if type-specific setting not found.
 */
async function addToCorrectPlaylist(youtubeVideoId, videoType) {
  const yt = await getYouTubeClient();
  let playlistId;
  try {
    const settingKey = videoType === 'short'
      ? 'youtube_shorts_playlist_id'
      : 'youtube_long_playlist_id';
    playlistId = await getSetting(settingKey);
  } catch {}

  // Fall back to default playlist
  if (!playlistId || playlistId === 'PLACEHOLDER') {
    try {
      playlistId = await getSetting('youtube_default_playlist_id');
    } catch {}
  }

  if (!playlistId || playlistId === 'PLACEHOLDER') {
    console.warn(`  ⚠️  No playlist configured for video_type=${videoType} — skipping`);
    return;
  }

  await yt.playlistItems.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: { kind: 'youtube#video', videoId: youtubeVideoId },
      },
    },
  });
  console.log(`  📋 Added to playlist ${playlistId} (${videoType})`);
}

/**
 * Ensure #Shorts appears in title and description for short-form videos.
 * Patches the YouTube snippet via API.
 */
async function patchShortsMetadata(youtubeVideoId, currentSnippet) {
  const yt = await getYouTubeClient();

  const title = currentSnippet.title.includes('#Shorts')
    ? currentSnippet.title
    : `${currentSnippet.title} #Shorts`;

  const description = currentSnippet.description.includes('#Shorts')
    ? currentSnippet.description
    : `${currentSnippet.description}\n\n#Shorts`;

  await yt.videos.update({
    part: ['snippet'],
    requestBody: {
      id: youtubeVideoId,
      snippet: {
        ...currentSnippet,
        title,
        description,
      },
    },
  });
  console.log('  🏷️  #Shorts added to title + description');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const [,, arg] = process.argv;
  if (!arg) {
    console.error('Usage: node scripts/publish-video.mjs <task_id|title_substring>');
    process.exit(1);
  }

  const sb = getSupabase();

  // ── 1. Look up video_queue row ─────────────────────────────────────────────
  let queueRow;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg);

  if (isUuid) {
    const { data, error } = await sb
      .from('video_queue')
      .select('*')
      .eq('task_id', arg)
      .eq('status', 'ready')
      .single();
    if (error || !data) {
      console.error(`❌ No ready video found for task_id: ${arg}`);
      console.error('   (Has it already been uploaded? Check status in video_queue.)');
      process.exit(1);
    }
    queueRow = data;
  } else {
    // Title substring search
    const { data, error } = await sb
      .from('video_queue')
      .select('*')
      .ilike('title', `%${arg}%`)
      .eq('status', 'ready')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (error || !data) {
      console.error(`❌ No ready video found matching title: "${arg}"`);
      process.exit(1);
    }
    queueRow = data;
  }

  const { task_id: taskId, title, video_type: videoType, supabase_video_path, youtube_seo } = queueRow;
  console.log(`\n🎬 Publishing: ${title}`);
  console.log(`   task_id:    ${taskId}`);
  console.log(`   video_type: ${videoType}`);
  console.log(`   storage:    ${supabase_video_path}`);
  console.log();

  // ── 2. Download video from Supabase ─────────────────────────────────────────
  const tmpVideoPath = join(tmpdir(), `publish_${taskId}.mp4`);
  console.log(`  ⬇️  Downloading from Supabase...`);
  try {
    const buffer = await downloadFromStorage({ bucket: BUCKETS.videos, path: supabase_video_path });
    await fs.writeFile(tmpVideoPath, buffer);
    console.log(`  ✓ Downloaded (${(buffer.length / 1024 / 1024).toFixed(1)}MB) → ${tmpVideoPath}`);
  } catch (err) {
    console.error(`❌ Failed to download video: ${err.message}`);
    process.exit(1);
  }

  // ── 3. Build a minimal script object for uploadVideoPrivate ─────────────────
  // uploadVideoPrivate expects { youtube_seo: { title, description, tags } }
  const scriptObj = { youtube_seo };

  // ── 4. Upload to YouTube as private ─────────────────────────────────────────
  let youtubeVideoId;
  try {
    console.log('  📤 Uploading to YouTube (private)...');
    youtubeVideoId = await uploadVideoPrivate({
      videoPath: tmpVideoPath,
      script: scriptObj,
      taskId,
    });
    console.log(`  ✓ YouTube video ID: ${youtubeVideoId}`);
  } catch (err) {
    console.error(`❌ YouTube upload failed: ${err.message}`);
    // Mark as failed in queue
    await sb.from('video_queue').update({ status: 'failed' }).eq('task_id', taskId);
    await fs.unlink(tmpVideoPath).catch(() => {});
    process.exit(1);
  }

  // ── 5. Patch #Shorts + playlist ─────────────────────────────────────────────
  try {
    if (videoType === 'short') {
      // Fetch snippet to patch #Shorts
      const yt = await getYouTubeClient();
      const res = await yt.videos.list({ part: ['snippet'], id: [youtubeVideoId] });
      const snippet = res.data.items?.[0]?.snippet;
      if (snippet) {
        await patchShortsMetadata(youtubeVideoId, snippet);
      }
    }
    // Add to correct playlist
    await addToCorrectPlaylist(youtubeVideoId, videoType);
  } catch (err) {
    console.warn(`  ⚠️  Post-upload metadata/playlist update failed (non-fatal): ${err.message}`);
  }

  // ── 6. Update video_queue ────────────────────────────────────────────────────
  const { error: updateErr } = await sb.from('video_queue').update({
    status:           'uploaded',
    youtube_video_id: youtubeVideoId,
    uploaded_at:      new Date().toISOString(),
  }).eq('task_id', taskId);

  if (updateErr) {
    console.warn(`  ⚠️  Failed to update video_queue: ${updateErr.message}`);
  } else {
    console.log('  ✓ video_queue updated (status=uploaded)');
  }

  // ── 7. Telegram notification ─────────────────────────────────────────────────
  const youtubeUrl = `https://youtu.be/${youtubeVideoId}`;
  await sendTelegramMessage(
    `✅ ${title} uploaded!\n\n` +
    `📺 Private URL: ${youtubeUrl}\n` +
    `Type: ${videoType} | Task: ${taskId.slice(0, 8)}\n\n` +
    `Make public via YouTube Studio when ready 🚀`
  ).catch(err => console.warn(`  ⚠️  Telegram notify failed: ${err.message}`));

  // ── 8. Clean up /tmp/ ────────────────────────────────────────────────────────
  await fs.unlink(tmpVideoPath).catch(() => {});
  console.log('  🧹 Temp file cleaned up');

  console.log(`\n🎉 Done! https://youtu.be/${youtubeVideoId}\n`);
}

main().catch(err => {
  console.error('💥 Unhandled error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
