// stages/stage-08-review.mjs — Finalize + store locally in video_queue (no YouTube upload)
// Producer stage: copy final video to persistent local output folder, insert into video_queue,
// send Telegram notification. YouTube upload happens separately via scripts/publish-video.mjs.
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSupabase } from '../lib/supabase.mjs';
import { getVideoType } from '../lib/settings.mjs';
import { sendTelegramMessage } from '../lib/telegram.mjs';

const STAGE = 8;
const __dirname = dirname(fileURLToPath(import.meta.url));
// Persistent output folder — survives /tmp cleanup
const OUTPUT_DIR = join(__dirname, '..', 'output');

/**
 * Stage 8: Copy final video to persistent local output folder,
 * insert a row into `video_queue`, notify Telegram.
 * Does NOT upload to YouTube — that happens via publish-video.mjs on demand.
 * Storage: local filesystem (streams/youtube/output/{taskId}/final.mp4)
 */
export async function runStage8(taskId, tracker, state = {}) {
  console.log('📦 Stage 8: Finalize + store in video queue...');

  const { script, finalVideoPath, finalDurationSeconds, thumbnailPath } = state;
  if (!script) throw new Error('Stage 8: script not found');
  if (!finalVideoPath) throw new Error('Stage 8: finalVideoPath not found');

  const sb = getSupabase();
  const videoType = state.videoType ?? await getVideoType();

  // ── 1. Copy final video to persistent local output folder ───────────
  const outputDir = join(OUTPUT_DIR, taskId);
  await fs.mkdir(outputDir, { recursive: true });
  const localVideoPath = join(outputDir, 'final.mp4');
  console.log(`  💾 Saving to persistent storage: ${localVideoPath}`);
  await fs.copyFile(finalVideoPath, localVideoPath);
  console.log(`  ✓ Video saved (${((await fs.stat(localVideoPath)).size / 1024 / 1024).toFixed(1)}MB)`);

  // ── 2. Copy thumbnail if present ────────────────────────────────────
  let localThumbnailPath = null;
  if (thumbnailPath) {
    try {
      localThumbnailPath = join(outputDir, 'thumbnail.jpg');
      await fs.copyFile(thumbnailPath, localThumbnailPath);
      console.log(`  ✓ Thumbnail saved`);
    } catch (err) {
      console.warn(`  ⚠️  Thumbnail copy failed (non-fatal): ${err.message}`);
      localThumbnailPath = null;
    }
  }

  // Stub for compatibility (no Supabase path needed)
  // ── 3. Insert into video_queue ───────────────────────────────────────
  const title = script.youtube_seo?.title || script.metadata?.title || `Episode ${taskId.slice(0, 8)}`;
  const youtubeSeо = script.youtube_seo || {};

  const { error: insertErr } = await sb.from('video_queue').insert({
    task_id:                  taskId,
    title,
    video_type:               videoType,
    local_video_path:         localVideoPath,   // local filesystem path
    supabase_thumbnail_path:  localThumbnailPath,
    youtube_seo:              youtubeSeо,
    status:                   'ready',
  });

  if (insertErr) {
    if (insertErr.message?.includes('unique') || insertErr.code === '23505') {
      console.warn('  ℹ️  video_queue row already exists — updating...');
      await sb.from('video_queue').update({
        title,
        video_type:               videoType,
        local_video_path:         localVideoPath,
        supabase_thumbnail_path:  localThumbnailPath,
        youtube_seo:              youtubeSeо,
        status:                   'ready',
      }).eq('task_id', taskId);
    } else {
      throw new Error(`Failed to insert into video_queue: ${insertErr.message}`);
    }
  }
  console.log(`  ✓ video_queue row inserted (status=ready, type=${videoType})`);

  // ── 4. Notify Telegram ───────────────────────────────────────────────
  const durationStr = finalDurationSeconds ? `${finalDurationSeconds.toFixed(1)}s` : '?';
  await sendTelegramMessage(
    `🎬 ${title} ready for review!\n\n` +
    `📁 Saved locally (${videoType}, ${durationStr})\n` +
    `📂 ${localVideoPath}\n\n` +
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
    localVideoPath,
    localThumbnailPath,
    queueStatus: 'ready',
  };
}
