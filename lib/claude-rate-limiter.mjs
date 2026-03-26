// lib/claude-rate-limiter.mjs — shared retry wrapper for Claude API calls
// Handles 429 rate-limit and 529 overloaded responses with retry + exponential backoff.

const OVERLOADED_BASE_WAIT_MS = 30000;

/**
 * Wrap any async function that calls the Claude API with retry logic.
 * On 429 (rate limit) or 529 (overloaded): waits with exponential backoff, then retries.
 * On final failure: throws with a clear message.
 *
 * @param {() => Promise<any>} fn       - Async function to call
 * @param {number}             retries  - Max attempts (default 5)
 * @param {number}             waitMs   - Base wait time for 429 in ms (default 60000)
 * @returns {Promise<any>}
 */
export async function withRateLimit(fn, retries = 5, waitMs = 60000) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit =
        err?.status === 429 ||
        err?.error?.type === 'rate_limit_error' ||
        err?.message?.includes('429') ||
        err?.message?.toLowerCase().includes('rate limit');

      const isOverloaded =
        err?.status === 529 ||
        err?.error?.type === 'overloaded_error' ||
        err?.message?.toLowerCase().includes('overloaded');

      if (!isRateLimit && !isOverloaded) throw err;

      lastError = err;
      const label = isOverloaded ? 'overloaded (529)' : 'rate limit (429)';
      const baseWait = isOverloaded ? OVERLOADED_BASE_WAIT_MS : waitMs;
      const backoffMs = baseWait * Math.pow(2, attempt - 1);

      console.warn(
        `  ⚠️  Claude ${label} (attempt ${attempt}/${retries}). ` +
        `Waiting ${(backoffMs / 1000).toFixed(0)}s before retry...`
      );

      if (attempt < retries) {
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }

  throw new Error(`Claude retries exhausted after ${retries} attempts: ${lastError?.message}`);
}
