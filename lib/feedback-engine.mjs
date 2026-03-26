// lib/feedback-engine.mjs — Feedback analysis + prompt updater
import { getSupabase } from './supabase.mjs';
import { getSetting, setSetting } from './settings.mjs';
import { sendTelegramMessage } from './telegram.mjs';
import { uploadReport } from './storage.mjs';
import { callClaude } from '../../shared/claude.mjs';

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

    // Stage 6 denial = audio/voice issue → accumulate voice feedback
    if (row.stage === 6) {
      await accumulateVoiceFeedback(row.comment, row.scene_number);
    }
  }
}

/**
 * Record a Stage 6 voice/dialogue denial to pipeline_feedback.
 * Called from stage-06-voice.mjs during per-scene approval loop.
 * @param {{ videoId: string, sceneNumber: number, speaker: string, comment: string, enhancedText: string }}
 */
export async function recordVoiceFeedback({ videoId, sceneNumber, speaker, comment, enhancedText }) {
  const sb = getSupabase();
  try {
    await sb.from('pipeline_feedback').insert({
      video_id: videoId,
      stage: 6,
      scene_number: sceneNumber,
      decision: 'denied',
      comment: comment || 'Voice quality issue',
      prompt_used: enhancedText,
      metadata: { speaker },
    });
    console.log(`  📝 Voice feedback recorded for scene ${sceneNumber}`);
  } catch (err) {
    console.error(`  ⚠️  Failed to record voice feedback: ${err.message}`);
  }
}

/**
 * Accumulate voice feedback patterns and update voice_feedback rules in pipeline_settings
 * when 2+ denials follow the same pattern (e.g., "too flat", "too fast", "wrong emotion").
 * These rules are read by Stage 2's system prompt for future scripts.
 */
async function accumulateVoiceFeedback(comment, sceneNumber) {
  if (!comment) return;

  const sb = getSupabase();

  // Fetch all Stage 6 denials to detect patterns
  const { data: allDenials } = await sb
    .from('pipeline_feedback')
    .select('comment, metadata')
    .eq('stage', 6)
    .eq('decision', 'denied')
    .order('created_at', { ascending: false })
    .limit(50);

  if (!allDenials || allDenials.length < 2) return;

  // Detect common patterns
  const patterns = {
    too_flat: ['flat', 'monotone', 'boring', 'no emotion', 'lifeless'],
    too_fast: ['too fast', 'rushing', 'slow down'],
    wrong_emotion: ['wrong emotion', 'wrong tone', 'doesn\'t match'],
    too_loud: ['too loud', 'shouting', 'tone it down'],
    too_quiet: ['too quiet', 'can\'t hear', 'speak up'],
  };

  const patternCounts = {};
  for (const denial of allDenials) {
    const lower = (denial.comment || '').toLowerCase();
    for (const [pattern, keywords] of Object.entries(patterns)) {
      if (keywords.some(kw => lower.includes(kw))) {
        patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
      }
    }
  }

  // If any pattern has 2+ occurrences, create/update a voice_feedback rule
  const rules = [];
  if (patternCounts.too_flat >= 2) {
    rules.push('Use more exclamation marks and shorter, punchier sentences for dialogue. Add emotional interjections (aiyyo!, da!, wah!).');
  }
  if (patternCounts.too_fast >= 2) {
    rules.push('Write dialogue with natural pause points using commas and ellipses. Keep sentences under 15 words.');
  }
  if (patternCounts.wrong_emotion >= 2) {
    rules.push('Ensure emotion field accurately matches the dialogue tone. Excited dialogue should have ! and energetic words.');
  }

  if (rules.length > 0) {
    try {
      await setSetting('voice_feedback', rules.join('\n'));
      console.log(`📊 Voice feedback rules updated: ${rules.length} pattern(s) detected`);
    } catch (err) {
      console.error(`  ⚠️  Failed to update voice feedback rules: ${err.message}`);
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

      await sendTelegramMessage(`🎨 Updated image prompt for ${char.name} (v${(updated?.version || 1) + 1})\nNew prompt: ${improvedPrompt.slice(0, 200)}`);

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
    const message = await callClaude({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 1024,
      system: 'You are improving image generation prompts for Tamil kids animated characters. Given a current prompt and human feedback, produce an improved prompt that addresses the feedback. Return ONLY the improved prompt text, no explanation.',
      messages: [{
        role: 'user',
        content: `Character: "${characterName}"

Current prompt: ${currentPrompt}

Human feedback (reasons for rejection):
${feedbackArray.map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
      }],
    });

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

  await sendTelegramMessage(`📊 ${videoIds.length}-Video Improvement Report\nDenial rate: ${(denialRate * 100).toFixed(1)}%\n${Object.entries(byStage).map(([s, d]) => `Stage ${s}: ${d.denied}/${d.total} denied`).join(', ')}`);
}
