// stages/stage-08-review.mjs — Upload unlisted to YouTube, post NEXUS card for visibility
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';
import { createNexusCard } from '../lib/nexus-client.mjs';
import { uploadVideoUnlisted } from '../lib/youtube.mjs';
import { withRetry } from '../lib/retry.mjs';

const STAGE = 8;

/**
 * Stage 8: Upload to YouTube as Unlisted → create NEXUS review card (non-blocking) → continue.
 */
export async function runStage8(taskId, tracker, state = {}) {
  console.log('📤 Stage 8: Human review (YouTube upload + NEXUS)...');

  const { script, finalVideoPath, finalDurationSeconds, parentCardId } = state;
  if (!script) throw new Error('Stage 8: script not found');
  if (!finalVideoPath) throw new Error('Stage 8: finalVideoPath not found');

  const sb = getSupabase();

  // Upload to YouTube as unlisted
  console.log('  Uploading to YouTube (unlisted)...');
  const youtubeVideoId = await withRetry(
    () => uploadVideoUnlisted({ videoPath: finalVideoPath, script, taskId }),
    { maxRetries: 2, baseDelayMs: 10000, stage: STAGE, taskId }
  );

  const youtubeUrl = `https://youtu.be/${youtubeVideoId}`;

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
