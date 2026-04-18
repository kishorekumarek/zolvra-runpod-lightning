// lib/parse-claude-json.mjs — Shared JSON response parser for Claude/Gemini
// Extracts and parses JSON from LLM responses, handling markdown fences,
// surrounding text, and other common LLM output quirks.

/**
 * Parse an LLM response that should contain JSON.
 * Handles: markdown fences, surrounding prose, nested fences, BOM characters.
 *
 * @param {string} rawText - Raw text from LLM response
 * @param {string} [context=''] - Context string for error messages
 * @returns {object} Parsed JSON object
 * @throws {Error} If no valid JSON found
 */
export function parseClaudeJSON(rawText, context = '') {
  let text = (rawText || '').trim();

  // 1. Try parsing as-is (cleanest case)
  try { return JSON.parse(text); } catch { /* continue */ }

  // 2. Strip markdown fences: ```json ... ``` or ``` ... ``` (case-insensitive, multi-line)
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
  }

  // 3. Extract outermost JSON block (handles surrounding prose)
  //    Detect whether the response is an object or array by finding the first { or [
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const isArray = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);

  if (isArray) {
    const arrMatch = text.match(/(\[[\s\S]*\])/);
    if (arrMatch) { try { return JSON.parse(arrMatch[1]); } catch { /* continue */ } }
  }
  const objMatch = text.match(/(\{[\s\S]*\})/);
  if (objMatch) {
    try { return JSON.parse(objMatch[1]); } catch { /* continue */ }
  }

  // 4. Nothing worked
  const preview = text.slice(0, 300);
  const ctx = context ? ` (${context})` : '';
  throw new Error(`Failed to parse JSON${ctx}. Raw text: ${preview}`);
}
