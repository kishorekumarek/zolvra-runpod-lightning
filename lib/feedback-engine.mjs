// lib/feedback-engine.mjs — Feedback analysis + prompt updater
import { getSupabase } from './supabase.mjs';
import { getSetting, setSetting } from './settings.mjs';
import { createNexusCard } from './nexus-client.mjs';
import { uploadReport } from './storage.mjs';
import { withRateLimit } from './claude-rate-limiter.mjs';

/**
 * Analyze feedback for a single video after publishing.
 */
export async function analyzeVideoFeedback(videoId) {
  const sb = getSupabase();

  const { data: feedbackRows, error } = await sb
    .from('pipeline_feedback')
    .select('*')
    .eq('video_id', videoId);

  if (error) throw new Error(`analyzeVideoFeedback query failed: ${error.message}`);

  const denied = (feedbackRows || []).filter(r => r.decision === 'denied');

  for (const row of denied) {
    // Stage 4 denial = image prompt issue
    if (row.stage === 4 && row.character_id) {
      await flagCharacterPromptForReview(row.character_id, row.comment, row.prompt_used);
    }

    // Stage 5 denial = animation motion type issue
    if (row.stage === 5) {
      console.log(`Stage 5 denial for scene ${row.scene_number}: ${row.comment}`);
    }

    // Stage 6 denial = audio/voice issue
    if (row.stage === 6) {
      console.log(`Stage 6 audio denial: ${row.comment}`);
    }
  }
}

/**
 * Flag a character's image_prompt for review after denials.
 */
async function flagCharacterPromptForReview(characterId, comment, promptUsed) {
  const sb = getSupabase();

  // Fetch current character data
  const { data: char, error } = await sb
    .from('character_library')
    .select('feedback, image_prompt, name, voice_id')
    .eq('id', characterId)
    .single();

  if (error || !char) {
    console.error(`Could not fetch character ${characterId}: ${error?.message}`);
    return;
  }

  // Append new feedback if not already there
  const existingFeedback = char.feedback || [];
  const newComment = comment || 'Image quality issue';
  if (!existingFeedback.includes(newComment)) {
    existingFeedback.push(newComment);

    await sb
      .from('character_library')
      .update({ feedback: existingFeedback })
      .eq('id', characterId);
  }

  // If >= 2 denials, attempt prompt improvement
  if (existingFeedback.length >= 2) {
    const improvedPrompt = await improveCharacterPrompt(
      char.image_prompt,
      existingFeedback,
      char.name
    );

    if (improvedPrompt && improvedPrompt !== char.image_prompt) {
      // Increment version, mark for re-approval
      const { data: updated } = await sb
        .from('character_library')
        .select('version')
        .eq('id', characterId)
        .single();

      await sb
        .from('character_library')
        .update({
          image_prompt: improvedPrompt,
          approved: false,
          version: (updated?.version || 1) + 1,
        })
        .eq('id', characterId);

      await createNexusCard({
        title: `Review updated image prompt: ${char.name}`,
        description: `Auto-updated after ${existingFeedback.length} denials.\n\nNew prompt:\n${improvedPrompt}\n\nFeedback:\n${existingFeedback.join('\n')}`,
        task_type: 'character_proposal',
        priority: 'medium',
        stream: 'youtube',
      });

      console.log(`✅ Updated image prompt for ${char.name} (version ${(updated?.version || 1) + 1})`);
    }
  }
}

/**
 * Attempt to improve a character image prompt using Claude (if API key set).
 * Falls back to appending feedback as hints if Claude is unavailable.
 */
async function improveCharacterPrompt(currentPrompt, feedbackArray, characterName) {
  if (!process.env.ANTHROPIC_API_KEY || !currentPrompt) {
    // Simple fallback: append feedback hints
    const hints = feedbackArray.map(f => `avoid: ${f}`).join(', ');
    return `${currentPrompt}. ${hints}`;
  }

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await withRateLimit(() => client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are improving an image generation prompt for a Tamil kids animated character named "${characterName}".

Current prompt: ${currentPrompt}

Human feedback (reasons for rejection):
${feedbackArray.map((f, i) => `${i + 1}. ${f}`).join('\n')}

Produce an improved image prompt that addresses the feedback.
Return ONLY the improved prompt text, no explanation.`,
      }],
    }));

    return message.content[0]?.text?.trim() || currentPrompt;
  } catch (err) {
    console.error('Claude prompt improvement failed:', err.message);
    return `${currentPrompt}. Feedback notes: ${feedbackArray.join('; ')}`;
  }
}

/**
 * Run batch analysis after every 5 videos.
 */
export async function runBatchFeedbackAnalysis() {
  const sb = getSupabase();

  // Get last 5 completed video IDs
  const { data: runs } = await sb
    .from('video_pipeline_runs')
    .select('task_id')
    .eq('stage', 9)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(5);

  if (!runs || runs.length === 0) return;

  const videoIds = runs.map(r => r.task_id);

  const { data: allFeedback } = await sb
    .from('pipeline_feedback')
    .select('*')
    .in('video_id', videoIds);

  const feedback = allFeedback || [];

  // Update SSML defaults if audio denial rate is high
  const audioFeedback = feedback.filter(r => r.stage === 6);
  if (audioFeedback.length > 0) {
    await updateSSMLDefaults(audioFeedback);
  }

  // Update Kling defaults if animation denial rate is high
  const animFeedback = feedback.filter(r => r.stage === 5);
  if (animFeedback.length > 0) {
    await updateKlingDefaults(animFeedback);
  }

  // Generate improvement report
  await generateImprovementReport(videoIds, feedback);
}

async function updateSSMLDefaults(audioFeedbackRows) {
  let currentDefaults;
  try {
    currentDefaults = await getSetting('ssml_defaults');
  } catch {
    return;
  }

  const denied = audioFeedbackRows.filter(r => r.decision === 'denied');
  if (denied.length === 0) return;

  const tooFastCount = denied.filter(r =>
    r.comment?.toLowerCase().includes('too fast')
  ).length;

  if (tooFastCount / denied.length > 0.4) {
    currentDefaults.narrator_rate = 'x-slow';
    currentDefaults.pause_between_lines_ms = (currentDefaults.pause_between_lines_ms || 600) + 100;
    await setSetting('ssml_defaults', currentDefaults);
    console.log('📊 SSML defaults updated: slowed narrator rate');
  }
}

async function updateKlingDefaults(animFeedbackRows) {
  let current;
  try {
    current = await getSetting('kling_motion_type_defaults');
  } catch {
    return;
  }

  const motionTypes = ['dialogue', 'action', 'landscape', 'emotional'];
  let updated = false;

  for (const motionType of motionTypes) {
    const typeRows = animFeedbackRows.filter(r => r.comment?.includes(motionType));
    if (typeRows.length === 0) continue;

    const denialRate = typeRows.filter(r => r.decision === 'denied').length / typeRows.length;
    if (denialRate > 0.4 && current[motionType]) {
      current[motionType].cfg_scale = Math.max(0.1, (current[motionType].cfg_scale || 0.5) - 0.1);
      updated = true;
    }
  }

  if (updated) {
    await setSetting('kling_motion_type_defaults', current);
    console.log('📊 Kling motion defaults updated');
  }
}

export async function generateImprovementReport(videoIds, feedback) {
  const denied = feedback.filter(r => r.decision === 'denied');
  const denialRate = feedback.length > 0 ? denied.length / feedback.length : 0;

  const byStage = {};
  for (const row of feedback) {
    if (!byStage[row.stage]) byStage[row.stage] = { total: 0, denied: 0 };
    byStage[row.stage].total++;
    if (row.decision === 'denied') byStage[row.stage].denied++;
  }

  const report = {
    generated_at:    new Date().toISOString(),
    videos_analyzed: videoIds.length,
    total_decisions: feedback.length,
    denial_rate:     denialRate,
    by_stage:        byStage,
  };

  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-improvement-report.json`;
  try {
    await uploadReport({ filename, data: report });
  } catch (err) {
    console.error('Failed to upload improvement report:', err.message);
  }

  await createNexusCard({
    title: `📊 ${videoIds.length}-Video Improvement Report — ${new Date().toLocaleDateString()}`,
    description: [
      `Videos analyzed: ${videoIds.length}`,
      `Total decisions: ${feedback.length}`,
      `Overall denial rate: ${(denialRate * 100).toFixed(1)}%`,
      `By stage: ${Object.entries(byStage).map(([s, d]) => `Stage ${s}: ${d.denied}/${d.total} denied`).join(', ')}`,
    ].join('\n'),
    task_type: 'report',
    stream: 'youtube',
  });
}
