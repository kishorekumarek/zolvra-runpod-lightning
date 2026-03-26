// lib/retry.mjs — withRetry() with exponential backoff
import { getSupabase } from './supabase.mjs';
import { BudgetCapExceededError } from './cost-tracker.mjs';
import { sendTelegramMessage } from './telegram.mjs';
import { STAGE_NUM_TO_ID } from './stage-ids.mjs';

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Retry a function with exponential backoff.
 * Never retries BudgetCapExceededError.
 */
export async function withRetry(fn, {
  maxRetries = 3,
  baseDelayMs = 5000,
  stage = -1,
  taskId = null,
} = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Never retry budget cap errors — halt immediately
      if (err instanceof BudgetCapExceededError) throw err;

      console.error(`Stage ${stage} attempt ${attempt}/${maxRetries} failed: ${err.message}`);

      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  // All retries exhausted — update DB and escalate
  if (taskId !== null) {
    await escalateToDarl(stage, taskId, lastError);
  }

  throw lastError;
}

export async function escalateToDarl(stage, taskId, error) {
  const sb = getSupabase();

  // Update pipeline run status
  await sb
    .from('video_pipeline_runs')
    .update({
      status: 'failed',
      error: error.message,
      completed_at: new Date().toISOString(),
    })
    .eq('task_id', taskId)
    .eq('stage_id', STAGE_NUM_TO_ID[stage]);

  // Send escalation to Telegram
  try {
    await sendTelegramMessage(`🚨 Pipeline escalation: Stage ${stage} failed — ${error.message}\nTask: ${taskId}`);
  } catch (telegramErr) {
    console.error('Failed to send escalation to Telegram:', telegramErr.message);
  }
}
