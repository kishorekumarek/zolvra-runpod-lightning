// lib/claude-rate-limiter.mjs — shared retry wrapper for Claude API calls
// Handles 429 rate-limit responses with configurable wait + retry logic.

/**
 * Wrap any async function that calls the Claude API with rate-limit retry logic.
 * On 429: waits waitMs, then retries up to `retries` times total.
 * On final failure: throws with a clear message.
 *
 * @param {() => Promise<any>} fn       - Async function to call
 * @param {number}             retries  - Max attempts (default 3)
 * @param {number}             waitMs   - Wait time on 429 in ms (default 60000)
 * @returns {Promise<any>}
 */
export async function withRateLimit(fn, retries = 3, waitMs = 60000) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 =
        err?.status === 429 ||
        err?.error?.type === 'rate_limit_error' ||
        err?.message?.includes('429') ||
        err?.message?.toLowerCase().includes('rate limit');

      if (!is429) throw err;

      lastError = err;
      console.warn(
        `  ⚠️  Claude rate limit hit (attempt ${attempt}/${retries}). ` +
        `Waiting ${waitMs / 1000}s before retry...`
      );

      if (attempt < retries) {
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  throw new Error(`Claude rate limit exhausted after ${retries} retries: ${lastError?.message}`);
}
