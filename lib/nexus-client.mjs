// lib/nexus-client.mjs — NEXUS board via direct Supabase ops_tasks writes
import { getSupabase } from './supabase.mjs';
import { waitForTelegramResponse, PipelineAbortError } from './telegram.mjs';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Create a NEXUS card for human review.
 */
export async function createNexusCard({
  title,
  description = '',
  task_type = 'task',
  priority = 'medium',
  parent_id = null,
  content_url = null,
  stream = 'youtube',
}) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('ops_tasks')
    .insert({
      title,
      description,
      task_type,
      priority,
      parent_id: parent_id || null,
      content_url: content_url || null,
      stream,
      status: 'review',
      auto_created: true,
    })
    .select('id')
    .single();

  if (error) throw new Error(`createNexusCard failed: ${error.message}`);
  return data.id;
}

/**
 * Create the parent video card (shows progress timeline in NEXUS).
 */
export async function createVideoParentCard({ title, stream = 'youtube' }) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('ops_tasks')
    .insert({
      title,
      task_type: 'video_parent',
      stream,
      status: 'in_progress',
      auto_created: true,
    })
    .select('id')
    .single();

  if (error) throw new Error(`createVideoParentCard failed: ${error.message}`);
  return data.id;
}

/**
 * Create a NEXUS review card for a specific stage asset.
 */
export async function createNexusReviewCard({
  taskId,
  stage,
  assetUrl = null,
  promptUsed = null,
  description = '',
  task_type = 'stage_review',
  parentId = null,
}) {
  return createNexusCard({
    title: `Stage ${stage} Review — Video ${taskId?.slice(0, 8)}`,
    description: [
      description,
      assetUrl ? `Asset: ${assetUrl}` : '',
      promptUsed ? `Prompt: ${promptUsed}` : '',
    ].filter(Boolean).join('\n'),
    task_type,
    priority: 'medium',
    parent_id: parentId,
    content_url: assetUrl,
    stream: 'youtube',
  });
}

/**
 * Wait for a human decision via Telegram (long-poll) + NEXUS (periodic check).
 * Telegram is primary (instant via long-poll). NEXUS is checked every ~2 minutes as backup.
 *
 * @param {string|number} cardId - NEXUS card ID
 * @param {object} [opts]
 * @param {number} [opts.telegramMessageId] - Telegram message ID
 * @param {string} [opts.callbackPrefix] - Callback prefix for button matching
 * @param {number} [opts.timeoutMs=86400000] - Timeout (default 24h)
 */
export async function awaitNexusDecision(cardId, { telegramMessageId = null, callbackPrefix = '', timeoutMs = 86400000 } = {}) {
  const sb = getSupabase();
  const hasTelegram = !!telegramMessageId;

  console.log(`  Awaiting decision on card ${cardId}${hasTelegram ? ` + Telegram msg ${telegramMessageId} (prefix: ${callbackPrefix})` : ''}`);

  if (hasTelegram && callbackPrefix) {
    // Use long-polling Telegram as primary — blocks efficiently
    // Spawn a background NEXUS check that runs every 2 minutes
    const nexusAbort = { aborted: false };
    const nexusChecker = (async () => {
      while (!nexusAbort.aborted) {
        await sleep(120000); // check every 2 min
        if (nexusAbort.aborted) return null;
        try {
          const result = await checkNexusCard(sb, cardId);
          if (result) return result;
        } catch { /* ignore */ }
      }
      return null;
    })();

    try {
      // Race: Telegram long-poll vs NEXUS periodic check
      const tgResult = await Promise.race([
        waitForTelegramResponse(telegramMessageId, callbackPrefix, timeoutMs),
        nexusChecker,
      ]);

      nexusAbort.aborted = true;

      if (tgResult) {
        // Sync to NEXUS for record-keeping
        if (tgResult.approved) {
          await sb.from('ops_tasks').update({ status: 'done' }).eq('id', cardId);
        } else {
          await addNexusComment(cardId, `[via Telegram] ${tgResult.comment}`, 'request_changes');
        }
        return { ...tgResult, channel: 'telegram' };
      }
    } catch (err) {
      nexusAbort.aborted = true;
      if (err instanceof PipelineAbortError) throw err;
      throw err;
    }
  }

  // Fallback: NEXUS-only polling (no Telegram)
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await checkNexusCard(sb, cardId);
    if (result) return result;
    await sleep(30000);
  }

  throw new Error(`Card ${cardId} timed out after ${timeoutMs}ms`);
}

/**
 * Check NEXUS card status. Returns result if decided, null if still pending.
 */
async function checkNexusCard(sb, cardId) {
  const { data, error } = await sb
    .from('ops_tasks')
    .select('status, comments')
    .eq('id', cardId)
    .single();

  if (error) return null;

  if (data?.status === 'done') {
    return { approved: true, comment: null, channel: 'nexus' };
  }

  const comments = Array.isArray(data?.comments) ? data.comments : [];
  const changeReq = [...comments].reverse().find(c => c?.type === 'request_changes');
  if (changeReq) {
    return { approved: false, comment: changeReq.text, channel: 'nexus' };
  }

  if (data?.status === 'cancelled') {
    return { approved: false, comment: 'Card cancelled in NEXUS', channel: 'nexus' };
  }

  return null;
}

/**
 * Add a system comment to a NEXUS card.
 */
export async function addNexusComment(cardId, text, type = 'system') {
  const sb = getSupabase();
  const comment = {
    author: 'friday',
    type,
    text,
    timestamp: new Date().toISOString(),
  };

  const { data: card } = await sb
    .from('ops_tasks')
    .select('comments')
    .eq('id', cardId)
    .single();

  const comments = Array.isArray(card?.comments) ? card.comments : [];
  comments.push(comment);

  await sb
    .from('ops_tasks')
    .update({ comments })
    .eq('id', cardId);
}
