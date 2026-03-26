// stages/stage-00-research.mjs — Weekly research: trends → story concepts → Telegram selection → Stage 1
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';
import { sendTelegramMessage, sendTelegramMessageWithCustomButtons, waitForTelegramMultiResponse } from '../lib/telegram.mjs';
import { withRetry } from '../lib/retry.mjs';
import { callClaude } from '../../shared/claude.mjs';
import { createNexusCard } from '../lib/nexus-client.mjs';
import { runStage1 } from './stage-01-concept-select.mjs';
import { DEFAULT_VIDEO_TYPE, getVideoConfig } from '../lib/video-config.mjs';

const EMOJI_NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

/**
 * Stage 0: Weekly research — generate story concepts, save to NEXUS, send to Telegram for selection.
 *
 * @param {string} [videoType] - 'short' or 'long'. Defaults to DEFAULT_VIDEO_TYPE from video-config.
 */
export async function runStage0(videoType) {
  const vType = videoType || DEFAULT_VIDEO_TYPE;
  console.log(`🔍 Stage 0: Weekly Research — generating story concepts (${vType})`);

  const sb = getSupabase();
  let round = 0;
  let concepts = null;
  let cardIds = [];

  // State machine: 'generate' → 'select' → 'review' → (back to select/generate, or proceed)
  let phase = 'generate';
  let selectedIndex = -1;
  let selectedConcept = null;
  let selectedCardId = null;

  while (true) {
    // ── GENERATE phase: create new concepts ───────────────────────────
    if (phase === 'generate') {
      concepts = await withRetry(
        () => generateStoryConcepts(vType),
        { maxRetries: 3, baseDelayMs: 10000, stage: 0 }
      );

      if (!concepts || concepts.length === 0) {
        console.warn('⚠️  No concepts generated — aborting');
        return [];
      }

      // Save to ops_tasks
      cardIds = [];
      for (let i = 0; i < concepts.length; i++) {
        const cardId = await createNexusCard({
          title: `Story Concept ${i + 1}: ${concepts[i].title}`,
          description: JSON.stringify(concepts[i]),
          task_type: 'story_concept',
          priority: 'medium',
          stream: 'youtube',
        });
        cardIds.push(cardId);
        console.log(`  Saved concept ${i + 1} to NEXUS (card: ${cardId}): ${concepts[i].title}`);
      }

      phase = 'select';
    }

    // ── SELECT phase: pick a concept or regenerate ────────────────────
    if (phase === 'select') {
      const summaryLines = concepts.map((c, i) => [
        `${EMOJI_NUMBERS[i]} ${c.title}`,
        `   Theme: ${c.theme}`,
        `   Characters: ${c.characters.join(', ')}`,
        `   ${c.synopsis}`,
      ].join('\n'));

      const summaryMsg = [
        `🔍 Stage 0: ${concepts.length} Story Concepts Ready`,
        ``,
        ...summaryLines,
        ``,
        `Pick a concept or regenerate:`,
      ].join('\n');

      const buttons = [
        ...concepts.map((c, i) => ({
          text: `${EMOJI_NUMBERS[i]} ${c.title.slice(0, 25)}`,
          action: `pick_${i}`,
        })),
        { text: '🔄 Regenerate', action: 'regenerate' },
      ];

      const msgId = await sendTelegramMessageWithCustomButtons(summaryMsg, `s0_sel_${round}`, buttons);
      const decision = await waitForTelegramMultiResponse(msgId, `s0_sel_${round}`, { needsFeedback: [] });
      round++;

      if (decision.action === 'regenerate') {
        console.log('  🔄 Regenerating concepts...');
        for (const cardId of cardIds) {
          await sb.from('ops_tasks').update({ status: 'cancelled' }).eq('id', cardId);
        }
        phase = 'generate';
        continue;
      }

      const pickMatch = decision.action.match(/^pick_(\d+)$/);
      if (!pickMatch) throw new Error(`Stage 0: unexpected action: ${decision.action}`);

      selectedIndex = parseInt(pickMatch[1], 10);
      selectedConcept = concepts[selectedIndex];
      selectedCardId = cardIds[selectedIndex];
      console.log(`  ✓ Selected: ${selectedConcept.title}`);

      phase = 'review';
      continue;
    }

    // ── REVIEW phase: approve / edit / back ───────────────────────────
    if (phase === 'review') {
      const detailMsg = [
        `📖 Selected Concept: ${selectedConcept.title}`,
        ``,
        `Theme: ${selectedConcept.theme}`,
        `Characters: ${selectedConcept.characters.join(', ')}`,
        `Synopsis: ${selectedConcept.synopsis}`,
        `Video Type: ${selectedConcept.videoType || vType}`,
        ``,
        `Approve, edit, or go back:`,
      ].join('\n');

      const msgId = await sendTelegramMessageWithCustomButtons(detailMsg, `s0_rev_${round}`, [
        { text: '✅ Approve', action: 'approve' },
        { text: '✏️ Edit', action: 'edit' },
        { text: '↩️ Back', action: 'back' },
      ]);

      const decision = await waitForTelegramMultiResponse(msgId, `s0_rev_${round}`, {
        needsFeedback: ['edit'],
      });
      round++;

      if (decision.action === 'back') {
        phase = 'select';
        continue;
      }

      if (decision.action === 'edit' && decision.comment) {
        try {
          const editMsg = await callClaude({
            model: 'claude-sonnet-4-6',
            maxTokens: 512,
            system: 'You are a creative director for @tinytamiltales. Given a story concept and reviewer feedback, return an updated concept. Return ONLY a JSON object with: title, theme, characters (array), synopsis. No markdown.',
            messages: [
              { role: 'user', content: JSON.stringify(selectedConcept) },
              { role: 'assistant', content: JSON.stringify(selectedConcept) },
              { role: 'user', content: `Modify this concept based on feedback: "${decision.comment}". Return only JSON.` },
            ],
          });
          let editText = editMsg.content[0]?.text?.trim() || '';
          editText = editText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
          const edited = JSON.parse(editText);
          selectedConcept = {
            ...selectedConcept,
            title: edited.title || selectedConcept.title,
            theme: edited.theme || selectedConcept.theme,
            characters: edited.characters || selectedConcept.characters,
            synopsis: edited.synopsis || selectedConcept.synopsis,
          };
          await sb.from('ops_tasks')
            .update({ title: `Story Concept: ${selectedConcept.title}`, description: JSON.stringify(selectedConcept) })
            .eq('id', selectedCardId);
          console.log(`  ✏️ Concept edited: ${selectedConcept.title}`);
          await sendTelegramMessage(`✏️ Concept updated: "${selectedConcept.title}"`);
        } catch (err) {
          console.warn(`  ⚠️ Edit failed: ${err.message}`);
          await sendTelegramMessage(`⚠️ Edit failed: ${err.message}. Try again.`);
        }
        // Stay in review phase — show updated concept
        continue;
      }

      if (decision.action === 'approve') {
        // Mark selected as done, others as cancelled
        await sb.from('ops_tasks').update({ status: 'done' }).eq('id', selectedCardId);
        for (let i = 0; i < cardIds.length; i++) {
          if (i !== selectedIndex) {
            await sb.from('ops_tasks').update({ status: 'cancelled' }).eq('id', cardIds[i]);
          }
        }

        await sendTelegramMessage(`✅ Concept approved: "${selectedConcept.title}" — starting enrichment...`);

        // Hand off to Stage 1
        const result = await runStage1(selectedCardId, selectedConcept);
        console.log(`✅ Stage 0 complete — concept selected and pipeline launched`);
        return result;
      }
    }
  }
}

/**
 * Generate story concepts using Claude (if API key available) or hardcoded samples.
 */
async function generateStoryConcepts(videoType = DEFAULT_VIDEO_TYPE) {
  const config = getVideoConfig(videoType);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('No ANTHROPIC_API_KEY — using sample story concepts');
    return getSampleConcepts(videoType);
  }

  try {
    const trendSummary = await fetchTrendSummary();

    const message = await callClaude({
      model: 'claude-sonnet-4-6',
      maxTokens: 1024,
      system: `You are a creative director for @tinytamiltales, a Tamil children's animated YouTube channel (3D Pixar style, target age 3-7).

Your job is to generate DIVERSE story concepts. Mix these story types:
- Tamil village life (kids playing, festivals, markets, family moments)
- Magic and fantasy (enchanted objects, wishes, dream worlds, tiny guardians)
- Animal adventures (talking animals, forest friends, ocean creatures)
- Everyday kid problems (sharing, first day at school, making friends, being brave)
- Tamil culture and tradition (kolam, harvest, temple festivals, grandma's stories)
- Elder wisdom (grandpa/grandma teaching through stories, village elders)

IMPORTANT: Do NOT make every concept about animals. At least 2 out of 5 concepts should feature human children or elders as main characters. Include a mix of character types: kids, animals, elders, magical beings.

Return ONLY valid JSON — no markdown, no explanation.`,
      messages: [{
        role: 'user',
        content: `Generate 3-5 story concepts for Tamil animated kids stories.

Inspiration keywords: ${trendSummary}

Each concept must have a different story type (don't repeat animal-only stories).

Return a JSON array:
[{
  "title": "English title",
  "theme": "friendship/nature/bravery/honesty/etc",
  "characters": ["Character1", "Character2"],
  "synopsis": "2-3 sentence story synopsis in English",
  "targetDurationSeconds": ${config.totalDurationSeconds},
  "targetAge": "3-7",
  "videoType": "${videoType}"
}]`,
      }],
    });

    const raw = message.content[0]?.text?.trim();
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(text);
  } catch (err) {
    console.error('Claude concept generation failed:', err.message);
    return getSampleConcepts(videoType);
  }
}

async function fetchTrendSummary() {
  return 'friendship, sharing, village life, magic, dreams, wishes, first day at school, grandma stories, kolam, harvest festival, bravery, helping others, Tamil culture, talking animals, forest adventures, enchanted objects, family, kindness, curiosity';
}

function getSampleConcepts(videoType = DEFAULT_VIDEO_TYPE) {
  const config = getVideoConfig(videoType);
  return [
    {
      title: 'The Brave Little Elephant',
      theme: 'bravery',
      characters: ['NARRATOR', 'Velu', 'Gaja the Elephant'],
      synopsis: 'A small elephant named Gaja is afraid of water. Velu helps Gaja overcome his fear by showing him how fun swimming can be.',
      targetDurationSeconds: config.totalDurationSeconds,
      targetAge: '3-7',
      videoType,
    },
    {
      title: 'The Honey Bee and the Flower',
      theme: 'friendship',
      characters: ['NARRATOR', 'Bee', 'Sunflower'],
      synopsis: 'A little bee and a sunflower become best friends. They learn that working together makes the garden beautiful for everyone.',
      targetDurationSeconds: config.totalDurationSeconds,
      targetAge: '3-7',
      videoType,
    },
    {
      title: 'Sharing is Caring',
      theme: 'sharing',
      characters: ['NARRATOR', 'Velu', 'Meena'],
      synopsis: 'Velu has a big mango and does not want to share. When he sees Meena is hungry, he learns the joy of sharing.',
      targetDurationSeconds: config.totalDurationSeconds,
      targetAge: '3-7',
      videoType,
    },
  ];
}

// Run directly if called as script: node stage-00-research.mjs [short|long]
if (import.meta.url === `file://${process.argv[1]}`) {
  runStage0(process.argv[2] || undefined).catch(console.error);
}
