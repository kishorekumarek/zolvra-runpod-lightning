// lib/character-approval.mjs — Shared character list approval via Telegram
// Extracted from stage-01-concept-select.mjs and stage-01b-story-intake.mjs
// where it was duplicated (~70 identical lines in each file).
import {
  sendTelegramMessage,
  sendTelegramMessageWithCustomButtons,
  waitForTelegramMultiResponse,
} from './telegram.mjs';

/**
 * Interactive character list approval via Telegram.
 * Loops until the user approves — allows adding/removing characters.
 *
 * @param {string[]} characters - current character list
 * @param {string} prefix - callback prefix for Telegram buttons (e.g., 's1_chars', 's1b_chars')
 * @returns {Promise<string[]>} - approved character list (lowercased)
 */
export async function approveCharacterList(characters, prefix) {
  let charList = [...characters];
  let round = 0;

  while (true) {
    const charDisplay = charList.length > 0
      ? charList.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
      : '  (empty)';

    const msg = [
      `\u{1F464} Character List Review`,
      ``,
      charDisplay,
      ``,
      `Approve the list, or add/remove characters:`,
    ].join('\n');

    const callbackPrefix = `${prefix}_${round}`;
    const msgId = await sendTelegramMessageWithCustomButtons(msg, callbackPrefix, [
      { text: '\u2705 Approve', action: 'approve' },
      { text: '\u2795 Add', action: 'add' },
      { text: '\u2796 Remove', action: 'remove' },
    ]);

    const decision = await waitForTelegramMultiResponse(msgId, callbackPrefix, {
      needsFeedback: ['add', 'remove'],
    });

    if (decision.action === 'approve') {
      console.log(`  \u2713 Character list approved: ${charList.join(', ')}`);
      return charList;
    }

    if (decision.action === 'add') {
      const name = decision.comment?.trim().toLowerCase();
      if (name && !charList.includes(name)) {
        charList.push(name);
        console.log(`  \u2795 Added character: ${name}`);
        await sendTelegramMessage(`\u2795 Added "${name}" to character list`);
      } else if (name && charList.includes(name)) {
        await sendTelegramMessage(`\u26A0\uFE0F "${name}" already in the list`);
      }
    }

    if (decision.action === 'remove') {
      const input = decision.comment?.trim().toLowerCase();
      if (!input) {
        await sendTelegramMessage(`\u26A0\uFE0F No character specified to remove`);
      } else {
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
          console.log(`  \u2796 Removed character: ${removed}`);
          await sendTelegramMessage(`\u2796 Removed "${removed}" from character list`);
        } else {
          await sendTelegramMessage(`\u26A0\uFE0F Character "${input}" not found in the list`);
        }
      }
    }

    round++;
  }
}
