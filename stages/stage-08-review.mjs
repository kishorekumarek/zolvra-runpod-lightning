// stages/stage-08-review.mjs — Upload unlisted to YouTube, add #Shorts, notify Telegram, post NEXUS card
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';
import { createNexusCard } from '../lib/nexus-client.mjs';
import { uploadVideoUnlisted, getYouTubeClient } from '../lib/youtube.mjs';
import { getVideoType } from '../lib/settings.mjs';
import { withRetry } from '../lib/retry.mjs';

const STAGE = 8;
const TELEGRAM_CHAT_ID = 7879469053;

/**
 * Send notification to Darl via Telegram bot.
 */
async function notifyTelegram(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.warn('  ⚠️  TELEGRAM_BOT_TOKEN not set — skipping Telegram notification');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
    const result = await res.json();
    if (result.ok) console.log('  📱 Telegram notification sent');
    else console.warn(`  ⚠️  Telegram failed: ${result.description}`);
  } catch (err) {
    console.warn(`  ⚠️  Telegram error: ${err.message}`);
  }
}

/**
 * Stage 8: Upload to YouTube as Unlisted → add #Shorts tag → notify Telegram → create NEXUS review card.
 */
export async function runStage8(taskId, tracker, state = {}) {
  console.log('📤 Stage 8: Human review (YouTube upload + NEXUS)...');

  const { script, finalVideoPath, finalDurationSeconds, parentCardId } = state;
  if (!script) throw new Error('Stage 8: script not found');
  if (!finalVideoPath) throw new Error('Stage 8: finalVideoPath not found');

  const sb = getSupabase();
  const videoType = state.videoType ?? await getVideoType();

  // Upload to YouTube as unlisted
  console.log('  Uploading to YouTube (unlisted)...');
  const youtubeVideoId = await withRetry(
    () => uploadVideoUnlisted({ videoPath: finalVideoPath, script, taskId }),
    { maxRetries: 2, baseDelayMs: 10000, stage: STAGE, taskId }
  );

  const youtubeUrl = `https://youtu.be/${youtubeVideoId}`;

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
  await notifyTelegram(`🎬 ${title} uploaded!\n\n📺 ${youtubeUrl}\n\nStatus: UNLISTED — ready for your review.\nDuration: ${finalDurationSeconds?.toFixed(1) || '?'}s`);

  // Update pipeline run with awaiting_review status
  await sb.from('video_pipeline_runs')
    .update({ status: 'awaiting_review' })
    .eq('task_id', taskId)
    .eq('stage', STAGE);

  // Create NEXUS review card
  const cardId = await createNexusCard({
    title: `🎬 Video Ready for Review: ${script.metadata?.title}`,
    description: [
      `**Episode:** ${script.metadata?.episode}`,
      `**Duration:** ${finalDurationSeconds?.toFixed(1)}s`,
      `**YouTube URL (unlisted):** ${youtubeUrl}`,
      `\n**YouTube SEO:**`,
      `- Title: ${script.youtube_seo?.title}`,
      `- Tags: ${script.youtube_seo?.tags?.join(', ')}`,
      `\n---`,
      `Approve to publish this video to YouTube.`,
      `Request Changes to reject and provide feedback for re-generation.`,
    ].join('\n'),
    task_type: 'video_delivery',
    priority: 'high',
    parent_id: parentCardId,
    content_url: youtubeUrl,
    stream: 'youtube',
  });

  console.log(`  NEXUS review card created: ${cardId} (non-blocking)`);
  console.log(`  YouTube unlisted URL: ${youtubeUrl}`);
  console.log('✅ Stage 8: Video uploaded — continuing to publish automatically.');

  return { ...state, youtubeVideoId, youtubeUrl };
}
