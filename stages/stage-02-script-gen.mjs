// stages/stage-02-script-gen.mjs — Gemini generates flat scene array → Telegram review
// Reads concept from DB, calls Gemini to generate script, writes to scenes + youtube_seo tables.
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';
import { callGemini } from '../../shared/gemini.mjs';
import { isFeedbackCollectionMode } from '../lib/settings.mjs';
import { sendTelegramMessage, sendTelegramMessageWithButtons, waitForTelegramResponse } from '../lib/telegram.mjs';
import { DEFAULT_VIDEO_TYPE, getVideoConfig } from '../lib/video-config.mjs';
import { parseClaudeJSON } from '../lib/parse-claude-json.mjs';
import {
  getPipelineState, getConcept, insertScenes, updateScene,
  insertYoutubeSeo, updatePipelineState, getScenes,
} from '../lib/pipeline-db.mjs';

const VALID_EMOTIONS = new Set(['excited', 'happy', 'sad', 'scared', 'gentle', 'whisper', 'angry', 'normal']);

function buildSystemPrompt({ concept, targetClips }) {
  return `Convert the following story into a ${targetClips}-scene script for a Tamil children's YouTube channel (@tinytamiltales).

For each scene provide:

Scene Heading: A brief title for the scene.

Speaker: Specify one speaker (either a specific character or a Narrator).

Tamil Script: The dialogue or narration written in TANGLISH(modern spoken tamil with english words infused) with Tamil script letters, pure english words can be in english. extended dialogue should be 10s long.

English Translation: The English version of that text.

Visual Description: A one-liner describing the scene in a 3D Pixar-style animation style.

Emotion: One of: excited, happy, sad, scared, gentle, whisper, angry, normal

Characters: Array of ALL character names visible in the scene (lowercase), including the speaker.

Use only one speaker per scene.
Ensure the emotional arc of the story is captured across the ${targetClips} scenes.
The speaker must always be included in the characters array.

Also generate:
- youtube_seo with title, description (include Tamil text), and tags array for a Tamil kids story channel.
- character_descriptions: an object mapping each character name (lowercase) to a one-line physical description suitable for image generation (age, gender, appearance, clothing, distinguishing features). Do NOT include "narrator".

Return ONLY valid JSON, no markdown fences:
{
  "youtube_seo": { "title": "...", "description": "...", "tags": ["..."] },
  "character_descriptions": {
    "character_name": "one-line physical description for image generation"
  },
  "scenes": [
    {
      "scene_number": 1,
      "heading": "Scene title",
      "speaker": "narrator",
      "emotion": "gentle",
      "text": "Tamil TANGLISH dialogue",
      "english": "English translation",
      "visual_description": "3D Pixar-style scene description",
      "characters": ["character1"]
    }
  ]
}`;
}

/**
 * Stage 2: Generate scene array via Gemini, send to Telegram for approval.
 *
 * Reads concept from DB, writes to scenes + youtube_seo tables.
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
  const targetClips = videoConfig.sceneCount;

  console.log(`  video_type=${videoType}, target_clips=${targetClips}`);

  // Generate episode number from video_queue (published videos count)
  const { count: episodeCount } = await sb
    .from('video_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'uploaded');

  const episodeNumber = (episodeCount || 0) + 1;

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
        const result = await generateScript({ concept, targetClips });
        validateScenes(result.scenes, targetClips, videoType);

        scenes = result.scenes;
        youtube_seo = result.youtube_seo;
        // Store character_descriptions from Gemini for Stage 3 to use
        if (result.character_descriptions) {
          await updatePipelineState(taskId, { character_descriptions: result.character_descriptions });
          console.log(`  ✓ ${Object.keys(result.character_descriptions).length} character descriptions saved`);
        }
        break;
      } catch (err) {
        lastError = err;
        console.warn(`  Attempt ${attempt}/3 failed: ${err.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
      }
    }

    if (!scenes) throw new Error(`Script generation failed after 3 attempts: ${lastError?.message}`);

    // Auto-fill youtube_seo if Gemini omitted it
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

  const feedbackMode = await isFeedbackCollectionMode();

  // Auto-mode: skip per-scene approval, mark all scenes as script_approved in DB.
  if (!feedbackMode) {
    await sendTelegramMessage(
      `📝 Stage 2 (auto) — script generated: "${concept.title}" (Ep. ${episodeNumber}) — ${scenes.length} scenes auto-approved`,
    );
    for (const scene of scenes) {
      const sceneNum = scene.scene_number;
      if (alreadyApproved.has(sceneNum)) continue;
      await updateScene(taskId, sceneNum, { script_approved: true });
    }
    console.log(`✅ Stage 2 complete (auto-mode) — ${scenes.length} scenes auto-approved.`);
    return;
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
            scene, scenes, feedback: decision.comment, concept,
          });
          scene.text = regenerated.text;
          scene.visual_description = regenerated.visual_description;
          if (regenerated.speaker) scene.speaker = regenerated.speaker;
          if (regenerated.emotion) scene.emotion = regenerated.emotion;
          // Update regenerated scene in DB
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

async function generateScript({ concept, targetClips }) {
  const systemPrompt = buildSystemPrompt({ concept, targetClips });

  const storyText = concept.outline || concept.synopsis || concept.title;
  const raw = await callGemini({
    system: systemPrompt,
    prompt: `Story:\n${storyText}`,
    maxTokens: 8192,
  });

  const parsed = parseClaudeJSON(raw, 'Stage 2 generateScript (Gemini)');

  return {
    scenes: parsed.scenes || parsed,
    youtube_seo: parsed.youtube_seo || null,
    character_descriptions: parsed.character_descriptions || null,
  };
}

function validateScenes(scenes, targetClips, videoType = 'short') {
  if (!Array.isArray(scenes)) throw new Error('scenes is not an array');
  if (scenes.length !== targetClips) {
    throw new Error(`Expected exactly ${targetClips} scenes, got ${scenes.length}`);
  }

  for (const scene of scenes) {
    if (!scene.scene_number) throw new Error(`Scene missing scene_number`);
    if (!scene.text) throw new Error(`Scene ${scene.scene_number} missing text`);
    if (!scene.visual_description) throw new Error(`Scene ${scene.scene_number} missing visual_description`);

    // Normalize speaker
    scene.speaker = (scene.speaker || 'narrator').toLowerCase();

    // Auto-fix invalid emotion
    const emotion = (scene.emotion || 'normal').toLowerCase();
    scene.emotion = VALID_EMOTIONS.has(emotion) ? emotion : 'normal';

    // Auto-fix characters array — fallback to [speaker] if missing
    if (!Array.isArray(scene.characters) || scene.characters.length === 0) {
      scene.characters = scene.speaker !== 'narrator' ? [scene.speaker] : [];
    } else {
      scene.characters = scene.characters.map(c => c.toLowerCase());
      // Ensure speaker is in their own scene's characters array
      if (scene.speaker !== 'narrator' && !scene.characters.includes(scene.speaker)) {
        scene.characters.push(scene.speaker);
      }
    }
  }
}

/**
 * Regenerate a single scene using Gemini, with surrounding scenes as context and user feedback.
 */
async function regenerateSingleScene({ scene, scenes, feedback, concept }) {
  const surroundingContext = scenes
    .filter(s => Math.abs(s.scene_number - scene.scene_number) <= 2)
    .map(s => `Scene ${s.scene_number} (${s.speaker}, ${s.emotion}): ${s.text}`)
    .join('\n');

  const system = `You are a Tamil children's story scriptwriter for @tinytamiltales.

STORY: "${concept.title}" — ${concept.synopsis || ''}

TASK: Regenerate ONLY scene ${scene.scene_number} based on the reviewer's feedback. Keep it consistent with surrounding scenes.

Tamil Script: Written in TANGLISH(modern spoken tamil with english words infused) with Tamil script letters, pure english words can be in english. extended dialogue should be 10s long.

Visual Description: A one-liner describing the scene in a 3D Pixar-style animation style.

Return ONLY valid JSON, no markdown fences:
{ "scene_number": ${scene.scene_number}, "speaker": "...", "emotion": "...", "text": "...", "english": "...", "visual_description": "...", "characters": ["..."] }`;

  const prompt = `Surrounding scenes:\n${surroundingContext}\n\nCurrent scene ${scene.scene_number}:\nSpeaker: ${scene.speaker} | Emotion: ${scene.emotion}\nText: ${scene.text}\nVisual: ${scene.visual_description}\n\nFeedback: ${feedback}\n\nRegenerate this scene.`;

  const raw = await callGemini({ system, prompt, maxTokens: 1024 });
  return parseClaudeJSON(raw, `Stage 2 regenerateScene ${scene.scene_number}`);
}
