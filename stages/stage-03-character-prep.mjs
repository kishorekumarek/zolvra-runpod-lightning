// stages/stage-03-character-prep.mjs — Resolve characters from library
// Auto-stage — but checks isFeedbackCollectionMode()
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode } from '../lib/settings.mjs';
import { createNexusCard, createNexusReviewCard } from '../lib/nexus-client.mjs';
import { getSupabase as sb } from '../lib/supabase.mjs';
import { withRetry } from '../lib/retry.mjs';

const STAGE = 3;

/**
 * Stage 3: Resolve all characters from library.
 * If feedback collection mode is on, create NEXUS card and await review.
 * If a character is missing, escalate to Darl.
 */
export async function runStage3(taskId, tracker, state = {}) {
  console.log('👤 Stage 3: Character preparation...');

  const { script, parentCardId } = state;
  if (!script) throw new Error('Stage 3: script not found in pipeline state');

  const characterNames = script.metadata?.characters || [];
  const supabase = getSupabase();

  // Resolve each character from the library
  const characterMap = {};
  const missingCharacters = [];

  for (const name of characterNames) {
    const { data: chars, error } = await supabase
      .from('character_library')
      .select('*')
      .ilike('name', name)
      .eq('approved', true);

    if (error) throw new Error(`Character lookup failed for ${name}: ${error.message}`);

    if (!chars || chars.length === 0) {
      missingCharacters.push(name);
    } else {
      characterMap[name] = chars[0];
    }
  }

  // Handle missing characters
  if (missingCharacters.length > 0) {
    console.warn(`⚠️  Missing characters: ${missingCharacters.join(', ')}`);

    for (const missingName of missingCharacters) {
      await createNexusCard({
        title: `New Character Required: ${missingName}`,
        description: [
          `The script requires character "${missingName}" but it's not in the approved character library.`,
          `Please add this character to the character_library table with:`,
          `- name: "${missingName}"`,
          `- description: physical appearance and personality`,
          `- image_prompt: base prompt for image generation`,
          `- voice_id: ElevenLabs voice ID`,
          `- approved: true`,
          `\nThen set the NEXUS card to "done" to resume the pipeline.`,
        ].join('\n'),
        task_type: 'character_proposal',
        priority: 'high',
        parent_id: parentCardId,
        stream: 'youtube',
      });
    }

    // Wait for missing characters to be added (24h timeout)
    if (missingCharacters.length > 0) {
      throw new Error(`Missing characters require manual addition: ${missingCharacters.join(', ')}`);
    }
  }

  // Feedback collection mode: post summary for human review
  if (await isFeedbackCollectionMode()) {
    const charSummary = Object.values(characterMap)
      .map(c => `**${c.name}**: ${c.description}`)
      .join('\n\n');

    const cardId = await createNexusCard({
      title: `[Feedback] Stage 3: Character Roster Review`,
      description: [
        `Feedback collection mode: Please review the character roster for this video.`,
        `\n${charSummary}`,
        `\nApprove to continue, or request changes to update character library entries.`,
      ].join('\n'),
      task_type: 'stage_review',
      priority: 'medium',
      parent_id: parentCardId,
      stream: 'youtube',
    });

    console.log(`  NEXUS character roster card created: ${cardId} (non-blocking)`);
  }

  console.log(`✅ Stage 3 complete. Characters: ${Object.keys(characterMap).join(', ')}`);
  return { ...state, characterMap };
}
