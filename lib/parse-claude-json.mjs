// lib/parse-claude-json.mjs — Shared Claude JSON response parser
// Strips markdown fences and parses JSON. Used by all stages that call Claude
// and expect a JSON response. Replaces 6+ duplicate fence-stripping patterns.

/**
 * Parse a Claude response that should contain JSON.
 * Strips markdown fences (```json ... ```) before parsing.
 *
 * @param {string} rawText - Raw text from Claude response (message.content[0]?.text)
 * @param {string} [context=''] - Context string for error messages (e.g., "Stage 2 script generation")
 * @returns {object} Parsed JSON object
 * @throws {Error} If parsing fails, with descriptive message including first 200 chars of raw text
 */
export function parseClaudeJSON(rawText, context = '') {
  let text = (rawText || '').trim();

  // Strip markdown fences: ```json ... ``` or ``` ... ```
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(text);
  } catch (err) {
    const preview = text.slice(0, 200);
    const ctx = context ? ` (${context})` : '';
    throw new Error(`Failed to parse Claude JSON${ctx}: ${err.message}. Raw text: ${preview}`);
  }
}
