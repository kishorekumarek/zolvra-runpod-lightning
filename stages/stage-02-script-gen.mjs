// stages/stage-02-script-gen.mjs — Claude generates flat scene array → Telegram review
// REWRITTEN for pipeline schema rewrite: reads concept from DB, writes to scenes + youtube_seo tables.
// Dual-write: also writes old pipeline_state JSONB + returns old state format for un-rewritten stages.
import 'dotenv/config';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSupabase } from '../lib/supabase.mjs';
import { callClaude } from '../../shared/claude.mjs';
import { callGemini } from '../../shared/gemini.mjs';
import { getSetting } from '../lib/settings.mjs';
import { sendTelegramMessage, sendTelegramMessageWithButtons, waitForTelegramResponse } from '../lib/telegram.mjs';
import { DEFAULT_VIDEO_TYPE, getVideoConfig, DEFAULTS } from '../lib/video-config.mjs';
import { parseClaudeJSON } from '../lib/parse-claude-json.mjs';
import {
  getPipelineState, getConcept, insertScenes, updateScene,
  insertYoutubeSeo, updatePipelineState, getScenes,
} from '../lib/pipeline-db.mjs';

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

const VALID_EMOTIONS = new Set(['excited', 'happy', 'sad', 'scared', 'gentle', 'whisper', 'angry', 'normal']);

/** Build set of known characters from character library + concept characters + narrator. */
function buildKnownCharacters(characters, conceptCharacters = []) {
  const speakers = new Set(['narrator']);
  for (const c of (characters || [])) {
    speakers.add(c.name.toLowerCase());
  }
  for (const name of conceptCharacters) {
    speakers.add(name.toLowerCase());
  }
  return speakers;
}

/**
 * Rewrite a scene's text from character dialogue to narrator perspective.
 */
async function rewriteAsNarrator(scene, rogueCharacter, tamilStyleGuide) {
  try {
    const msg = await callClaude({
      model: 'claude-sonnet-4-6',
      maxTokens: 512,
      system: `You are a Tamil children's story scriptwriter for @tinytamiltales.
${tamilStyleGuide ? `\nTAMIL STYLE GUIDE:\n${tamilStyleGuide}\n` : ''}
TASK: Rewrite the given scene text from first-person character dialogue into third-person narrator narration.
The original speaker was "${rogueCharacter}" but this character doesn't exist. Rewrite so the narrator describes what "${rogueCharacter}" said or did.
Keep the same meaning, emotion, and Tamil style. Keep it 20-30 words.
Return ONLY the rewritten Tamil text. No JSON. No explanation.`,
      messages: [{
        role: 'user',
        content: `Original text (was spoken by "${rogueCharacter}"): ${scene.text}`,
      }],
    });
    return msg.content[0]?.text?.trim() || scene.text;
  } catch (err) {
    console.warn(`  ⚠️  Narrator rewrite failed for scene ${scene.scene_number}: ${err.message}`);
    return scene.text;
  }
}

function buildSystemPrompt({ concept, characters, episodeNumber, targetClips, clipDurationSeconds, tamilStyleGuide, videoFeedback, voiceFeedback, videoType = 'long', artStyle = '3D Pixar animation still' }) {
  const characterJson = JSON.stringify(
    (characters || []).map(c => ({ name: c.name, description: c.description })),
    null, 2
  );

  const speakerNames = ['narrator', ...(characters || []).map(c => c.name.toLowerCase()), ...(concept.characters || []).map(c => c.toLowerCase())];
  const speakerList = [...new Set(speakerNames)].join(', ');

  const characterRules = (characters || []).map(c => {
    const name = c.name;
    const desc = c.description || '';
    return `- ${name}: ${desc}`;
  }).join('\n');

  const visualExamples = (characters || []).map(c => {
    const prompt = c.image_prompt || c.description || '';
    return `  ✅ "${prompt}"`;
  }).join('\n');

  const styleGuideSection = tamilStyleGuide
    ? `\n\n---\nTAMIL STYLE GUIDE (HARD CONSTRAINTS — MUST FOLLOW):\n${tamilStyleGuide}\n---`
    : '';

  const feedbackSection = videoFeedback
    ? `\n\n---\nVIDEO PRODUCTION FEEDBACK (APPLY TO THIS VIDEO):\n${videoFeedback}\n---`
    : '';

  const voiceFeedbackSection = voiceFeedback
    ? `\n\n---\nVOICE/TTS FEEDBACK (LEARNED FROM PREVIOUS EPISODES — APPLY TO DIALOGUE):\n${voiceFeedback}\n---`
    : '';

  const vtConfig = getVideoConfig(videoType);
  const videoTypeNote = `\nVIDEO FORMAT: ${vtConfig.promptFormatText} (${vtConfig.promptDurationText}). Generate exactly ${targetClips} scenes.${videoType === 'short' ? ' Keep each scene punchy and fast-paced.' : ''}`;

  return `You are a Tamil children's story scriptwriter for the YouTube channel @tinytamiltales.${styleGuideSection}${feedbackSection}${voiceFeedbackSection}${videoTypeNote}

TASK: Generate exactly ${targetClips} scenes for a Tamil kids story. Each scene is ONE visual moment.

HARD RULES (non-negotiable):
1. Return ONLY a valid JSON object. No markdown. No explanation. No wrapping.
2. The "scenes" array must contain EXACTLY ${targetClips} objects — no more, no fewer.
3. Each scene "text" must be in Tamil script (Tamil Unicode — e.g., நான் ரொம்ப குஷி). English loanwords can stay in English (e.g., rainbow, super, okay).
4. "visual_description" must be in English (used for image generation prompts).
5. Keep language simple — target age 3–7 years.
6. "speaker" must be one of: ${speakerList}
7. "emotion" must be one of: excited, happy, sad, scared, gentle, whisper, angry, normal
8. Use "narrator" if the character is not in the speaker list above.
9. Each scene is exactly ONE moment: one action, one line, one emotion. Nothing more.
10. Each scene "text" must be 20–30 words (not fewer, not more).
11. Each scene must include a "characters" array listing ALL characters VISIBLE in that scene (lowercase names). Include characters who appear visually even if they don't speak.

CHARACTER RULES (CRITICAL):
${characterRules}
- Introduce ALL characters in scenes 1–5
- First time a character appears, pair their name with a brief identity (species, role, or trait) so the audience knows who they are

LANGUAGE RULES (CRITICAL):
- NEVER use ழ words: use rain (not mazhai), pretty/beautiful (not azhaga), road/way (not vazhi), veliye vanthaan (not ezhunthaan)
- Use paarunga (not parunga), irukulla (not irukku illa?), mudiuma (not aaguma), penji ninnuchi (not mudinchitchu)
- Colloquial contractions only — no formal grammar

DIALOGUE EXPRESSION RULES:
- Write dialogue with natural punctuation: use ! for excitement, ? for questions, ... for pauses
- Use emotional Tamil expressions naturally (aiyyo, da, di, pa, ma)
- Do NOT add audio tags like [excited] or [sighs] — those are added automatically later

VISUAL DESCRIPTION RULES (CRITICAL):
- Art style for this video: ${artStyle}. Describe scenes with this style in mind.
- Always describe characters by their physical appearance — never just a name or vague label like "character" or "friend"
${visualExamples}
  ❌ "Meenu and her friends" (too vague — Imagen needs physical details)
  ❌ "character watching" (no identity — generates random output)
- Describe exact action, lighting, environment, and mood
- Use the character descriptions from the CHARACTER LIBRARY below for every visual_description
- KEEP each character's core identity LOCKED (face, skin tone, hair, body type, species) but ADAPT their clothing/accessories to fit the story setting. Describe the adapted outfit in every scene's visual_description so Imagen stays consistent.

${concept.outline ? `STORY OUTLINE (FOLLOW THIS STRUCTURE — do not invent your own arc):
${concept.outline}

Distribute the outline sections across ${targetClips} scenes. Each scene maps to ONE moment from the outline.` : `STORY ARC (${targetClips} scenes total):
${vtConfig.storyArc.map(a => `- ${a}`).join('\n')}`}

CHARACTER LIBRARY:
${characterJson}

STORY CONCEPT:
Title: ${concept.title}
Theme: ${concept.theme || ''}
Synopsis: ${concept.synopsis || ''}
Characters: ${concept.characters?.join(', ') || ''}

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
      "text": "Tamil script text with English loanwords, 20-30 words (e.g., தன்னோட friends-கிட்ட ஓடி வந்துச்சு)",
      "visual_description": "English description of exact single visual moment — use full character physical descriptions",
      "characters": ["meenu", "kavi"]
    }
  ]
}

IMPORTANT: "characters" must list ALL characters VISIBLE in the scene (lowercase), not just the speaker. If narrator is speaking but Meenu and Kavi are shown, characters = ["meenu", "kavi"]. This is used for visual consistency.
CRITICAL RULE: The speaker must ALWAYS be in the characters array. If uncle_ravi is speaking, characters must include "uncle ravi". Never omit the speaker from characters.`;
}

/**
 * Stage 2: Generate flat scene array via Claude, send to Telegram for approval.
 *
 * NEW: reads concept from DB, writes to scenes + youtube_seo tables.
 */
export async function runStage2(taskId, tracker, state = {}) {
  console.log('📝 Stage 2: Generating script...');

  const sb = getSupabase();

  // ── Read concept from DB (new) with fallback to old state ──────────
  let concept = null;
  const ps = await getPipelineState(taskId);
  if (ps?.concept_id) {
    concept = await getConcept(ps.concept_id);
    // Map DB column names to the format the prompt builder expects
    concept = {
      ...concept,
      artStyle: concept.art_style,
      videoType: concept.video_type,
    };
    console.log(`  ✓ Concept loaded from DB: "${concept.title}"`);
  }

  if (!concept) throw new Error('Stage 2: concept not found in DB — check pipeline_state and concepts tables');

  // videoType: read from concept
  const videoType = concept.videoType || concept.video_type || DEFAULT_VIDEO_TYPE;
  const videoConfig = getVideoConfig(videoType);
  let targetClips = videoConfig.sceneCount;
  let clipDurationSeconds = videoConfig.clipDurationSeconds;
  const artStyle = concept.artStyle || concept.art_style || DEFAULTS.artStyle;

  console.log(`  video_type=${videoType}, target_clips=${targetClips}, clip_duration_seconds=${clipDurationSeconds}`);

  // Get character library for Claude context
  const { data: characters } = await sb
    .from('character_library')
    .select('name, description, image_prompt, voice_id, approved')
    .eq('approved', true);

  // Generate episode number from video_queue (published videos count)
  const { count: episodeCount } = await sb
    .from('video_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'uploaded');

  const episodeNumber = (episodeCount || 0) + 1;

  // Load Tamil style guide, video feedback, and accumulated voice feedback
  const tamilStyleGuide = await getTamilStyleGuide();
  const videoFeedback = await getVideoFeedback();
  let voiceFeedback = '';
  try {
    voiceFeedback = await getSetting('voice_feedback') || '';
  } catch { /* no voice feedback yet */ }

  // ── Check for resume: already-approved scenes in new DB ────────────
  const existingScenes = await getScenes(taskId);
  const alreadyApproved = new Set(
    existingScenes.filter(s => s.script_approved).map(s => s.scene_number)
  );
  if (alreadyApproved.size > 0) {
    console.log(`  ↩️  Resume: ${alreadyApproved.size} scenes already approved in DB`);
  }

  // ── Generate and validate with up to 3 attempts ────────────────────
  let scenes;
  let youtube_seo;
  let lastError;

  // If we have existing scenes in DB (resume case), use them
  if (existingScenes.length > 0) {
    console.log(`  ↩️  Using ${existingScenes.length} existing scenes from DB`);
    scenes = existingScenes;
    // Load youtube_seo from pipeline_state if already saved
    if (ps?.youtube_seo_id) {
      const { getYoutubeSeo } = await import('../lib/pipeline-db.mjs');
      youtube_seo = await getYoutubeSeo(ps.youtube_seo_id);
    }
    // Self-healing: if scenes exist but youtube_seo is missing (crash between insertScenes and insertYoutubeSeo)
    if (!youtube_seo) {
      console.warn(`  ⚠️  Scenes exist but youtube_seo missing — generating fallback SEO`);
      youtube_seo = {
        title: `${concept.title} | Tamil Kids Story | Tiny Tamil Tales`,
        description: 'A heartwarming Tamil story for little ones. Subscribe to Tiny Tamil Tales! | குழந்தைகளுக்கான தமிழ் கதை',
        tags: ['tamil kids story', 'tamil animated story', 'tiny tamil tales', 'சிறுவர் கதை', 'tamil cartoon'],
      };
      const seoId = await insertYoutubeSeo({
        title: youtube_seo.title,
        description: youtube_seo.description,
        tags: youtube_seo.tags,
      });
      await updatePipelineState(taskId, { youtube_seo_id: seoId, episode_number: episodeNumber });
      console.log(`  ✓ Fallback youtube_seo saved (seo_id: ${seoId})`);
    }
  } else {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`  Generation attempt ${attempt}/3...`);
        const result = await generateScript({ concept, characters: characters || [], episodeNumber, targetClips, clipDurationSeconds, tamilStyleGuide, videoFeedback, voiceFeedback, videoType, artStyle });
        const knownCharacters = buildKnownCharacters(characters, concept.characters);
        validateScenes(result.scenes, targetClips, knownCharacters, videoType);

        // Reject if any scene lacks Tamil Unicode
        const asciiViolation = result.scenes.find(s => !containsTamilUnicode(s.text));
        if (asciiViolation) {
          throw new Error(`Scene ${asciiViolation.scene_number} has no Tamil script — must use Tamil Unicode`);
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

    // Rewrite rogue character scenes to narrator perspective
    const rogueScenes = scenes.filter(s => s._rogueCharacter);
    if (rogueScenes.length > 0) {
      console.warn(`  ⚠️  ${rogueScenes.length} scene(s) had rogue characters — rewriting to narrator perspective`);
      for (const scene of rogueScenes) {
        console.log(`  ↩️  Scene ${scene.scene_number}: "${scene._rogueCharacter}" → narrator`);
        scene.text = await rewriteAsNarrator(scene, scene._rogueCharacter, tamilStyleGuide);
        delete scene._rogueCharacter;
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

    // ── NEW: Write scenes + youtube_seo to DB ──────────────────────────
    await insertScenes(taskId, scenes);
    console.log(`  ✓ ${scenes.length} scenes saved to DB`);

    const seoId = await insertYoutubeSeo({
      title: youtube_seo.title,
      description: youtube_seo.description,
      tags: youtube_seo.tags,
    });
    await updatePipelineState(taskId, { youtube_seo_id: seoId, episode_number: episodeNumber });
    console.log(`  ✓ youtube_seo saved to DB (seo_id: ${seoId})`);
  }

  // ── Per-scene approval loop via Telegram ─────────────────────────
  await sendTelegramMessage(`📝 Script ready: "${concept.title}" (Ep. ${episodeNumber}) — ${scenes.length} scenes for review`);

  for (const scene of scenes) {
    const sceneNum = scene.scene_number;

    // Skip already-approved scenes (resume support — check DB)
    if (alreadyApproved.has(sceneNum)) {
      console.log(`  Scene ${sceneNum}: already approved — skipping`);
      continue;
    }

    let approved = false;
    while (!approved) {
      const callbackPrefix = `s2_${sceneNum}`;
      const telegramMsg = [
        `📝 Scene ${sceneNum}/${scenes.length}`,
        `Speaker: ${scene.speaker} | Emotion: ${scene.emotion}`,
        ``,
        `Text: ${scene.text}`,
        ``,
        `Visual: ${scene.visual_description}`,
      ].join('\n');
      const telegramMessageId = await sendTelegramMessageWithButtons(telegramMsg, callbackPrefix);
      const decision = await waitForTelegramResponse(telegramMessageId, callbackPrefix);

      if (decision.approved) {
        // NEW: mark approved in DB
        await updateScene(taskId, sceneNum, { script_approved: true });
        approved = true;
        console.log(`  ✓ Scene ${sceneNum} approved`);
      } else {
        console.log(`  ✗ Scene ${sceneNum} rejected: ${decision.comment}`);

        const textMatch = decision.comment?.match(/^text:\s*(.+)/is);
        if (textMatch) {
          scene.text = textMatch[1].trim();
          // NEW: update text in DB
          await updateScene(taskId, sceneNum, { text: scene.text });
          console.log(`  ↩️  Scene ${sceneNum} text replaced directly`);
        } else {
          console.log(`  ↩️  Regenerating scene ${sceneNum} with feedback...`);
          const regenerated = await regenerateSingleScene({
            scene,
            scenes,
            feedback: decision.comment,
            concept,
            characters: characters || [],
            episodeNumber,
            targetClips,
            tamilStyleGuide,
            videoFeedback,
          });
          scene.text = regenerated.text;
          scene.visual_description = regenerated.visual_description;
          if (regenerated.speaker) scene.speaker = regenerated.speaker;
          if (regenerated.emotion) scene.emotion = regenerated.emotion;
          // NEW: update regenerated scene in DB
          await updateScene(taskId, sceneNum, {
            text: scene.text,
            visual_description: scene.visual_description,
            speaker: scene.speaker,
            emotion: scene.emotion,
          });
        }
      }
    }
  }

  await sendTelegramMessage(`✅ All ${scenes.length} scenes approved for "${concept.title}"`);
  console.log(`✅ Stage 2 complete — ${scenes.length} scenes approved.`);

}

async function generateScript({ concept, characters, episodeNumber, targetClips, clipDurationSeconds, tamilStyleGuide, videoFeedback, voiceFeedback, videoType = 'long', artStyle }) {
  const systemPrompt = buildSystemPrompt({ concept, characters, episodeNumber, targetClips, clipDurationSeconds, tamilStyleGuide, videoFeedback, voiceFeedback, videoType, artStyle: artStyle || concept.artStyle });

  const message = await callClaude({
    model: 'claude-sonnet-4-6',
    maxTokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Generate the complete scene list for "${concept.title}". Return only valid JSON — no markdown fences, no extra text.` }],
  });

  const parsed = parseClaudeJSON(message.content[0]?.text, 'Stage 2 generateScript');

  return {
    scenes: parsed.scenes || parsed,
    youtube_seo: parsed.youtube_seo || null,
  };
}

function validateScenes(scenes, targetClips, knownCharacters, videoType = 'short') {
  if (!Array.isArray(scenes)) throw new Error('scenes is not an array');
  if (scenes.length !== targetClips) {
    throw new Error(`Expected exactly ${targetClips} scenes, got ${scenes.length}`);
  }

  for (const scene of scenes) {
    if (!scene.scene_number) throw new Error(`Scene missing scene_number`);
    if (!scene.text) throw new Error(`Scene ${scene.scene_number} missing text`);
    if (!scene.visual_description) throw new Error(`Scene ${scene.scene_number} missing visual_description`);

    // Auto-fix invalid speaker — flag rogue characters for narrator perspective rewrite
    const speaker = (scene.speaker || 'narrator').toLowerCase();
    if (knownCharacters.has(speaker)) {
      scene.speaker = speaker;
    } else {
      scene._rogueCharacter = speaker;
      scene.speaker = 'narrator';
    }

    // Auto-fix invalid emotion
    const emotion = (scene.emotion || 'normal').toLowerCase();
    scene.emotion = VALID_EMOTIONS.has(emotion) ? emotion : 'normal';

    // Auto-fix characters array — fallback to [speaker] if missing
    if (!Array.isArray(scene.characters) || scene.characters.length === 0) {
      scene.characters = scene.speaker !== 'narrator' ? [scene.speaker] : [];
    } else {
      scene.characters = scene.characters
        .map(c => c.toLowerCase())
        .filter(c => knownCharacters.has(c) && c !== 'narrator');
      // Ensure speaker is in their own scene's characters array
      if (scene.speaker && scene.speaker !== 'narrator' && !scene.characters.includes(scene.speaker)) {
        scene.characters.push(scene.speaker);
      }
    }

    // Check word count
    const wordCount = scene.text.trim().split(/\s+/).length;
    const valConfig = getVideoConfig(videoType);
    const minWords = valConfig.minWordsPerScene;
    const maxWords = valConfig.maxWordsPerScene;
    if (wordCount < minWords) {
      throw new Error(`Scene ${scene.scene_number} text too short (${wordCount} words, min ${minWords})`);
    }
    if (wordCount > maxWords) {
      throw new Error(`Scene ${scene.scene_number} text too long (${wordCount} words, max ${maxWords})`);
    }
  }
}

/**
 * Regenerate a single scene using Claude, with surrounding scenes as context and user feedback.
 */
async function regenerateSingleScene({ scene, scenes, feedback, concept, characters, episodeNumber, targetClips, tamilStyleGuide, videoFeedback }) {
  const surroundingContext = scenes
    .filter(s => Math.abs(s.scene_number - scene.scene_number) <= 2)
    .map(s => `Scene ${s.scene_number} (${s.speaker}, ${s.emotion}): ${s.text}`)
    .join('\n');

  const characterJson = JSON.stringify(
    characters.map(c => ({ name: c.name, description: c.description })),
    null, 2
  );

  const systemPrompt = `You are a Tamil children's story scriptwriter for @tinytamiltales.
${tamilStyleGuide ? `\nTAMIL STYLE GUIDE:\n${tamilStyleGuide}\n` : ''}
${videoFeedback ? `\nVIDEO FEEDBACK:\n${videoFeedback}\n` : ''}
CHARACTER LIBRARY:
${characterJson}

STORY: "${concept.title}" — ${concept.synopsis}

TASK: Regenerate ONLY scene ${scene.scene_number} based on the user's feedback. Keep it consistent with surrounding scenes.
Return ONLY a JSON object: { "scene_number": ${scene.scene_number}, "speaker": "...", "emotion": "...", "text": "Tamil script...", "visual_description": "English...", "characters": ["all", "visible", "characters"] }
The "characters" array must list ALL characters visible in the scene (lowercase), not just the speaker.
No markdown. No explanation.`;

  const message = await callClaude({
    model: 'claude-sonnet-4-6',
    maxTokens: 1024,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Surrounding scenes:\n${surroundingContext}\n\nCurrent scene ${scene.scene_number}:\nSpeaker: ${scene.speaker} | Emotion: ${scene.emotion}\nText: ${scene.text}\nVisual: ${scene.visual_description}\n\nFeedback: ${feedback}\n\nRegenerate this scene. Return only JSON.`,
    }],
  });

  return parseClaudeJSON(message.content[0]?.text, `Stage 2 regenerateScene ${scene.scene_number}`);
}

function getSampleResult(concept, episodeNumber, targetClips) {
  const scenes = [];
  for (let i = 1; i <= targetClips; i++) {
    scenes.push({
      scene_number: i,
      speaker: 'narrator',
      emotion: 'gentle',
      text: 'ஒரு அழகான காட்டுல, Kavin, peacock, தன்னோட friends-ஓட happy-ஆ time spend பண்ணிட்டு இருந்தான்.',
      visual_description: `Tamil forest scene ${i}: a colorful peacock with spread fan tail feathers in a sunny forest clearing`,
      characters: [],
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
