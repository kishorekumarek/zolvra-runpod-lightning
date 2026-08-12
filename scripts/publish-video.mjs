#!/usr/bin/env node
// scripts/publish-video.mjs — On-demand YouTube publisher
// Uploads a queued video from local storage to YouTube as private, updates video_queue, notifies Telegram.
//
// Usage:
//   node scripts/publish-video.mjs <task_id>
//   node scripts/publish-video.mjs "Malar and the Lost Kitten"   # title substring search
//
// What it does:
//   1. Looks up the video_queue row (status='ready') by task_id OR title substring
//   2. If the row is a TEASER (parent_task_id set), verifies parent is already uploaded and
//      substitutes <PARENT_VIDEO_URL> in the description before upload
//   3. Uploads to YouTube as private via uploadVideoPrivate()
//   4. For shorts: ensures #Shorts is in title + description; adds to shorts playlist
//      For long:   skips #Shorts; adds to long-form playlist
//   5. Updates video_queue: status='uploaded', youtube_video_id, uploaded_at=now()
//   6. If the row is a LONG video with queued teaser children (parent_task_id=<this taskId>),
//      auto-publishes each teaser after the long upload succeeds, substituting the new URL
//   7. Sends Telegram notification with private YouTube URL(s)

import 'dotenv/config';
import { promises as fs } from 'fs';
import { getSupabase } from '../lib/supabase.mjs';
import { uploadVideoPrivate, getYouTubeClient } from '../lib/youtube.mjs';
import { sendTelegramMessage } from '../lib/telegram.mjs';
import { getSetting } from '../lib/settings.mjs';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function addToCorrectPlaylist(youtubeVideoId, videoType) {
  const yt = await getYouTubeClient();
  let playlistId;
  try {
    const settingKey = videoType === 'short'
      ? 'youtube_shorts_playlist_id'
      : 'youtube_long_playlist_id';
    playlistId = await getSetting(settingKey);
  } catch {}

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

async function patchShortsMetadata(youtubeVideoId, currentSnippet, seoTags = []) {
  const yt = await getYouTubeClient();

  const title = currentSnippet.title.includes('#Shorts')
    ? currentSnippet.title
    : `${currentSnippet.title} #Shorts`;

  const description = currentSnippet.description.includes('#Shorts')
    ? currentSnippet.description
    : `${currentSnippet.description}\n\n#Shorts`;

  const tags = (seoTags && seoTags.length > 0)
    ? seoTags
    : (currentSnippet.tags || []);

  await yt.videos.update({
    part: ['snippet'],
    requestBody: {
      id: youtubeVideoId,
      snippet: {
        ...currentSnippet,
        title,
        description,
        tags,
      },
    },
  });
  console.log(`  🏷️  #Shorts + tags patched (${tags.length} tags)`);
}

/**
 * Publish one video_queue row to YouTube as private.
 * If parentUrl is provided, substitutes <PARENT_VIDEO_URL> in the description.
 * Returns the YouTube video ID on success.
 */
async function publishQueueRow({ queueRow, sb, parentUrl = null }) {
  const { task_id: taskId, title, video_type: videoType, local_video_path: localVideoPath, youtube_seo } = queueRow;

  console.log(`\n🎬 Publishing: ${title}`);
  console.log(`   task_id:    ${taskId}`);
  console.log(`   video_type: ${videoType}`);
  console.log(`   local path: ${localVideoPath}`);

  try {
    const stat = await fs.stat(localVideoPath);
    console.log(`  ✓ Video found locally (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
  } catch (err) {
    throw new Error(`Video file not found at ${localVideoPath}: ${err.message}`);
  }

  // Substitute parent URL placeholder if this is a teaser
  const seoForUpload = { ...(youtube_seo || {}) };
  if (parentUrl && seoForUpload.description?.includes('<PARENT_VIDEO_URL>')) {
    seoForUpload.description = seoForUpload.description.replaceAll('<PARENT_VIDEO_URL>', parentUrl);
    console.log('  ↪️  Substituted <PARENT_VIDEO_URL> in teaser description');
  }

  const scriptObj = { youtube_seo: seoForUpload };

  // Upload
  console.log('  📤 Uploading to YouTube (private)...');
  let youtubeVideoId;
  try {
    youtubeVideoId = await uploadVideoPrivate({
      videoPath: localVideoPath,
      script: scriptObj,
      taskId,
    });
    console.log(`  ✓ YouTube video ID: ${youtubeVideoId}`);
  } catch (err) {
    await sb.from('video_queue').update({ status: 'failed' }).eq('task_id', taskId);
    throw err;
  }

  // Post-upload: #Shorts patch + playlist
  try {
    if (videoType === 'short') {
      const yt = await getYouTubeClient();
      const res = await yt.videos.list({ part: ['snippet'], id: [youtubeVideoId] });
      const snippet = res.data.items?.[0]?.snippet;
      if (snippet) {
        await patchShortsMetadata(youtubeVideoId, snippet, seoForUpload.tags || []);
      }
    }
    await addToCorrectPlaylist(youtubeVideoId, videoType);
  } catch (err) {
    console.warn(`  ⚠️  Post-upload metadata/playlist update failed (non-fatal): ${err.message}`);
  }

  // Update queue
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

  return youtubeVideoId;
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

  // ── 2. Teaser path: must have an already-uploaded parent ────────────────────
  if (queueRow.parent_task_id) {
    const { data: parent, error: parentErr } = await sb
      .from('video_queue')
      .select('task_id, youtube_video_id, status')
      .eq('task_id', queueRow.parent_task_id)
      .single();

    if (parentErr || !parent) {
      console.error(`❌ Parent video not found for teaser (parent_task_id: ${queueRow.parent_task_id})`);
      process.exit(1);
    }
    if (parent.status !== 'uploaded' || !parent.youtube_video_id) {
      console.error(`❌ Parent long video must be published before teasers.`);
      console.error(`   Parent status: ${parent.status}`);
      console.error(`   Run: node scripts/publish-video.mjs ${parent.task_id}`);
      process.exit(1);
    }

    const parentUrl = `https://youtu.be/${parent.youtube_video_id}`;
    try {
      const youtubeVideoId = await publishQueueRow({ queueRow, sb, parentUrl });
      const teaserUrl = `https://youtu.be/${youtubeVideoId}`;
      await sendTelegramMessage(
        `🎬 Teaser uploaded: ${queueRow.title}\n` +
        `📺 Private URL: ${teaserUrl}\n` +
        `🔗 Parent: ${parentUrl}\n\n` +
        `Make public via YouTube Studio when ready 🚀`,
      ).catch(() => {});
      console.log(`\n🎉 Done! ${teaserUrl}\n`);
    } catch (err) {
      console.error(`❌ Teaser publish failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // ── 3. Parent (long or short) publish ───────────────────────────────────────
  let parentYoutubeId;
  try {
    parentYoutubeId = await publishQueueRow({ queueRow, sb });
  } catch (err) {
    console.error(`❌ Upload failed: ${err.message}`);
    process.exit(1);
  }

  const parentUrl = `https://youtu.be/${parentYoutubeId}`;

  // ── 4. If this is a long video with pending teasers, auto-publish them ──────
  const childTeasers = [];
  if (queueRow.video_type === 'long') {
    const { data: teasers } = await sb
      .from('video_queue')
      .select('*')
      .eq('parent_task_id', queueRow.task_id)
      .eq('status', 'ready')
      .order('created_at', { ascending: true });

    for (const teaser of (teasers || [])) {
      try {
        console.log(`\n━━━ Auto-publishing teaser: ${teaser.title} ━━━`);
        const teaserYoutubeId = await publishQueueRow({ queueRow: teaser, sb, parentUrl });
        childTeasers.push({ title: teaser.title, url: `https://youtu.be/${teaserYoutubeId}` });
      } catch (err) {
        console.warn(`  ⚠️  Teaser ${teaser.task_id.slice(0, 8)} publish failed (continuing): ${err.message}`);
        await sendTelegramMessage(
          `⚠️ Teaser upload failed for "${teaser.title}": ${err.message}\n` +
          `Retry manually: node scripts/publish-video.mjs ${teaser.task_id}`,
        ).catch(() => {});
      }
    }
  }

  // ── 5. Final Telegram notification ──────────────────────────────────────────
  const teaserLines = childTeasers.length > 0
    ? '\n\nTeasers:\n' + childTeasers.map(t => `  • ${t.title}: ${t.url}`).join('\n')
    : '';
  await sendTelegramMessage(
    `✅ ${queueRow.title} uploaded!\n\n` +
    `📺 Private URL: ${parentUrl}\n` +
    `Type: ${queueRow.video_type} | Task: ${queueRow.task_id.slice(0, 8)}${teaserLines}\n\n` +
    `Make public via YouTube Studio when ready 🚀`,
  ).catch(err => console.warn(`  ⚠️  Telegram notify failed: ${err.message}`));

  console.log(`\n🎉 Done! ${parentUrl}`);
  if (childTeasers.length > 0) {
    console.log(`   Plus ${childTeasers.length} teaser(s)`);
  }
  console.log();
}

main().catch(err => {
  console.error('💥 Unhandled error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
