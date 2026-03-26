// stages/stage-08-review.mjs — Finalize + store in Supabase video_queue (no YouTube upload)
// Producer stage: upload final video + thumbnail to Supabase, insert into video_queue,
// send Telegram preview. YouTube upload happens separately via scripts/publish-video.mjs.
import 'dotenv/config';
import { promises as fs } from 'fs';
import { getSupabase } from '../lib/supabase.mjs';
import { getVideoType } from '../lib/settings.mjs';
import { sendTelegramMessage } from '../lib/telegram.mjs';
import { uploadToStorage, getSignedUrl, BUCKETS } from '../lib/storage.mjs';

const STAGE = 8;

/**
 * Stage 8: Upload final video (and thumbnail if present) to Supabase `videos` bucket,
 * insert a row into `video_queue`, notify Telegram with a signed URL preview.
 * Does NOT upload to YouTube — that happens via publish-video.mjs on demand.
 */
export async function runStage8(taskId, tracker, state = {}) {
  console.log('📦 Stage 8: Finalize + store in video queue...');

  const { script, finalVideoPath, finalDurationSeconds, thumbnailPath } = state;
  if (!script) throw new Error('Stage 8: script not found');
  if (!finalVideoPath) throw new Error('Stage 8: finalVideoPath not found');

  const sb = getSupabase();
  const videoType = state.videoType ?? await getVideoType();

  // ── 1. Upload final video to Supabase `videos` bucket ───────────────
  console.log('  ⬆️  Uploading final video to Supabase...');
  const videoBuffer = await fs.readFile(finalVideoPath);
  const supabaseVideoPath = `${taskId}/final.mp4`;
  await uploadToStorage({
    bucket: BUCKETS.videos,
    path: supabaseVideoPath,
    buffer: videoBuffer,
    contentType: 'video/mp4',
  });
  console.log(`  ✓ Video uploaded: videos/${supabaseVideoPath}`);

  // ── 2. Upload thumbnail if present ──────────────────────────────────
  let supabaseThumbnailPath = null;
  if (thumbnailPath) {
    try {
      const thumbBuffer = await fs.readFile(thumbnailPath);
      supabaseThumbnailPath = `${taskId}/thumbnail.jpg`;
      await uploadToStorage({
        bucket: BUCKETS.videos,
        path: supabaseThumbnailPath,
        buffer: thumbBuffer,
        contentType: 'image/jpeg',
      });
      console.log(`  ✓ Thumbnail uploaded: videos/${supabaseThumbnailPath}`);
    } catch (err) {
      console.warn(`  ⚠️  Thumbnail upload failed (non-fatal): ${err.message}`);
      supabaseThumbnailPath = null;
    }
  }

  // ── 3. Insert into video_queue ───────────────────────────────────────
  const title = script.youtube_seo?.title || script.metadata?.title || `Episode ${taskId.slice(0, 8)}`;
  const youtubeSeо = script.youtube_seo || {};

  const { error: insertErr } = await sb.from('video_queue').insert({
    task_id:                  taskId,
    title,
    video_type:               videoType,
    supabase_video_path:      supabaseVideoPath,
    supabase_thumbnail_path:  supabaseThumbnailPath,
    youtube_seo:              youtubeSeо,
    status:                   'ready',
  });

  if (insertErr) {
    // On conflict (already queued), update instead
    if (insertErr.message?.includes('unique') || insertErr.code === '23505') {
      console.warn('  ℹ️  video_queue row already exists — updating...');
      await sb.from('video_queue').update({
        title,
        video_type:               videoType,
        supabase_video_path:      supabaseVideoPath,
        supabase_thumbnail_path:  supabaseThumbnailPath,
        youtube_seo:              youtubeSeо,
        status:                   'ready',
      }).eq('task_id', taskId);
    } else {
      throw new Error(`Failed to insert into video_queue: ${insertErr.message}`);
    }
  }
  console.log(`  ✓ video_queue row inserted (status=ready, type=${videoType})`);

  // ── 4. Get signed URL for Telegram preview ──────────────────────────
  let previewUrl = '';
  try {
    previewUrl = await getSignedUrl({
      bucket: BUCKETS.videos,
      path: supabaseVideoPath,
      expiresInSeconds: 86400, // 24h
    });
  } catch (err) {
    console.warn(`  ⚠️  Could not generate signed URL: ${err.message}`);
    previewUrl = '(signed URL unavailable)';
  }

  // ── 5. Notify Telegram ───────────────────────────────────────────────
  const durationStr = finalDurationSeconds ? `${finalDurationSeconds.toFixed(1)}s` : '?';
  await sendTelegramMessage(
    `🎬 ${title} ready for review!\n\n` +
    `📦 Stored in Supabase (${videoType}, ${durationStr})\n` +
    `🔗 Preview (24h): ${previewUrl}\n\n` +
    `Run \`node scripts/publish-video.mjs ${taskId}\` to upload to YouTube.`
  );

  // ── 6. Update pipeline run status ───────────────────────────────────
  await sb.from('video_pipeline_runs')
    .update({ status: 'awaiting_publish' })
    .eq('task_id', taskId)
    .eq('stage', STAGE);

  console.log('✅ Stage 8 complete. Video queued — pipeline closed. Publish via publish-video.mjs when ready.');

  return {
    ...state,
    supabaseVideoPath,
    supabaseThumbnailPath,
    queueStatus: 'ready',
  };
}
