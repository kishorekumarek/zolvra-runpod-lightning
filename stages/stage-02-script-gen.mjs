// stages/stage-02-script-gen.mjs — Claude generates JSON script → NEXUS review
// ALWAYS human-gated
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';
import { createNexusCard, awaitNexusDecision } from '../lib/nexus-client.mjs';
import { withRetry } from '../lib/retry.mjs';
import { callClaude } from '../../shared/claude.mjs';

const CLAUDE_SYSTEM_PROMPT_TEMPLATE = `You are a Tamil children's story scriptwriter for the YouTube channel @tinytamiltales.

RULES:
1. Return ONLY valid JSON. No markdown. No explanation. No wrapping.
2. All dialogue (lines[].text) must be in Tamil script.
3. visual_description must be in English (used for image generation prompts).
4. Keep language simple — target age 3–7 years.
5. Each scene's estimated_duration_seconds should reflect the line count (allow ~3s per short line).
6. Sum of all scene estimated_duration_seconds must approximately equal metadata.target_duration_seconds.
7. Always include NARRATOR as a character.
8. motion_type must be exactly one of: dialogue, action, landscape, emotional.
9. emotion must be exactly one of: warm, happy, sad, surprised, scared, excited, calm, curious, angry, proud.
10. Do not create new characters not listed in the concept brief.
11. Include 28–32 scenes for a 5-minute video target. Each scene MUST be 8–12 seconds maximum. Short, punchy scenes. One moment per scene. The audio per scene (narration + dialogue) must be completable in 10 seconds.
12. IMPORTANT: Keep each scene extremely short — one action, one line of dialogue, one emotion. Never more than 2 short lines per scene. Target 10 seconds per scene.

CHARACTER LIBRARY CONTEXT:
{CHARACTER_LIBRARY_JSON}

STORY CONCEPT:
{CONCEPT_TEXT}

EPISODE NUMBER: {EPISODE_NUMBER}
TARGET DURATION: {TARGET_DURATION_SECONDS} seconds`;

/**
 * Stage 2: Generate script via Claude, post to NEXUS for human review.
 * ALWAYS human-gated.
 */
export async function runStage2(taskId, tracker, state = {}) {
  console.log('📝 Stage 2: Generating script...');

  const { concept, parentCardId } = state;
  if (!concept) throw new Error('Stage 2: concept not found in pipeline state');

  // Get character library for Claude context
  const sb = getSupabase();
  const { data: characters } = await sb
    .from('character_library')
    .select('name, description, image_prompt, voice_id, approved')
    .eq('approved', true);

  // Generate episode number
  const { count: episodeCount } = await sb
    .from('video_pipeline_runs')
    .select('*', { count: 'exact', head: true })
    .eq('stage', 9)
    .eq('status', 'completed');

  const episodeNumber = (episodeCount || 0) + 1;

  // Generate script with retries
  const script = await withRetry(
    () => generateScript(concept, characters || [], episodeNumber),
    { maxRetries: 5, baseDelayMs: 15000, stage: 2, taskId }
  );

  // Auto-fill youtube_seo if Claude omitted it
  if (!script.youtube_seo) {
    script.youtube_seo = {
      title: `${concept.title} | Tamil Kids Story | Tiny Tamil Tales`,
      description: 'A heartwarming Tamil story for little ones. Subscribe to Tiny Tamil Tales! | குழந்தைகளுக்கான தமிழ் கதை',
      tags: ['tamil kids story', 'tamil animated story', 'tiny tamil tales', 'சிறுவர் கதை', 'tamil cartoon'],
    };
  }

  // Validate script structure
  validateScript(script);

  // Save script to DB state (persisted for restarts)
  await sb.from('video_pipeline_runs').upsert({
    task_id: taskId,
    stage: 2,
    status: 'awaiting_review',
    pipeline_state: { script, episodeNumber },
  }, { onConflict: 'task_id,stage' });

  // Post to NEXUS for human review
  const scriptJson = JSON.stringify(script, null, 2);
  const cardId = await createNexusCard({
    title: `Script Review: ${script.metadata?.title || concept.title}`,
    description: [
      `**Episode:** ${episodeNumber}`,
      `**Target duration:** ${script.metadata?.target_duration_seconds}s`,
      `**Scenes:** ${script.scenes?.length || 0}`,
      `**Characters:** ${script.metadata?.characters?.join(', ')}`,
      `\n\`\`\`json\n${scriptJson.slice(0, 2000)}\n\`\`\``,
      scriptJson.length > 2000 ? '\n_(truncated — full script in pipeline state)_' : '',
    ].join('\n'),
    task_type: 'script_proposal',
    priority: 'high',
    parent_id: parentCardId,
    stream: 'youtube',
  });

  console.log(`  Script sent to NEXUS for review (card: ${cardId})`);
  console.log('  ⏳ Waiting for Darl to approve script...');

  const decision = await awaitNexusDecision(cardId);

  if (!decision.approved) {
    throw new Error(`Script rejected: ${decision.comment || 'No reason given'}. Re-run stage 2 with feedback.`);
  }

  console.log('✅ Script approved!');

  return { ...state, script, episodeNumber };
}

async function generateScript(concept, characters, episodeNumber) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('No ANTHROPIC_API_KEY — using sample script');
    return getSampleScript(concept, episodeNumber);
  }

  const characterJson = JSON.stringify(characters.map(c => ({
    name: c.name,
    description: c.description,
  })), null, 2);

  const systemPrompt = CLAUDE_SYSTEM_PROMPT_TEMPLATE
    .replace('{CHARACTER_LIBRARY_JSON}', characterJson)
    .replace('{CONCEPT_TEXT}', `Title: ${concept.title}\nTheme: ${concept.theme}\nSynopsis: ${concept.synopsis}\nCharacters: ${concept.characters?.join(', ')}`)
    .replace('{EPISODE_NUMBER}', String(episodeNumber))
    .replace('{TARGET_DURATION_SECONDS}', String(concept.targetDurationSeconds || 300));

  const message = await callClaude({
    model: 'claude-sonnet-4-6',
    maxTokens: 4096,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: 'Generate the complete Tamil kids story script as specified. Return only valid JSON. No markdown fences.',
    }],
  });

  let text = message.content[0]?.text?.trim() || '';
  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(text);
}

function validateScript(script) {
  if (!script.metadata) throw new Error('Script missing metadata');
  if (!script.scenes || !Array.isArray(script.scenes)) throw new Error('Script missing scenes array');
  if (script.scenes.length === 0) throw new Error('Script has no scenes');
  if (!script.youtube_seo) throw new Error('Script missing youtube_seo');

  const validMotionTypes = ['dialogue', 'action', 'landscape', 'emotional'];
  const validEmotions = ['warm', 'happy', 'sad', 'surprised', 'scared', 'excited', 'calm', 'curious', 'angry', 'proud'];

  for (const scene of script.scenes) {
    if (!validMotionTypes.includes(scene.motion_type)) {
      throw new Error(`Invalid motion_type "${scene.motion_type}" in scene ${scene.scene_number}`);
    }
    for (const line of scene.lines || []) {
      // Auto-fill missing or invalid emotions with 'warm' (neutral/safe default)
      if (!line.emotion || !validEmotions.includes(line.emotion)) {
        line.emotion = 'warm';
      }
    }
  }
}

function getSampleScript(concept, episodeNumber) {
  return {
    metadata: {
      title: concept.title || 'Sample Tamil Story',
      episode: episodeNumber,
      target_duration_seconds: 300,
      characters: ['NARRATOR', 'Velu'],
    },
    youtube_seo: {
      title: `${concept.title} | Tamil Kids Story | Tiny Tamil Tales`,
      description: 'A heartwarming Tamil story for little ones. Subscribe to Tiny Tamil Tales!',
      tags: ['tamil kids story', 'tamil animated story', 'tiny tamil tales', 'சிறுவர் கதை'],
    },
    scenes: [
      {
        scene_number: 1,
        visual_description: 'A beautiful Tamil village at sunrise. Children play in the courtyard.',
        motion_type: 'landscape',
        estimated_duration_seconds: 30,
        lines: [
          { speaker: 'NARRATOR', text: 'ஒரு அழகிய கிராமத்தில் வேலு என்ற சிறுவன் வாழ்ந்தான்.', emotion: 'warm' },
        ],
      },
      {
        scene_number: 2,
        visual_description: 'Velu, a cheerful Tamil boy, runs through the village waving hello to everyone.',
        motion_type: 'action',
        estimated_duration_seconds: 25,
        lines: [
          { speaker: 'Velu', text: 'வணக்கம்! வணக்கம்!', emotion: 'happy' },
          { speaker: 'NARRATOR', text: 'வேலு எல்லோரையும் மகிழ்ச்சியாக சந்தித்தான்.', emotion: 'warm' },
        ],
      },
    ],
  };
}
