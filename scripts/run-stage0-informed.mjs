// scripts/run-stage0-informed.mjs — Informed Stage 0: research-driven concept generation
import 'dotenv/config';
import { writeFile } from 'fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabase } from '../lib/supabase.mjs';
import { sendTelegramMessage } from '../lib/telegram.mjs';

const CHAT_ID = 7879469053;
const TODAY = '20260322';

const RESEARCH_CONTEXT = `
CHANNEL ANALYTICS (real data):
- Audience: India (621 views), Sri Lanka (231), UAE (26) — primary diaspora is South Asia + Gulf
- Shorts outperform long-form: EP02 Short = 892 views, 73.9% retention
- English subtitles = unique differentiator (no major Tamil kids channel does this consistently)
- Age target: 3-7 year olds
- Language: colloquial Tamil + Tanglish (familiar to diaspora kids in UAE/UK/US/India)

COMPETITIVE LANDSCAPE:
- Zero Tamil kids channels meaningfully address diaspora identity (second-gen caught between two worlds)
- Large players (ChuChu TV 9.4M, MagicBox 4.24M) are all India-facing factory content
- Tamil Story Box uses English subtitles — small but validates the idea
- Tip Tales / Piku & Tuki is the only original recurring-character Tamil kids IP — still small (<143K)
- Diaspora gap = biggest untapped opportunity; zero competition

STRATEGIC PRIORITIES:
- Shorts-first discovery funnel (1 Short/day cadence)
- Character continuity beats anthology (ChuChu lesson: one recognisable character > random stories)
- Festival content spikes diaspora traffic: Tamil New Year (Puthandu) is in April
- Tamil school networks in UK/UAE/Canada share content organically — school-safe content wins
- Community seeding in UAE Tamil Facebook/WhatsApp groups is highest ROI move right now
`;

async function generateConceptsViaClaude() {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: 'You are the creative director for @tinytamiltales, a Tamil kids animated YouTube channel. Return ONLY valid JSON — no markdown, no explanation, no code fences.',
    messages: [{
      role: 'user',
      content: `Generate exactly 5 story concepts for Tamil animated kids content (age 3-7).

RESEARCH CONTEXT:
${RESEARCH_CONTEXT}

REQUIREMENTS — generate exactly ONE concept of each type:
1. Diaspora identity story — second-gen Tamil kid caught between two worlds (e.g. navigating a new school, explaining Tamil to a friend, wanting to fit in)
2. Tamil New Year / Puthandu seasonal episode — warmth, celebration, family ritual, suitable for April publish
3. Nature/animal story — works for ALL Tamil audiences globally, simple moral, suitable for long-form
4. Universal short moral story — short enough for a Shorts clip (60s), punchy hook in first 3 seconds
5. Experimental concept — something no Tamil kids channel has done (e.g. a Tamil riddle/puzzle format, a "what if" science story in Tamil, or a historical Tamil figure for kids)

For each concept return this exact schema:
{
  "title": "Story title in English",
  "tamilTitle": "கதை தலைப்பு (optional Tamil title if natural)",
  "theme": "one word: friendship / identity / celebration / bravery / curiosity / honesty / kindness",
  "characters": ["Character1 (species/role)", "Character2 (species/role)"],
  "synopsis": "2-3 sentences in English. Describe the story arc, the conflict, and the moral.",
  "targetDurationSeconds": 60,
  "targetAge": "3-7",
  "videoType": "short OR long",
  "hook": "The first 3-second hook line — what grabs a parent or child instantly"
}

Return a JSON array of exactly 5 concept objects.`,
    }],
  });

  const raw = response.content[0]?.text?.trim();
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(text);
}

function formatTelegramMessage(concept, index, total) {
  const typeLabel = concept.videoType === 'short'
    ? `Shorts ${concept.targetDurationSeconds}s`
    : `Long-form ~${Math.round(concept.targetDurationSeconds / 60)}min`;

  const charList = Array.isArray(concept.characters)
    ? concept.characters.join(', ')
    : concept.characters;

  return [
    `📖 Concept ${index}/${total}: ${concept.title}${concept.tamilTitle ? ` — ${concept.tamilTitle}` : ''}`,
    `Type: ${typeLabel}`,
    `Theme: ${concept.theme}`,
    `Characters: ${charList}`,
    `Synopsis: ${concept.synopsis}`,
    `Hook: "${concept.hook}"`,
    ``,
    `Reply with the number to select this concept.`,
  ].join('\n');
}

async function saveToSupabase(concepts) {
  const sb = getSupabase();
  const rows = concepts.map(c => ({
    title: c.title,
    theme: c.theme,
    characters: Array.isArray(c.characters) ? c.characters : [c.characters],
    synopsis: c.synopsis,
    target_duration_seconds: c.targetDurationSeconds,
    target_age: c.targetAge,
    video_type: c.videoType,
    created_at: new Date().toISOString(),
  }));

  const { data, error } = await sb
    .from('concept_cards')
    .insert(rows)
    .select('id');

  if (error) {
    console.warn(`  Supabase insert warning: ${error.message}`);
    return null;
  }
  console.log(`  Saved ${rows.length} concepts to Supabase concept_cards`);
  return data;
}

async function main() {
  console.log('🔍 Stage 0 (Informed): Generating research-driven story concepts...');

  // 1. Generate concepts via Claude with rich context
  console.log('  Calling Claude claude-sonnet-4-6 with research context...');
  let concepts;
  try {
    concepts = await generateConceptsViaClaude();
    console.log(`  Generated ${concepts.length} concepts`);
  } catch (err) {
    console.error('  Claude generation failed:', err.message);
    process.exit(1);
  }

  // 2. Save JSON to docs/
  const outputPath = `/Users/friday/.openclaw/workspace/streams/youtube/docs/stage0-concepts-${TODAY}.json`;
  await writeFile(outputPath, JSON.stringify(concepts, null, 2));
  console.log(`  Saved concepts to ${outputPath}`);

  // 3. Send intro message to Telegram
  await sendTelegramMessage(
    `🎬 *Ash — Stage 0 Research Complete*\n\nHere are ${concepts.length} story concepts for @tinytamiltales, informed by channel analytics and competitor research.\n\nReply with a concept number (1–${concepts.length}) to select it for production.`
  );

  // 4. Send each concept to Telegram
  for (let i = 0; i < concepts.length; i++) {
    const concept = concepts[i];
    const msg = formatTelegramMessage(concept, i + 1, concepts.length);
    await sendTelegramMessage(msg);
    console.log(`  Sent concept ${i + 1}/${concepts.length}: ${concept.title}`);
    // Small delay to avoid Telegram rate limits
    if (i < concepts.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // 5. Save to Supabase
  await saveToSupabase(concepts);

  console.log(`\n✅ Stage 0 complete: ${concepts.length} concepts sent to Darl via Telegram`);
  console.log(`   JSON saved: ${outputPath}`);

  return concepts;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
