// stages/stage-01-concept-select.mjs — Enrich selected concept → Telegram approval → spawn pipeline
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { openSync, constants as fsConstants } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getSupabase } from '../lib/supabase.mjs';
import { callClaude } from '../../shared/claude.mjs';
import {
  sendTelegramMessage, sendTelegramMessageWithButtons, waitForTelegramResponse,
  sendTelegramMessageWithCustomButtons, waitForTelegramMultiResponse,
} from '../lib/telegram.mjs';
import { DEFAULT_VIDEO_TYPE, getVideoConfig, DEFAULTS } from '../lib/video-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_REJECT_CYCLES = 3;

/**
 * Stage 1: Enrich a selected concept (generate outline, confirm characters, artStyle),
 * get Telegram approval, then spawn the full pipeline (stages 2-9) as a detached process.
 *
 * @param {string|number} conceptCardId - The ops_tasks card ID
 * @param {object} concept - The raw concept from Stage 0: { title, theme, characters, synopsis, targetDurationSeconds?, targetAge? }
 * @returns {{ taskId: string, conceptCardId, concept: object }}
 */
export async function runStage1(conceptCardId, concept) {
  console.log(`\n📖 Stage 1: Enriching concept — "${concept.title}"`);

  const sb = getSupabase();

  // ── Step 1: Enrich concept via Claude ──────────────────────────────
  let enriched = await enrichConcept(concept);

  // ── Step 2: Telegram approval (up to 3 rejection cycles) ──────────
  let lastEnriched = enriched;

  for (let cycle = 0; cycle <= MAX_REJECT_CYCLES; cycle++) {
    const outlinePreview = enriched.outline.length > 500
      ? enriched.outline.slice(0, 500) + '...'
      : enriched.outline;

    const approvalMsg = [
      `📖 Stage 1 — Enriched Concept Review`,
      ``,
      `Title: ${enriched.title}`,
      `Theme: ${enriched.theme}`,
      `Synopsis: ${enriched.synopsis}`,
      `Characters: ${enriched.characters.join(', ')}`,
      `Art Style: ${enriched.artStyle}`,
      `Video Type: ${enriched.videoType}`,
      ``,
      `Outline:`,
      outlinePreview,
    ].join('\n');

    const callbackPrefix = `s1_${cycle}`;
    const msgId = await sendTelegramMessageWithButtons(approvalMsg, callbackPrefix);
    const decision = await waitForTelegramResponse(msgId, callbackPrefix);

    if (decision.approved) {
      console.log(`  ✓ Enriched concept approved`);
      break;
    }

    // Rejected — re-enrich with feedback
    console.log(`  ✗ Concept rejected (cycle ${cycle + 1}/${MAX_REJECT_CYCLES}): ${decision.comment}`);
    if (cycle === MAX_REJECT_CYCLES) {
      throw new Error(`Stage 1: concept rejected ${MAX_REJECT_CYCLES + 1} times — aborting`);
    }

    enriched = await reEnrichConcept(concept, lastEnriched, decision.comment);
    lastEnriched = enriched;
    console.log(`  ↩️  Concept re-enriched`);
  }

  // ── Step 2B: Character list approval (add/remove) ──────────────────
  enriched.characters = await approveCharacterList(enriched.characters, 's1_chars');

  // ── Step 3: Create taskId + record ─────────────────────────────────
  const taskId = randomUUID();

  await sb.from('video_pipeline_runs').insert({
    task_id:      taskId,
    stage:        1,
    status:       'completed',
    started_at:   new Date().toISOString(),
    completed_at: new Date().toISOString(),
    pipeline_state: { concept: enriched },
  });

  console.log(`  Task ID: ${taskId}`);

  // ── Step 4: Persist enriched concept to ops_tasks card ─────────────
  await sb.from('ops_tasks')
    .update({ description: JSON.stringify(enriched) })
    .eq('id', conceptCardId);

  // ── Step 5: Spawn pipeline as detached process ─────────────────────
  const scriptsDir = join(__dirname, '..', 'scripts');
  const logPath = `/tmp/pipeline-${taskId.slice(0, 8)}.log`;
  const logFd = openSync(logPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND);

  const child = spawn(
    'node',
    [join(scriptsDir, 'launch-pipeline.mjs'), String(conceptCardId), '2', taskId],
    {
      cwd: join(__dirname, '..'),
      detached: true,
      stdio: ['ignore', logFd, logFd],
    }
  );
  child.unref();

  console.log(`  🚀 Pipeline spawned (PID: ${child.pid}, log: ${logPath})`);
  await sendTelegramMessage(`🚀 Pipeline launched for "${enriched.title}" (task: ${taskId.slice(0, 8)})`);

  console.log(`✅ Stage 1 complete`);
  return { taskId, conceptCardId, concept: enriched };
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

/**
 * Enrich a raw concept with a full outline, artStyle, videoType, and refined characters.
 */
async function enrichConcept(concept) {
  const videoType = concept.videoType || DEFAULT_VIDEO_TYPE;
  const config = getVideoConfig(videoType);

  const systemPrompt = `You are a story developer for @tinytamiltales, a Tamil children's animated YouTube channel (target age ${DEFAULTS.targetAge}).

Given a story concept, expand it into a production-ready concept with:
1. outline — A detailed scene-by-scene story outline with exactly ${config.sceneCount} scenes. Each line should be one visual moment: "Scene N: description of what happens". This outline will be used to generate the full script.
2. characters — Refined character list (lowercase names). Add narrator if not present. Remove characters that don't fit.
3. artStyle — ALWAYS use "${DEFAULTS.artStyle}". Do not change this.
4. videoType — ALWAYS use "${videoType}". Generate exactly ${config.sceneCount} scenes in the outline. Do not change this.

Return ONLY a JSON object. No markdown. No explanation.
{
  "title": "...",
  "theme": "...",
  "synopsis": "...",
  "characters": ["narrator", "character1", "character2"],
  "outline": "Scene 1: ...\\nScene 2: ...\\n...",
  "artStyle": "${DEFAULTS.artStyle}",
  "videoType": "${videoType}"
}`;

  const message = await callClaude({
    model: 'claude-sonnet-4-6',
    maxTokens: 2048,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Story concept:\nTitle: ${concept.title}\nTheme: ${concept.theme}\nCharacters: ${concept.characters.join(', ')}\nSynopsis: ${concept.synopsis}\nTarget duration: ${concept.targetDurationSeconds || config.totalDurationSeconds}s`,
    }],
  });

  let text = message.content[0]?.text?.trim() || '';
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(text);
    return {
      title: parsed.title || concept.title,
      theme: parsed.theme || concept.theme,
      synopsis: parsed.synopsis || concept.synopsis,
      characters: (parsed.characters || concept.characters).map(c => c.toLowerCase()),
      outline: parsed.outline || '',
      artStyle: DEFAULTS.artStyle,
      videoType,
    };
  } catch {
    throw new Error(`Stage 1: failed to parse enriched concept. Raw: ${text.slice(0, 200)}`);
  }
}

/**
 * Re-enrich a concept with reviewer feedback.
 */
async function reEnrichConcept(originalConcept, previousEnriched, feedback) {
  const videoType = previousEnriched.videoType || DEFAULT_VIDEO_TYPE;
  const config = getVideoConfig(videoType);

  const systemPrompt = `You are a story developer for @tinytamiltales, a Tamil children's animated YouTube channel (target age ${DEFAULTS.targetAge}).

Given a story concept and the reviewer's feedback on a previous enrichment, produce an updated enrichment.
The outline must have exactly ${config.sceneCount} scenes. videoType must be "${videoType}". artStyle must be "${DEFAULTS.artStyle}".

Return ONLY a JSON object. No markdown. No explanation.
{
  "title": "...",
  "theme": "...",
  "synopsis": "...",
  "characters": ["narrator", "character1", "character2"],
  "outline": "Scene 1: ...\\nScene 2: ...\\n...",
  "artStyle": "${DEFAULTS.artStyle}",
  "videoType": "${videoType}"
}`;

  const message = await callClaude({
    model: 'claude-sonnet-4-6',
    maxTokens: 2048,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Story concept:\nTitle: ${originalConcept.title}\nTheme: ${originalConcept.theme}\nCharacters: ${originalConcept.characters.join(', ')}\nSynopsis: ${originalConcept.synopsis}`,
      },
      {
        role: 'assistant',
        content: JSON.stringify(previousEnriched),
      },
      {
        role: 'user',
        content: `The reviewer rejected this enrichment. Feedback: "${feedback}". Re-enrich with this feedback in mind. Return only JSON.`,
      },
    ],
  });

  let text = message.content[0]?.text?.trim() || '';
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(text);
    return {
      title: parsed.title || previousEnriched.title,
      theme: parsed.theme || previousEnriched.theme,
      synopsis: parsed.synopsis || previousEnriched.synopsis,
      characters: (parsed.characters || previousEnriched.characters).map(c => c.toLowerCase()),
      outline: parsed.outline || previousEnriched.outline,
      artStyle: DEFAULTS.artStyle,
      videoType,
    };
  } catch {
    throw new Error(`Stage 1: failed to parse re-enriched concept. Raw: ${text.slice(0, 200)}`);
  }
}

/**
 * List all pending concept cards from ops_tasks (helper for manual workflows).
 */
export async function listPendingConceptCards() {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('ops_tasks')
    .select('id, title, description, created_at')
    .in('task_type', ['story_proposal', 'story_concept'])
    .eq('status', 'review')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`listPendingConceptCards failed: ${error.message}`);
  return data || [];
}
