// stages/stage-01b-story-intake.mjs — Takes a user-provided story/outline,
// extracts metadata (title, theme, characters, synopsis) via Claude,
// sends to Telegram for Darl's approval, and builds a concept object
// with the full outline for Stage 2.
//
// REWRITTEN for pipeline schema rewrite: writes to concepts + pipeline_state tables.
// Dual-write: also returns concept object for launcher backward compatibility.
import 'dotenv/config';
import { callClaude } from '../../shared/claude.mjs';
import {
  sendTelegramMessage, sendTelegramMessageWithButtons, waitForTelegramResponse,
} from '../lib/telegram.mjs';
import { approveCharacterList } from '../lib/character-approval.mjs';
import { parseClaudeJSON } from '../lib/parse-claude-json.mjs';
import { insertConcept, insertPipelineState, getPipelineState } from '../lib/pipeline-db.mjs';
import { isFeedbackCollectionMode } from '../lib/settings.mjs';
import { DEFAULTS } from '../lib/video-config.mjs';

/**
 * Stage 1B: Extract concept metadata from a user-provided story outline.
 * The full outline is preserved in concept.outline so Stage 2 uses it
 * instead of the generic story arc.
 *
 * @param {string} storyText - The full story/outline text from the user
 * @param {object} [opts]
 * @param {string} [opts.videoType] - 'short' or 'long' — passed through to concept
 * @param {string} [opts.taskId] - If provided, writes to concepts + pipeline_state tables
 * @returns {{ title, theme, synopsis, characters, outline, videoType?, artStyle, conceptId? }}
 */
export async function extractConceptFromStory(storyText, { videoType, taskId } = {}) {
  console.log('📖 Stage 1B: Extracting concept from user story...');

  const systemPrompt = `You are a metadata extractor for a Tamil children's YouTube channel called @tinytamiltales.

Given a story outline, extract:
1. title — a short, catchy title for the video
2. theme — 2-5 keywords (e.g., "courage, music, community")
3. synopsis — 2-3 sentence summary of the story
4. characters — array of character names that appear in the story (lowercase)
5. artStyle — ALWAYS use "3D Pixar animation still". Do not change this.

Return ONLY a JSON object. No markdown. No explanation.
{
  "title": "...",
  "theme": "...",
  "synopsis": "...",
  "characters": ["character1", "character2"],
  "artStyle": "3D Pixar animation still"
}`;

  const message = await callClaude({
    model: 'claude-sonnet-4-6',
    maxTokens: 512,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: storyText,
    }],
  });

  const parsed = parseClaudeJSON(message.content[0]?.text, 'Stage 1B initial extraction');

  if (!parsed.title || !parsed.characters) {
    throw new Error('Stage 1B: Claude failed to extract title or characters from story');
  }

  const concept = {
    title: parsed.title,
    theme: parsed.theme || '',
    synopsis: parsed.synopsis || '',
    characters: parsed.characters.map(c => c.toLowerCase()),
    outline: storyText,
    artStyle: DEFAULTS.artStyle,
    ...(videoType ? { videoType } : {}),
  };

  console.log(`  Title: ${concept.title}`);
  console.log(`  Theme: ${concept.theme}`);
  console.log(`  Art style: ${concept.artStyle}`);
  console.log(`  Characters: ${concept.characters.join(', ')}`);

  const feedbackMode = await isFeedbackCollectionMode();

  // Auto-mode: skip approval, persist concept + characters as-is, send notification.
  if (!feedbackMode) {
    await sendTelegramMessage(
      `📖 Stage 1B (auto) — concept extracted: "${concept.title}"\n` +
      `Characters: ${concept.characters.join(', ')}`,
    );

    if (taskId) {
      const existing = await getPipelineState(taskId);
      if (existing?.concept_id) {
        concept.conceptId = existing.concept_id;
        console.log(`  ↩️  pipeline_state already exists (concept_id: ${existing.concept_id}) — skipping insert`);
      } else {
        const conceptId = await insertConcept({
          title: concept.title,
          theme: concept.theme,
          synopsis: concept.synopsis,
          characters: concept.characters,
          outline: concept.outline,
          art_style: concept.artStyle || DEFAULTS.artStyle,
          video_type: concept.videoType || 'short',
        });
        await insertPipelineState(taskId, conceptId);
        concept.conceptId = conceptId;
        console.log(`  ✓ Concept saved to new tables (concept_id: ${conceptId})`);
      }
    }

    console.log(`✅ Stage 1B complete (auto-mode)`);
    return concept;
  }

  // Telegram approval gate
  let lastParsed = parsed;
  const MAX_REJECT_CYCLES = 3;
  for (let cycle = 0; cycle <= MAX_REJECT_CYCLES; cycle++) {
    const outlinePreview = concept.outline.length > 500
      ? concept.outline.slice(0, 500) + '...'
      : concept.outline;

    const approvalMsg = [
      `📖 Stage 1B — Concept Review`,
      ``,
      `Title: ${concept.title}`,
      `Theme: ${concept.theme}`,
      `Synopsis: ${concept.synopsis}`,
      `Characters: ${concept.characters.join(', ')}`,
      `Art Style: ${concept.artStyle}`,
      `Video Type: ${concept.videoType || 'not set'}`,
      ``,
      `Outline:`,
      outlinePreview,
    ].join('\n');

    const callbackPrefix = `s1b_${cycle}`;
    const msgId = await sendTelegramMessageWithButtons(approvalMsg, callbackPrefix);
    const decision = await waitForTelegramResponse(msgId, callbackPrefix);

    if (decision.approved) {
      console.log(`  ✓ Concept approved — reviewing character list...`);
      concept.characters = await approveCharacterList(concept.characters, 's1b_chars');

      // Write to concepts + pipeline_state tables if taskId provided
      if (taskId) {
        // Idempotency guard: check if pipeline_state already exists (crash recovery)
        const existing = await getPipelineState(taskId);
        if (existing?.concept_id) {
          concept.conceptId = existing.concept_id;
          console.log(`  ↩️  pipeline_state already exists (concept_id: ${existing.concept_id}) — skipping insert`);
        } else {
          const conceptId = await insertConcept({
            title: concept.title,
            theme: concept.theme,
            synopsis: concept.synopsis,
            characters: concept.characters,
            outline: concept.outline,
            art_style: concept.artStyle || DEFAULTS.artStyle,
            video_type: concept.videoType || 'short',
          });
          await insertPipelineState(taskId, conceptId);
          concept.conceptId = conceptId;
          console.log(`  ✓ Concept saved to new tables (concept_id: ${conceptId})`);
        }
      }

      console.log(`✅ Stage 1B complete`);
      return concept;
    }

    // Rejected — re-extract with feedback
    console.log(`  ✗ Concept rejected (cycle ${cycle + 1}/${MAX_REJECT_CYCLES}): ${decision.comment}`);
    if (cycle === MAX_REJECT_CYCLES) {
      throw new Error(`Stage 1B: concept rejected ${MAX_REJECT_CYCLES + 1} times — aborting`);
    }

    const retryMessage = await callClaude({
      model: 'claude-sonnet-4-6',
      maxTokens: 512,
      system: systemPrompt,
      messages: [
        { role: 'user', content: storyText },
        { role: 'assistant', content: JSON.stringify(lastParsed) },
        { role: 'user', content: `The reviewer rejected this extraction. Feedback: "${decision.comment}". Re-extract with this feedback in mind. Return only JSON.` },
      ],
    });

    const retryParsed = parseClaudeJSON(retryMessage.content[0]?.text, 'Stage 1B re-extraction');
    lastParsed = retryParsed;

    concept.title = retryParsed.title || concept.title;
    concept.theme = retryParsed.theme || concept.theme;
    concept.synopsis = retryParsed.synopsis || concept.synopsis;
    concept.characters = (retryParsed.characters || concept.characters).map(c => c.toLowerCase());
    concept.artStyle = DEFAULTS.artStyle;

    console.log(`  ↩️  Concept re-extracted — Title: ${concept.title}`);
  }
}
