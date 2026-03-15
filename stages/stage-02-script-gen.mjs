// stages/stage-02-script-gen.mjs — Claude generates flat scene array → NEXUS review
import 'dotenv/config';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSupabase } from '../lib/supabase.mjs';
import { createNexusCard } from '../lib/nexus-client.mjs';
import { withRetry } from '../lib/retry.mjs';
import { callClaude } from '../../shared/claude.mjs';
import { getSetting, getVideoType } from '../lib/settings.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load Tamil style guide at module init (non-blocking — awaited before first use)
let _tamilStyleGuide = null;
async function getTamilStyleGuide() {
  if (_tamilStyleGuide) return _tamilStyleGuide;
  try {
    _tamilStyleGuide = await readFile(join(__dirname, '..', 'lib', 'tamil-style-guide.md'), 'utf8');
  } catch {
    console.warn('  ⚠️  tamil-style-guide.md not found — proceeding without it');
    _tamilStyleGuide = '';
  }
  return _tamilStyleGuide;
}

let _videoFeedback = null;
async function getVideoFeedback() {
  if (_videoFeedback) return _videoFeedback;
  try {
    _videoFeedback = await readFile(join(__dirname, '..', 'lib', 'video-feedback.md'), 'utf8');
  } catch {
    console.warn('  ⚠️  video-feedback.md not found — proceeding without it');
    _videoFeedback = '';
  }
  return _videoFeedback;
}

/** Returns true if any Tamil Unicode characters (U+0B80–U+0BFF) are present. */
function containsTamilUnicode(text) {
  return /[\u0B80-\u0BFF]/.test(text || '');
}

const VALID_SPEAKERS = new Set(['narrator', 'kavin', 'kitti', 'valli', 'sparrows', 'elder']);
const VALID_EMOTIONS = new Set(['excited', 'happy', 'sad', 'scared', 'gentle', 'whisper', 'angry', 'normal']);

function buildSystemPrompt({ concept, characters, episodeNumber, targetClips, clipDurationSeconds, tamilStyleGuide, videoFeedback, videoType = 'long' }) {
  const characterJson = JSON.stringify(
    (characters || []).map(c => ({ name: c.name, description: c.description })),
    null, 2
  );

  const styleGuideSection = tamilStyleGuide
    ? `\n\n---\nTAMIL STYLE GUIDE (HARD CONSTRAINTS — MUST FOLLOW):\n${tamilStyleGuide}\n---`
    : '';

  const feedbackSection = videoFeedback
    ? `\n\n---\nVIDEO PRODUCTION FEEDBACK (APPLY TO THIS VIDEO):\n${videoFeedback}\n---`
    : '';

  const videoTypeNote = videoType === 'short'
    ? `\nVIDEO FORMAT: YouTube Short (~60–90s total). Generate exactly ${targetClips} scenes (8 max). Keep each scene punchy and fast-paced.`
    : `\nVIDEO FORMAT: Long-form YouTube video (~${Math.round(targetClips * clipDurationSeconds / 60)} minutes). Generate exactly ${targetClips} scenes.`;

  return `You are a Tamil children's story scriptwriter for the YouTube channel @tinytamiltales.${styleGuideSection}${feedbackSection}${videoTypeNote}

TASK: Generate exactly ${targetClips} scenes for a Tamil kids story. Each scene is ONE visual moment.

HARD RULES (non-negotiable):
1. Return ONLY a valid JSON object. No markdown. No explanation. No wrapping.
2. The "scenes" array must contain EXACTLY ${targetClips} objects — no more, no fewer.
3. Each scene "text" must be in ROMANIZED Tamil (English letters only — NO Tamil Unicode, NO Tamil script characters ever).
4. "visual_description" must be in English (used for image generation prompts).
5. Keep language simple — target age 3–7 years.
6. "speaker" must be one of: narrator, kavin, kitti, valli, sparrows, elder
7. "emotion" must be one of: excited, happy, sad, scared, gentle, whisper, angry, normal
8. Use "narrator" if the character is not in the speaker list above.
9. Each scene is exactly ONE moment: one action, one line, one emotion. Nothing more.
10. Each scene "text" must be 20–30 romanized words (not fewer, not more).

CHARACTER RULES (CRITICAL):
- Characters are ANIMALS ONLY — no humans, no children
- Kavin = peacock (mayil). First mention: "Kavin, peacock," — curious, gentle, young male voice
- Kitti = parrot (kili). First mention: "Kitti, kili," — chatty, fast talker
- Valli = bulbul (kuruvi). First mention: "Valli, kuruvi," — gentle, soft female voice
- Sparrows = small birds. Speaker key: "sparrows" — short bursts, high energy. NEVER refer to them as "children"
- Introduce ALL characters (Kavin, Kitti, Valli, sparrows) in scenes 1–5

LANGUAGE RULES (CRITICAL):
- NEVER use ழ words: use rain (not mazhai), pretty/beautiful (not azhaga), road/way (not vazhi), veliye vanthaan (not ezhunthaan)
- Use paarunga (not parunga), irukulla (not irukku illa?), mudiuma (not aaguma), penji ninnuchi (not mudinchitchu)
- Colloquial contractions only — no formal grammar

VISUAL DESCRIPTION RULES (CRITICAL):
- Always name the exact animal species — never "character", "friend", or "children"
  ✅ "a colorful peacock with spread fan tail feathers"
  ✅ "a bright green parrot with expressive eyes"
  ✅ "a small brown bulbul songbird"
  ✅ "three tiny sparrows perched on a branch"
  ❌ "Kavin and his friends" (too vague — generates humans)
  ❌ "children watching" (generates human children)
- Describe exact action, lighting, environment, and mood
- All characters are ANIMALS — no humans ever

STORY ARC (${targetClips} scenes total):
- Intro (scenes 1–5): establish setting, introduce ALL characters, gentle tone
- Rising action (scenes 6–14): build tension or adventure
- Climax (scenes 15–20): peak emotion or challenge
- Resolution (scenes 21–${targetClips}): resolution and lesson

CHARACTER LIBRARY:
${characterJson}

STORY CONCEPT:
Title: ${concept.title}
Theme: ${concept.theme}
Synopsis: ${concept.synopsis}
Characters: ${concept.characters?.join(', ')}

EPISODE NUMBER: ${episodeNumber}

Return ONLY this JSON structure:
{
  "youtube_seo": {
    "title": "...",
    "description": "...",
    "tags": ["..."]
  },
  "scenes": [
    {
      "scene_number": 1,
      "speaker": "narrator",
      "emotion": "gentle",
      "text": "Romanized Tamil text, 20-30 words",
      "visual_description": "English description of exact single visual moment — name animal species explicitly"
    }
  ]
}`;
}

/**
 * Stage 2: Generate flat scene array via Claude, post to NEXUS for visibility (non-blocking).
 */
export async function runStage2(taskId, tracker, state = {}) {
  console.log('📝 Stage 2: Generating script...');

  const { concept, parentCardId } = state;
  if (!concept) throw new Error('Stage 2: concept not found in pipeline state');

  const sb = getSupabase();

  // Read pipeline settings
  const videoType = await getVideoType(); // 'long' | 'short'
  let targetClips = videoType === 'short' ? 8 : 24;
  let clipDurationSeconds = videoType === 'short' ? 7 : 10;
  try {
    const rawClips = await getSetting('target_clips');
    if (rawClips) targetClips = parseInt(rawClips, 10) || targetClips;
  } catch { /* use default */ }
  try {
    const rawDur = await getSetting('clip_duration_seconds');
    if (rawDur) clipDurationSeconds = parseInt(rawDur, 10) || clipDurationSeconds;
  } catch { /* use default */ }

  console.log(`  video_type=${videoType}, target_clips=${targetClips}, clip_duration_seconds=${clipDurationSeconds}`);

  // Get character library for Claude context
  const { data: characters } = await sb
    .from('character_library')
    .select('name, description, image_prompt, voice_id, approved')
    .eq('approved', true);

  // Generate episode number
  const { count: episodeCount } = await sb
    .from('video_pipeline_runs')
    .select('*', { count: 'exact', head: true })
    .eq('stage', 9)
    .eq('status', 'completed');

  const episodeNumber = (episodeCount || 0) + 1;

  // Load Tamil style guide and video feedback before generation
  const tamilStyleGuide = await getTamilStyleGuide();
  const videoFeedback = await getVideoFeedback();

  // Generate and validate with up to 3 attempts
  // Also retries if Tamil Unicode characters are found in text fields
  let scenes;
  let youtube_seo;
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`  Generation attempt ${attempt}/3...`);
      const result = await withRetry(
        () => generateScript({ concept, characters: characters || [], episodeNumber, targetClips, clipDurationSeconds, tamilStyleGuide, videoFeedback, videoType }),
        { maxRetries: 5, baseDelayMs: 15000, stage: 2, taskId }
      );
      validateScenes(result.scenes, targetClips);

      // Reject if any Tamil Unicode slipped through
      const unicodeViolation = result.scenes.find(s => containsTamilUnicode(s.text));
      if (unicodeViolation) {
        throw new Error(`Tamil Unicode found in scene ${unicodeViolation.scene_number} text — must be romanized only`);
      }

      scenes = result.scenes;
      youtube_seo = result.youtube_seo;
      break;
    } catch (err) {
      lastError = err;
      console.warn(`  Attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
    }
  }

  if (!scenes) throw new Error(`Script generation failed after 3 attempts: ${lastError?.message}`);

  // Validate no placeholder text slipped through
  const FORBIDDEN_PLACEHOLDERS = ['same locked description', 'same description', '[locked description]', 'INSERT CHARACTER'];
  for (const scene of scenes) {
    for (const placeholder of FORBIDDEN_PLACEHOLDERS) {
      if (scene.visual_description?.toLowerCase().includes(placeholder.toLowerCase())) {
        throw new Error(`Scene ${scene.scene_number} visual_description contains placeholder text: "${placeholder}". Fix the script generation prompt.`);
      }
    }
  }

  // Auto-fill youtube_seo if Claude omitted it
  if (!youtube_seo) {
    youtube_seo = {
      title: `${concept.title} | Tamil Kids Story | Tiny Tamil Tales`,
      description: 'A heartwarming Tamil story for little ones. Subscribe to Tiny Tamil Tales! | குழந்தைகளுக்கான தமிழ் கதை',
      tags: ['tamil kids story', 'tamil animated story', 'tiny tamil tales', 'சிறுவர் கதை', 'tamil cartoon'],
    };
  }

  // Save to DB state
  await sb.from('video_pipeline_runs').upsert({
    task_id: taskId,
    stage: 2,
    status: 'awaiting_review',
    pipeline_state: { scenes, episodeNumber, youtube_seo },
  }, { onConflict: 'task_id,stage' });

  // Post to NEXUS for visibility
  const preview = JSON.stringify(scenes.slice(0, 3), null, 2);
  const cardId = await createNexusCard({
    title: `Script Review: ${concept.title} (Ep. ${episodeNumber})`,
    description: [
      `**Episode:** ${episodeNumber}`,
      `**Scenes:** ${scenes.length} (target: ${targetClips})`,
      `**Clip duration:** ~${clipDurationSeconds}s each`,
      `**Characters used:** ${[...new Set(scenes.map(s => s.speaker))].join(', ')}`,
      `\n\`\`\`json\n${preview}\n\`\`\``,
      scenes.length > 3 ? '\n_(first 3 scenes shown — full script in pipeline state)_' : '',
    ].join('\n'),
    task_type: 'script_proposal',
    priority: 'high',
    parent_id: parentCardId,
    stream: 'youtube',
  });

  console.log(`  Script posted to NEXUS for visibility (card: ${cardId})`);
  console.log(`✅ Stage 2 complete — ${scenes.length} scenes generated.`);

  // Build script object expected by stage-03 (metadata.characters) and stage-08 (youtube_seo)
  const script = {
    metadata: {
      title: youtube_seo.title,
      episode: episodeNumber,
      characters: [...new Set(scenes.map(s => s.speaker).filter(s => s !== 'narrator'))],
    },
    youtube_seo,
  };

  return { ...state, scenes, episodeNumber, youtube_seo, script, videoType };
}

async function generateScript({ concept, characters, episodeNumber, targetClips, clipDurationSeconds, tamilStyleGuide, videoFeedback, videoType = 'long' }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('No ANTHROPIC_API_KEY — using sample scenes');
    return getSampleResult(concept, episodeNumber, targetClips);
  }

  const systemPrompt = buildSystemPrompt({ concept, characters, episodeNumber, targetClips, clipDurationSeconds, tamilStyleGuide, videoFeedback, videoType });

  const message = await callClaude({
    model: 'claude-sonnet-4-6',
    maxTokens: 8192,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Generate the complete scene list for "${concept.title}". Return only valid JSON — no markdown fences, no extra text.`,
    }],
  });

  let text = message.content[0]?.text?.trim() || '';
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed = JSON.parse(text);

  return {
    scenes: parsed.scenes || parsed, // handle both { scenes: [...] } and bare array
    youtube_seo: parsed.youtube_seo || null,
  };
}

function validateScenes(scenes, targetClips) {
  if (!Array.isArray(scenes)) throw new Error('scenes is not an array');
  if (scenes.length !== targetClips) {
    throw new Error(`Expected exactly ${targetClips} scenes, got ${scenes.length}`);
  }

  for (const scene of scenes) {
    if (!scene.scene_number) throw new Error(`Scene missing scene_number`);
    if (!scene.text) throw new Error(`Scene ${scene.scene_number} missing text`);
    if (!scene.visual_description) throw new Error(`Scene ${scene.scene_number} missing visual_description`);

    // Auto-fix invalid speaker
    const speaker = (scene.speaker || 'narrator').toLowerCase();
    scene.speaker = VALID_SPEAKERS.has(speaker) ? speaker : 'narrator';

    // Auto-fix invalid emotion
    const emotion = (scene.emotion || 'normal').toLowerCase();
    scene.emotion = VALID_EMOTIONS.has(emotion) ? emotion : 'normal';

    // Check word count (split on whitespace)
    const wordCount = scene.text.trim().split(/\s+/).length;
    if (wordCount < 15) {
      throw new Error(`Scene ${scene.scene_number} text too short (${wordCount} words, min 15)`);
    }
    if (wordCount > 30) {
      throw new Error(`Scene ${scene.scene_number} text too long (${wordCount} words, max 30)`);
    }
  }
}

function getSampleResult(concept, episodeNumber, targetClips) {
  const scenes = [];
  for (let i = 1; i <= targetClips; i++) {
    scenes.push({
      scene_number: i,
      speaker: 'narrator',
      emotion: 'gentle',
      text: 'ஒரு அழகிய காலையில் சிறுவன் வீட்டை விட்டு கிளம்பினான்.',
      visual_description: `Tamil village scene ${i}: a cheerful child in a sunny courtyard`,
    });
  }
  return {
    scenes,
    youtube_seo: {
      title: `${concept.title} | Tamil Kids Story | Tiny Tamil Tales`,
      description: 'A heartwarming Tamil story for little ones. Subscribe to Tiny Tamil Tales!',
      tags: ['tamil kids story', 'tamil animated story', 'tiny tamil tales', 'சிறுவர் கதை'],
    },
  };
}
