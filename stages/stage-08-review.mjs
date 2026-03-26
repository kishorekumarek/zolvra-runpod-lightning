// stages/stage-08-review.mjs — Upload private to YouTube, add #Shorts, notify Telegram
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';
import { uploadVideoPrivate, getYouTubeClient } from '../lib/youtube.mjs';
import { getVideoType } from '../lib/settings.mjs';
import { withRetry } from '../lib/retry.mjs';
import { sendTelegramMessage } from '../lib/telegram.mjs';

const STAGE = 8;

/**
 * Stage 8: Upload to YouTube as Private → add #Shorts tag → notify Telegram.
 */
export async function runStage8(taskId, tracker, state = {}) {
  console.log('📤 Stage 8: Human review (YouTube upload)...');

  const { script, finalVideoPath, finalDurationSeconds } = state;
  if (!script) throw new Error('Stage 8: script not found');
  if (!finalVideoPath) throw new Error('Stage 8: finalVideoPath not found');

  const sb = getSupabase();
  const videoType = state.videoType ?? await getVideoType();

  // Upload to YouTube as private
  console.log('  Uploading to YouTube (private)...');
  const youtubeVideoId = await withRetry(
    () => uploadVideoPrivate({ videoPath: finalVideoPath, script, taskId }),
    { maxRetries: 2, baseDelayMs: 10000, stage: STAGE, taskId }
  );

  const youtubeUrl = `https://youtu.be/${youtubeVideoId}`; // private until Darl publishes

  // Add #Shorts tag to description for short videos
  if (videoType === 'short') {
    try {
      const yt = await getYouTubeClient();
      const res = await yt.videos.list({ part: ['snippet'], id: [youtubeVideoId] });
      const snippet = res.data.items?.[0]?.snippet;
      if (snippet && !snippet.description.includes('#Shorts')) {
        await yt.videos.update({
          part: ['snippet'],
          requestBody: {
            id: youtubeVideoId,
            snippet: { ...snippet, description: snippet.description + '\n\n#Shorts', categoryId: snippet.categoryId || '27' },
          },
        });
        console.log('  🏷️  Added #Shorts tag to description');
      }
    } catch (err) {
      console.warn(`  ⚠️  Failed to add #Shorts tag: ${err.message}`);
    }
  }

  // Notify Darl via Telegram
  const title = script.youtube_seo?.title || script.metadata?.title || 'New Episode';
  await sendTelegramMessage(`🎬 ${title} uploaded!\n\n📺 ${youtubeUrl}\n\nStatus: PRIVATE — ready for your review. Publish when happy 🚀\nDuration: ${finalDurationSeconds?.toFixed(1) || '?'}s`);

  // Update pipeline run with awaiting_review status
  await sb.from('video_pipeline_runs')
    .update({ status: 'awaiting_review' })
    .eq('task_id', taskId)
    .eq('stage', STAGE);

  console.log(`  YouTube private URL: ${youtubeUrl}`);
  console.log('✅ Stage 8: Video uploaded — continuing to publish automatically.');

  return { ...state, youtubeVideoId, youtubeUrl };
}
