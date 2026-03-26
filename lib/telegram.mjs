// lib/telegram.mjs — Telegram Bot API functions
// Single bot: notifications, media, buttons + long-poll responses (TELEGRAM_APPROVAL_BOT_TOKEN)
import 'dotenv/config';
import { promises as fs } from 'fs';
import { basename } from 'path';
import { getSupabase } from './supabase.mjs';

export const TELEGRAM_CHAT_ID = -5291269606;
let _approvalLastUpdateId = 0;

function getBotToken() {
  return process.env.TELEGRAM_APPROVAL_BOT_TOKEN;
}

// ── Friday's bot: send-only functions ──────────────────────────────────

export async function sendTelegramMessage(message) {
  const botToken = getBotToken();
  if (!botToken) {
    console.warn('  TELEGRAM_APPROVAL_BOT_TOKEN not set — skipping Telegram notification');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
    const result = await res.json();
    if (result.ok) console.log('  Telegram message sent');
    else console.warn(`  Telegram failed: ${result.description}`);
  } catch (err) {
    console.warn(`  Telegram error: ${err.message}`);
  }
}

export async function sendTelegramPhoto({ filePath, caption = '' }) {
  const botToken = getBotToken();
  if (!botToken) {
    console.warn('  TELEGRAM_APPROVAL_BOT_TOKEN not set — skipping Telegram photo');
    return;
  }
  try {
    const fileBuffer = await fs.readFile(filePath);
    const fileName = basename(filePath);
    const blob = new Blob([fileBuffer], { type: 'image/png' });

    const formData = new FormData();
    formData.append('chat_id', String(TELEGRAM_CHAT_ID));
    formData.append('photo', blob, fileName);
    if (caption) formData.append('caption', caption);

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      body: formData,
    });
    const result = await res.json();
    if (result.ok) console.log(`  Telegram photo sent: ${fileName}`);
    else console.warn(`  Telegram photo failed: ${result.description}`);
  } catch (err) {
    console.warn(`  Telegram photo error: ${err.message}`);
  }
}

export async function sendTelegramVideo({ filePath, caption = '' }) {
  const botToken = getBotToken();
  if (!botToken) {
    console.warn('  TELEGRAM_APPROVAL_BOT_TOKEN not set — skipping Telegram video');
    return;
  }
  try {
    const fileBuffer = await fs.readFile(filePath);
    const fileName = basename(filePath);
    const blob = new Blob([fileBuffer], { type: 'video/mp4' });

    const formData = new FormData();
    formData.append('chat_id', String(TELEGRAM_CHAT_ID));
    formData.append('video', blob, fileName);
    if (caption) formData.append('caption', caption);

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
      method: 'POST',
      body: formData,
    });
    const result = await res.json();
    if (result.ok) console.log(`  Telegram video sent: ${fileName}`);
    else console.warn(`  Telegram video failed: ${result.description}`);
  } catch (err) {
    console.warn(`  Telegram video error: ${err.message}`);
  }
}

export async function sendTelegramAudio({ filePath, caption = '' }) {
  const botToken = getBotToken();
  if (!botToken) {
    console.warn('  TELEGRAM_APPROVAL_BOT_TOKEN not set — skipping Telegram audio');
    return;
  }
  try {
    const fileBuffer = await fs.readFile(filePath);
    const fileName = basename(filePath);
    const blob = new Blob([fileBuffer], { type: 'audio/mpeg' });

    const formData = new FormData();
    formData.append('chat_id', String(TELEGRAM_CHAT_ID));
    formData.append('audio', blob, fileName);
    if (caption) formData.append('caption', caption);

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendAudio`, {
      method: 'POST',
      body: formData,
    });
    const result = await res.json();
    if (result.ok) console.log(`  Telegram audio sent: ${fileName}`);
    else console.warn(`  Telegram audio failed: ${result.description}`);
  } catch (err) {
    console.warn(`  Telegram audio error: ${err.message}`);
  }
}

// ── Approval bot: buttons + long-poll ──────────────────────────────────

/**
 * Send a media file (photo, video, or audio) via the APPROVAL bot.
 * Use this when the media must appear from the same bot as approve/reject buttons.
 *
 * @param {object} opts
 * @param {string} opts.filePath - path to media file
 * @param {'photo'|'video'|'audio'} opts.type - media type
 * @param {string} [opts.caption] - optional caption
 * @returns {Promise<number|null>} message_id or null
 */
export async function sendApprovalBotMedia({ filePath, type = 'photo', caption = '' }) {
  const botToken = getBotToken();
  if (!botToken) {
    console.warn('  Approval bot token not set — skipping media');
    return null;
  }

  const mimeTypes = { photo: 'image/png', video: 'video/mp4', audio: 'audio/mpeg' };
  const endpoints = { photo: 'sendPhoto', video: 'sendVideo', audio: 'sendAudio' };

  try {
    const fileBuffer = await fs.readFile(filePath);
    const fileName = basename(filePath);
    const blob = new Blob([fileBuffer], { type: mimeTypes[type] || mimeTypes.photo });

    const formData = new FormData();
    formData.append('chat_id', String(TELEGRAM_CHAT_ID));
    formData.append(type, blob, fileName);
    if (caption) formData.append('caption', caption);

    const res = await fetch(`https://api.telegram.org/bot${botToken}/${endpoints[type] || endpoints.photo}`, {
      method: 'POST',
      body: formData,
    });
    const result = await res.json();
    if (result.ok) {
      console.log(`  Approval bot ${type} sent: ${fileName}`);
      return result.result.message_id;
    }
    console.warn(`  Approval bot ${type} failed: ${result.description}`);
    return null;
  } catch (err) {
    console.warn(`  Approval bot ${type} error: ${err.message}`);
    return null;
  }
}

/**
 * Send a message with inline approve/reject buttons via the APPROVAL bot.
 * callback_data is prefixed with `callbackPrefix` to avoid cross-scene confusion.
 *
 * @param {string} message
 * @param {string} callbackPrefix - e.g. "s2_3" for stage 2 scene 3
 * @returns {Promise<number|null>} message_id or null
 */
export async function sendTelegramMessageWithButtons(message, callbackPrefix = '') {
  const botToken = getBotToken();
  if (!botToken) {
    console.warn('  Approval bot token not set');
    return null;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        reply_markup: {
          inline_keyboard: [[
            { text: '\u2705 Approve', callback_data: `${callbackPrefix}:approve` },
            { text: '\u274c Reject', callback_data: `${callbackPrefix}:reject` },
          ]],
        },
      }),
    });
    const result = await res.json();
    if (result.ok) {
      console.log(`  Approval bot sent with buttons (id: ${result.result.message_id}, prefix: ${callbackPrefix})`);
      return result.result.message_id;
    }
    console.warn(`  Approval bot failed: ${result.description}`);
    return null;
  } catch (err) {
    console.warn(`  Approval bot error: ${err.message}`);
    return null;
  }
}

/**
 * Flush stale updates from the approval bot so old button presses
 * from previous runs don't auto-approve anything.
 */
export async function flushApprovalUpdates() {
  const botToken = getBotToken();
  if (!botToken) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getUpdates?offset=-1&timeout=0`
    );
    const data = await res.json();
    if (data.ok && data.result?.length) {
      _approvalLastUpdateId = data.result[data.result.length - 1].update_id;
      console.log(`  Flushed stale approval updates (last_id: ${_approvalLastUpdateId})`);
    }
  } catch {
    // Non-critical — proceed without flush
  }
}

/**
 * Send a feedback prompt via the approval bot (after reject).
 */
async function sendApprovalBotMessage(message) {
  const botToken = getBotToken();
  if (!botToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
  } catch { /* best effort */ }
}

/**
 * Long-poll the approval bot for a response matching `callbackPrefix`.
 * Blocks efficiently — each getUpdates call waits up to 30s for an update.
 *
 * Flow:
 *   1. Button press `{prefix}:approve` → { approved: true, comment: null }
 *   2. Button press `{prefix}:reject` → prompts for feedback, waits for text
 *   3. Text "stop pipeline" → throws PipelineAbortError
 *   4. Text after reject → { approved: false, comment: text }
 *   5. Text approve words → { approved: true, comment: null }
 *
 * Also checks Supabase `pipeline_abort` flag every cycle.
 *
 * @param {number} messageId - Telegram message ID (for reply matching)
 * @param {string} callbackPrefix - e.g. "s2_3"
 * @param {number} [timeoutMs=86400000] - Overall timeout (default 24h)
 * @returns {Promise<{approved: boolean, comment: string|null}>}
 */
export async function waitForTelegramResponse(messageId, callbackPrefix, timeoutMs = 86400000) {
  const botToken = getBotToken();
  if (!botToken) throw new Error('Approval bot token not set');

  const start = Date.now();
  let waitingForFeedback = false;
  const LONG_POLL_TIMEOUT = 30; // seconds — Telegram blocks up to this long

  console.log(`  Waiting for response (prefix: ${callbackPrefix}, msg: ${messageId})...`);

  while (Date.now() - start < timeoutMs) {
    // Check pipeline_abort flag in Supabase
    try {
      const sb = getSupabase();
      const { data } = await sb
        .from('pipeline_settings')
        .select('value')
        .eq('key', 'pipeline_abort')
        .single();
      if (data?.value === true || data?.value === 'true') {
        // Clear the flag
        await sb.from('pipeline_settings').upsert({ key: 'pipeline_abort', value: false }, { onConflict: 'key' });
        throw new PipelineAbortError('Pipeline stopped via Supabase flag');
      }
    } catch (err) {
      if (err instanceof PipelineAbortError) throw err;
      // getSetting might fail if key doesn't exist yet — ignore
    }

    // Long-poll for updates (blocks up to LONG_POLL_TIMEOUT seconds)
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?offset=${_approvalLastUpdateId + 1}&timeout=${LONG_POLL_TIMEOUT}&allowed_updates=["message","callback_query"]`
      );
      const data = await res.json();

      if (!data.ok || !data.result?.length) continue;

      for (const update of data.result) {
        _approvalLastUpdateId = update.update_id;

        // Handle inline button callback
        if (update.callback_query) {
          const cb = update.callback_query;

          // Acknowledge immediately
          await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cb.id }),
          }).catch(() => {});

          // Only process callbacks matching our prefix
          if (!cb.data?.startsWith(callbackPrefix + ':')) continue;

          const action = cb.data.slice(callbackPrefix.length + 1);

          if (action === 'approve') {
            return { approved: true, comment: null };
          }
          if (action === 'reject') {
            waitingForFeedback = true;
            await sendApprovalBotMessage('Type your feedback (or prefix with "text:" to replace dialogue):');
            // Don't return — continue polling for the text message
          }
        }

        // Handle text message
        if (update.message?.chat?.id === TELEGRAM_CHAT_ID && update.message?.text) {
          const text = update.message.text.trim();
          const lower = text.toLowerCase();

          // "stop pipeline" command — always handled regardless of state
          if (lower === 'stop pipeline' || lower === 'stop' || lower === 'abort') {
            // Set flag in Supabase for other processes to see
            try {
              const sb = getSupabase();
              await sb.from('pipeline_settings').upsert(
                { key: 'pipeline_abort', value: true },
                { onConflict: 'key' }
              );
            } catch { /* best effort */ }
            await sendApprovalBotMessage('Pipeline stop requested. Aborting after current scene...');
            throw new PipelineAbortError('Pipeline stopped via Telegram command');
          }

          // Text message as approval
          if (!waitingForFeedback) {
            if (['ok', 'okay', 'approve', 'approved', 'yes', 'good', 'fine', 'lgtm'].includes(lower)) {
              return { approved: true, comment: null };
            }
          }

          // Text after reject button = feedback
          if (waitingForFeedback) {
            waitingForFeedback = false;
            if (['ok', 'okay', 'approve', 'approved', 'yes', 'good', 'fine', 'lgtm'].includes(lower)) {
              return { approved: true, comment: null };
            }
            return { approved: false, comment: text };
          }
        }
      }
    } catch (err) {
      if (err instanceof PipelineAbortError) throw err;
      // Network error — wait briefly and retry
      console.warn(`  Approval poll error: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  throw new Error(`Approval timed out after ${timeoutMs}ms`);
}

/**
 * Custom error for pipeline abort — caught by pipeline runner for graceful exit.
 */
export class PipelineAbortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PipelineAbortError';
  }
}

/**
 * Send a message with custom inline buttons via the APPROVAL bot.
 * Unlike sendTelegramMessageWithButtons (hardcoded approve/reject),
 * this accepts an arbitrary array of buttons.
 *
 * @param {string} message
 * @param {string} callbackPrefix - e.g. "s3_exist_Luna"
 * @param {Array<{text: string, action: string}>} buttons - e.g. [{text: '✅ Approve', action: 'approve'}]
 * @returns {Promise<number|null>} message_id or null
 */
export async function sendTelegramMessageWithCustomButtons(message, callbackPrefix, buttons) {
  const botToken = getBotToken();
  if (!botToken) {
    console.warn('  Approval bot token not set');
    return null;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        reply_markup: {
          inline_keyboard: [buttons.map(b => ({
            text: b.text,
            callback_data: `${callbackPrefix}:${b.action}`,
          }))],
        },
      }),
    });
    const result = await res.json();
    if (result.ok) {
      console.log(`  Approval bot sent with ${buttons.length} buttons (id: ${result.result.message_id}, prefix: ${callbackPrefix})`);
      return result.result.message_id;
    }
    console.warn(`  Approval bot failed: ${result.description}`);
    return null;
  } catch (err) {
    console.warn(`  Approval bot error: ${err.message}`);
    return null;
  }
}

/**
 * Long-poll the approval bot for a response matching `callbackPrefix`,
 * supporting multiple custom actions (not just approve/reject).
 *
 * - Actions that need feedback (reject, customize, etc.) prompt for text.
 * - 'approve' returns immediately with no comment.
 *
 * @param {number} messageId - Telegram message ID
 * @param {string} callbackPrefix - e.g. "s3_exist_Luna"
 * @param {Object} opts
 * @param {string[]} [opts.needsFeedback=['reject', 'customize']] - actions that prompt for text
 * @param {number} [opts.timeoutMs=86400000]
 * @returns {Promise<{action: string, comment: string|null}>}
 */
export async function waitForTelegramMultiResponse(messageId, callbackPrefix, opts = {}) {
  const { needsFeedback = ['reject', 'customize'], timeoutMs = 86400000 } = opts;
  const feedbackActions = new Set(needsFeedback);

  const botToken = getBotToken();
  if (!botToken) throw new Error('Approval bot token not set');

  const start = Date.now();
  let waitingForFeedback = false;
  let matchedAction = null;
  const LONG_POLL_TIMEOUT = 30;

  console.log(`  Waiting for multi-response (prefix: ${callbackPrefix}, msg: ${messageId})...`);

  while (Date.now() - start < timeoutMs) {
    // Check pipeline_abort flag
    try {
      const sb = getSupabase();
      const { data } = await sb
        .from('pipeline_settings')
        .select('value')
        .eq('key', 'pipeline_abort')
        .single();
      if (data?.value === true || data?.value === 'true') {
        await sb.from('pipeline_settings').upsert({ key: 'pipeline_abort', value: false }, { onConflict: 'key' });
        throw new PipelineAbortError('Pipeline stopped via Supabase flag');
      }
    } catch (err) {
      if (err instanceof PipelineAbortError) throw err;
    }

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?offset=${_approvalLastUpdateId + 1}&timeout=${LONG_POLL_TIMEOUT}&allowed_updates=["message","callback_query"]`
      );
      const data = await res.json();
      if (!data.ok || !data.result?.length) continue;

      for (const update of data.result) {
        _approvalLastUpdateId = update.update_id;

        // Handle inline button callback
        if (update.callback_query) {
          const cb = update.callback_query;
          await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cb.id }),
          }).catch(() => {});

          if (!cb.data?.startsWith(callbackPrefix + ':')) continue;
          const action = cb.data.slice(callbackPrefix.length + 1);

          if (feedbackActions.has(action)) {
            waitingForFeedback = true;
            matchedAction = action;
            await sendApprovalBotMessage(`Type your feedback for "${action}":`);
          } else {
            return { action, comment: null };
          }
        }

        // Handle text message
        if (update.message?.chat?.id === TELEGRAM_CHAT_ID && update.message?.text) {
          const text = update.message.text.trim();
          const lower = text.toLowerCase();

          if (lower === 'stop pipeline' || lower === 'stop' || lower === 'abort') {
            try {
              const sb = getSupabase();
              await sb.from('pipeline_settings').upsert(
                { key: 'pipeline_abort', value: true },
                { onConflict: 'key' }
              );
            } catch { /* best effort */ }
            await sendApprovalBotMessage('Pipeline stop requested. Aborting after current scene...');
            throw new PipelineAbortError('Pipeline stopped via Telegram command');
          }

          if (!waitingForFeedback) {
            if (['ok', 'okay', 'approve', 'approved', 'yes', 'good', 'fine', 'lgtm'].includes(lower)) {
              return { action: 'approve', comment: null };
            }
          }

          if (waitingForFeedback) {
            waitingForFeedback = false;
            if (['ok', 'okay', 'approve', 'approved', 'yes', 'good', 'fine', 'lgtm'].includes(lower)) {
              return { action: 'approve', comment: null };
            }
            return { action: matchedAction, comment: text };
          }
        }
      }
    } catch (err) {
      if (err instanceof PipelineAbortError) throw err;
      console.warn(`  Approval poll error: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  throw new Error(`Approval timed out after ${timeoutMs}ms`);
}
