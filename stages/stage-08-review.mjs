// stages/stage-08-review.mjs — Finalize + store in video_queue (no YouTube upload)
// REWRITTEN for pipeline schema rewrite: reads from DB via pipeline_state FKs.
import 'dotenv/config';
import { promises as fs } from 'fs';
import { getSupabase } from '../lib/supabase.mjs';
import { sendTelegramMessage } from '../lib/telegram.mjs';
import {
  getPipelineState, getConcept, getYoutubeSeo, getVideoOutput,
} from '../lib/pipeline-db.mjs';

const STAGE = 8;

/**
 * Stage 8: Read final video + metadata from DB, insert into video_queue,
 * notify Telegram. Does NOT upload to YouTube — that happens via publish-video.mjs.
 *
 * NEW: reads everything from DB. No in-memory state dependencies.
 */
export async function runStage8(taskId, tracker, state = {}) {
  console.log('📦 Stage 8: Finalize + store in video queue...');

  const sb = getSupabase();

  // ── Read from DB ───────────────────────────────────────────────────
  const ps = await getPipelineState(taskId);
  if (!ps) throw new Error('Stage 8: pipeline_state not found');

  const concept = await getConcept(ps.concept_id);
  const videoType = concept.video_type || 'short';

  if (!ps.youtube_seo_id) throw new Error('Stage 8: youtube_seo_id not set in pipeline_state');
  const seo = await getYoutubeSeo(ps.youtube_seo_id);

  if (!ps.video_output_id) throw new Error('Stage 8: video_output_id not set in pipeline_state — did Stage 7 complete?');
  const videoOutput = await getVideoOutput(ps.video_output_id);

  if (!videoOutput.local_video_path) throw new Error('Stage 8: local_video_path not set in video_output');

  // Verify local file exists
  try {
    await fs.access(videoOutput.local_video_path);
  } catch {
    throw new Error(`Stage 8: final video file not found at ${videoOutput.local_video_path}`);
  }

  const title = seo.title || `Episode ${taskId.slice(0, 8)}`;
  const finalDurationSeconds = videoOutput.final_duration_seconds;

  // ── Insert into video_queue ────────────────────────────────────────
  const { error: insertErr } = await sb.from('video_queue').insert({
    task_id:          taskId,
    title,
    video_type:       videoType,
    local_video_path: videoOutput.local_video_path,
    video_url:        videoOutput.video_url || null,
    youtube_seo:      { title: seo.title, description: seo.description, tags: seo.tags },
    status:           'ready',
  });

  if (insertErr) {
    if (insertErr.message?.includes('unique') || insertErr.code === '23505') {
      console.warn('  ℹ️  video_queue row already exists — updating...');
      await sb.from('video_queue').update({
        title,
        video_type:       videoType,
        local_video_path: videoOutput.local_video_path,
        video_url:        videoOutput.video_url || null,
        youtube_seo:      { title: seo.title, description: seo.description, tags: seo.tags },
        status:           'ready',
      }).eq('task_id', taskId);
    } else {
      throw new Error(`Failed to insert into video_queue: ${insertErr.message}`);
    }
  }
  console.log(`  ✓ video_queue row inserted (status=ready, type=${videoType})`);

  // ── Notify Telegram ────────────────────────────────────────────────
  const durationStr = finalDurationSeconds ? `${finalDurationSeconds.toFixed(1)}s` : '?';
  await sendTelegramMessage(
    `🎬 ${title} ready for review!\n\n` +
    `📁 Saved locally (${videoType}, ${durationStr})\n` +
    `📂 ${videoOutput.local_video_path}\n\n` +
    `Run \`node scripts/publish-video.mjs ${taskId}\` to upload to YouTube.`
  );

  console.log('✅ Stage 8 complete. Video queued — pipeline closed. Publish via publish-video.mjs when ready.');

}
