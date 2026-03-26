// stages/stage-01b-story-intake.mjs — Takes a user-provided story/outline,
// extracts metadata (title, theme, characters, synopsis) via Claude,
// sends to Telegram for Darl's approval, and builds a concept object
// with the full outline for Stage 2.
import 'dotenv/config';
import { callClaude } from '../../shared/claude.mjs';
import {
  sendTelegramMessage, sendTelegramMessageWithButtons, waitForTelegramResponse,
  sendTelegramMessageWithCustomButtons, waitForTelegramMultiResponse,
} from '../lib/telegram.mjs';

/**
 * Stage 1B: Extract concept metadata from a user-provided story outline.
 * The full outline is preserved in concept.outline so Stage 2 uses it
 * instead of the generic story arc.
 *
 * @param {string} storyText - The full story/outline text from the user
 * @param {object} [opts]
 * @param {string} [opts.videoType] - 'short' or 'long' — passed through to concept
 * @returns {{ title, theme, synopsis, characters, outline, videoType? }}
 */
export async function extractConceptFromStory(storyText, { videoType } = {}) {
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

  let text = message.content[0]?.text?.trim() || '';
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed = JSON.parse(text);

  if (!parsed.title || !parsed.characters) {
    throw new Error('Stage 1B: Claude failed to extract title or characters from story');
  }

  const concept = {
    title: parsed.title,
    theme: parsed.theme || '',
    synopsis: parsed.synopsis || '',
    characters: parsed.characters.map(c => c.toLowerCase()),
    outline: storyText,
    artStyle: parsed.artStyle || '3D Pixar animation still',
    ...(videoType ? { videoType } : {}),
  };

  console.log(`  Title: ${concept.title}`);
  console.log(`  Theme: ${concept.theme}`);
  console.log(`  Art style: ${concept.artStyle}`);
  console.log(`  Characters: ${concept.characters.join(', ')}`);

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

    let retryText = retryMessage.content[0]?.text?.trim() || '';
    retryText = retryText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const retryParsed = JSON.parse(retryText);
    lastParsed = retryParsed;

    concept.title = retryParsed.title || concept.title;
    concept.theme = retryParsed.theme || concept.theme;
    concept.synopsis = retryParsed.synopsis || concept.synopsis;
    concept.characters = (retryParsed.characters || concept.characters).map(c => c.toLowerCase());
    concept.artStyle = retryParsed.artStyle || concept.artStyle;

    console.log(`  ↩️  Concept re-extracted — Title: ${concept.title}`);
  }
}

/**
 * Interactive character list approval via Telegram.
 * Loops until the user approves — allows adding/removing characters.
 *
 * @param {string[]} characters - current character list
 * @param {string} prefix - callback prefix for Telegram buttons
 * @returns {Promise<string[]>} - approved character list
 */
async function approveCharacterList(characters, prefix) {
  let charList = [...characters];
  let round = 0;

  while (true) {
    const charDisplay = charList.length > 0
      ? charList.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
      : '  (empty)';

    const msg = [
      `👤 Character List Review`,
      ``,
      charDisplay,
      ``,
      `Approve the list, or add/remove characters:`,
    ].join('\n');

    const callbackPrefix = `${prefix}_${round}`;
    const msgId = await sendTelegramMessageWithCustomButtons(msg, callbackPrefix, [
      { text: '✅ Approve', action: 'approve' },
      { text: '➕ Add', action: 'add' },
      { text: '➖ Remove', action: 'remove' },
    ]);

    const decision = await waitForTelegramMultiResponse(msgId, callbackPrefix, {
      needsFeedback: ['add', 'remove'],
    });

    if (decision.action === 'approve') {
      console.log(`  ✓ Character list approved: ${charList.join(', ')}`);
      return charList;
    }

    if (decision.action === 'add') {
      const name = decision.comment?.trim().toLowerCase();
      if (name && !charList.includes(name)) {
        charList.push(name);
        console.log(`  ➕ Added character: ${name}`);
        await sendTelegramMessage(`➕ Added "${name}" to character list`);
      } else if (name && charList.includes(name)) {
        await sendTelegramMessage(`⚠️ "${name}" already in the list`);
      }
    }

    if (decision.action === 'remove') {
      const input = decision.comment?.trim().toLowerCase();
      if (!input) {
        await sendTelegramMessage(`⚠️ No character specified to remove`);
      } else {
        // Try matching by name or by number
        const byNumber = parseInt(input, 10);
        let removed = null;
        if (!isNaN(byNumber) && byNumber >= 1 && byNumber <= charList.length) {
          removed = charList.splice(byNumber - 1, 1)[0];
        } else {
          const idx = charList.indexOf(input);
          if (idx !== -1) {
            removed = charList.splice(idx, 1)[0];
          }
        }
        if (removed) {
          console.log(`  ➖ Removed character: ${removed}`);
          await sendTelegramMessage(`➖ Removed "${removed}" from character list`);
        } else {
          await sendTelegramMessage(`⚠️ Character "${input}" not found in the list`);
        }
      }
    }

    round++;
  }
}
