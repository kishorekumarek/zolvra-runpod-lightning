// scripts/title-approval.mjs — Telegram title approval gate for Jungle Jambu episodes
//
// Sends a proposed title to Darl via Telegram, waits for reply (up to 24h).
// ✅ or "approve" → approves as-is. Any other text → treated as corrected title.
// Updates video_queue.title in Supabase and confirms back to Darl.
//
// Export: async function awaitTitleApproval(taskId, epNumber, proposedTitle)
// CLI:    node scripts/title-approval.mjs <task_id> <ep_number> <proposed_title>

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { getSupabase } from '../lib/supabase.mjs';

const DARL_CHAT_ID = 7879469053;
const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const POLL_TIMEOUT_SECONDS = 300; // 5 min per long-poll

function readBotToken() {
  const config = JSON.parse(readFileSync('/Users/friday/.openclaw/openclaw.json', 'utf8'));
  const token = config?.channels?.telegram?.botToken;
  if (!token) throw new Error('Bot token not found at channels.telegram.botToken in openclaw.json');
  return token;
}

async function sendTgMessage(botToken, chatId, text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram sendMessage failed: ${data.description}`);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

async function getUpdates(botToken, offset, timeout = POLL_TIMEOUT_SECONDS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeout + 10) * 1000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset, timeout, allowed_updates: ['message'] }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram getUpdates failed: ${data.description}`);
    return data.result || [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a proposed episode title to Darl via Telegram and wait for approval.
 *
 * @param {string} taskId        - Pipeline task UUID (used to update video_queue)
 * @param {number} epNumber      - Episode number for display
 * @param {string} proposedTitle - Proposed title (typically Tamil script from Stage 2)
 * @returns {Promise<string>}    - Approved or corrected title
 */
export async function awaitTitleApproval(taskId, epNumber, proposedTitle) {
  const botToken = readBotToken();
  const sb = getSupabase();

  console.log(`📝 Sending EP${epNumber} title proposal to Darl...`);

  // Drain pending updates to get a clean offset (avoids processing old messages)
  let offset = 0;
  try {
    const pending = await getUpdates(botToken, 0, 0);
    if (pending.length > 0) {
      offset = pending[pending.length - 1].update_id + 1;
      console.log(`  ↩️  Skipped ${pending.length} pending Telegram update(s)`);
    }
  } catch (err) {
    console.warn(`  ⚠️  Could not drain pending updates: ${err.message}`);
  }

  // Send proposal to Darl
  const msg = `📝 EP${epNumber} title proposal:\n\n${proposedTitle}\n\nReply with corrected title or send ✅ to approve`;
  await sendTgMessage(botToken, DARL_CHAT_ID, msg);
  console.log(`  ✓ Proposal sent. Waiting for reply (up to 24h)...`);

  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let updates = [];
    try {
      // Use remaining time if less than one full poll window
      const remainingSecs = Math.floor((deadline - Date.now()) / 1000);
      const pollTimeout = Math.min(POLL_TIMEOUT_SECONDS, remainingSecs);
      if (pollTimeout <= 0) break;

      updates = await getUpdates(botToken, offset, pollTimeout);
    } catch (err) {
      console.warn(`  ⚠️  Telegram poll error: ${err.message} — retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5_000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;

      const text = update.message?.text?.trim();
      if (!text) continue;

      const isApproved = text === '✅' || text.toLowerCase() === 'approve';
      const finalTitle = isApproved ? proposedTitle : text;

      // Update video_queue.title in Supabase
      const { error: updateErr } = await sb
        .from('video_queue')
        .update({ title: finalTitle })
        .eq('task_id', taskId);

      if (updateErr) {
        console.warn(`  ⚠️  Could not update video_queue title: ${updateErr.message}`);
      }

      // Confirm back to Darl
      const confirmMsg = isApproved
        ? `✅ Title approved: ${finalTitle}`
        : `✅ Title updated to: ${finalTitle}`;
      await sendTgMessage(botToken, DARL_CHAT_ID, confirmMsg).catch(err => {
        console.warn(`  ⚠️  Could not send confirmation: ${err.message}`);
      });

      console.log(`  ✅ Title ${isApproved ? 'approved' : 'corrected'}: ${finalTitle}`);
      return finalTitle;
    }
  }

  throw new Error('Title approval timed out after 24 hours');
}

// ── CLI entry ─────────────────────────────────────────────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const [, , taskId, epNumberStr, ...titleParts] = process.argv;
  if (!taskId || !epNumberStr || titleParts.length === 0) {
    console.error('Usage: node scripts/title-approval.mjs <task_id> <ep_number> <proposed_title>');
    process.exit(1);
  }
  const epNumber = parseInt(epNumberStr, 10);
  const proposedTitle = titleParts.join(' ');

  awaitTitleApproval(taskId, epNumber, proposedTitle)
    .then(title => {
      console.log(`\nApproved title: ${title}`);
    })
    .catch(err => {
      console.error('❌', err.message);
      process.exit(1);
    });
}
