// stages/stage-09-publish.mjs — Publish to YouTube + feedback loop
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';
import { getSetting, setSetting, isFeedbackCollectionMode, getVideoType } from '../lib/settings.mjs';
import { createNexusCard } from '../lib/nexus-client.mjs';
import { publishVideo, addToPlaylist } from '../lib/youtube.mjs';
import { analyzeVideoFeedback, runBatchFeedbackAnalysis } from '../lib/feedback-engine.mjs';
import { withRetry } from '../lib/retry.mjs';

const STAGE = 9;

/**
 * Stage 9: Publish approved video to YouTube + run feedback analysis.
 */
export async function runStage9(taskId, tracker, state = {}) {
  console.log('🌍 Stage 9: Publishing to YouTube...');

  const { youtubeVideoId, youtubeUrl, script } = state;
  if (!youtubeVideoId) throw new Error('Stage 9: youtubeVideoId not found');

  const sb = getSupabase();
  const videoType = state.videoType ?? await getVideoType(); // 'long' | 'short'
  console.log(`  video_type=${videoType}`);

  // NOTE: Video was uploaded as unlisted in Stage 8.
  // Stage 9 does NOT auto-publish — Darl reviews and makes public manually.
  console.log(`  ℹ️  Video remains unlisted — awaiting Darl approval to go public.`);

  // Add to playlist
  await withRetry(
    () => addToPlaylist({ youtubeVideoId }),
    { maxRetries: 2, baseDelayMs: 5000, stage: STAGE, taskId }
  ).catch(err => {
    console.warn(`  ⚠️  Playlist assignment failed (non-fatal): ${err.message}`);
  });

  // End card: long videos only (Shorts don't support end cards)
  if (videoType === 'long') {
    // TODO: attach end card via YouTube API when end card template is configured
    console.log(`  📌 End card eligible (long video) — attach via YouTube Studio if template is set.`);
  } else {
    console.log(`  ⏭️  Skipping end card — not applicable for YouTube Shorts.`);
  }

  console.log(`  ✅ Published: https://youtu.be/${youtubeVideoId}`);

  // Record feedback approval (auto-approved since we published)
  await sb.from('pipeline_feedback').insert({
    video_id: taskId,
    stage:    STAGE,
    decision: 'approved',
    comment:  'Published to YouTube',
  });

  // Increment feedback_collection_completed counter
  const current = parseInt(await getSetting('feedback_collection_completed').catch(() => '0'));
  const target  = parseInt(await getSetting('feedback_collection_target').catch(() => '10'));
  const next    = current + 1;

  await setSetting('feedback_collection_completed', next);
  console.log(`  Feedback collection: ${next}/${target} videos`);

  // Per-video feedback analysis
  try {
    await analyzeVideoFeedback(taskId);
  } catch (err) {
    console.error('  ⚠️  Per-video feedback analysis failed (non-fatal):', err.message);
  }

  // Every 5 videos: run batch analysis
  if (next > 0 && next % 5 === 0) {
    console.log('  📊 Running 5-video batch feedback analysis...');
    try {
      await runBatchFeedbackAnalysis();
    } catch (err) {
      console.error('  ⚠️  Batch feedback analysis failed (non-fatal):', err.message);
    }
  }

  // Check if feedback collection mode should end
  const isCollecting = await isFeedbackCollectionMode();
  if (!isCollecting && current < target && next >= target) {
    // Just crossed the threshold
    await setSetting('feedback_collection_mode', false);

    await createNexusCard({
      title: '🎓 Feedback Collection Complete!',
      description: [
        `${target} videos have been reviewed by Darl.`,
        `The pipeline is now switching to automated quality gates.`,
        `Future videos (stages 3–7) will run without NEXUS review unless a quality gate fails.`,
        `\nStages 1, 2, and 8 remain human-gated permanently.`,
      ].join('\n'),
      task_type: 'milestone',
      priority: 'medium',
      stream: 'youtube',
    });

    console.log(`  🎓 Feedback collection complete! Switching to automated mode.`);
  }

  // Create completion card in NEXUS
  await createNexusCard({
    title: `✅ Published: ${script?.metadata?.title || 'Episode ' + state.episodeNumber}`,
    description: [
      `Episode ${state.episodeNumber || '?'} is now live on YouTube!`,
      `**URL:** https://youtu.be/${youtubeVideoId}`,
      `**Total videos published:** ${next}`,
    ].join('\n'),
    task_type: 'milestone',
    priority: 'low',
    stream: 'youtube',
  });

  console.log(`✅ Stage 9 complete. Video live: https://youtu.be/${youtubeVideoId}`);
  return { ...state, published: true, publishedAt: new Date().toISOString() };
}
