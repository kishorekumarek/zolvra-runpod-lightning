// stages/stage-06-voice.mjs — ElevenLabs TTS per scene with v3 audio tag enhancement
// Enhances dialogue → per-scene approval loop → TTS generation
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode } from '../lib/settings.mjs';
import { withRetry } from '../lib/retry.mjs';
import { calcTTSCost } from '../lib/cost-tracker.mjs';
import { VOICE_MAP, V3_VOICE_SETTINGS } from '../lib/voice-config.mjs';
import { enhanceDialoguesForTTS, enhanceSingleDialogue } from '../lib/dialogue-enhancer.mjs';
import { sendApprovalBotMedia, sendTelegramMessageWithButtons, waitForTelegramResponse } from '../lib/telegram.mjs';
import { recordVoiceFeedback } from '../lib/feedback-engine.mjs';

const STAGE = 6;
const STAGE_ID = 'tts';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

/**
 * Call ElevenLabs TTS v3 — emotion is controlled via audio tags in the text,
 * NOT via voice_settings (which must be empty {}).
 * Returns a Buffer of the MP3.
 */
async function callElevenLabs({ text, voiceId }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

  const response = await fetch(
    `${ELEVENLABS_BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_v3',
        voice_settings: V3_VOICE_SETTINGS,  // Must be {} for v3
      }),
    }
  );

  if (!response.ok) {
    let errText;
    try {
      const errData = await response.json();
      errText = JSON.stringify(errData);
    } catch {
      errText = await response.text();
    }
    throw new Error(`ElevenLabs error (${response.status}): ${errText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Stage 6: Enhance dialogue with v3 tags → per-scene TTS + approval loop.
 *
 * Flow per scene:
 *   1. Enhance dialogue with v3 audio tags (batch Haiku call for all, then per-scene on redo)
 *   2. Generate TTS audio
 *   3. Send enhanced text + audio to Telegram for approval
 *   4. If denied → record feedback, apply modification, re-enhance, re-generate
 *   5. If approved → mark done, move to next scene
 *
 * Resume-safe: already-approved scenes (in state.approvedSceneAudio) are skipped.
 */
export async function runStage6(taskId, tracker, state = {}) {
  console.log('🎙️  Stage 6: Voice generation...');

  const { scenes, characterMap } = state;
  if (!scenes) throw new Error('Stage 6: scenes not found');
  let { tmpDir } = state;
  if (!tmpDir) {
    tmpDir = `/tmp/zolvra-pipeline/${taskId}`;
    console.log('  [Stage 6] Creating tmpDir:', tmpDir);
  }

  const sb = getSupabase();
  const audioDir = join(tmpDir, 'audio');
  await fs.mkdir(audioDir, { recursive: true });

  // Resume support: load previously approved scenes
  const approvedSceneAudio = state.approvedSceneAudio || {};
  const enhancedSceneTexts = state.enhancedSceneTexts || {};
  const sceneAudioPaths = state.sceneAudioPaths || {};
  let totalChars = 0;

  // Step 1: Batch enhance all scenes that haven't been enhanced yet
  const scenesToEnhance = scenes.filter(s => !enhancedSceneTexts[s.scene_number]);
  if (scenesToEnhance.length > 0) {
    console.log(`  Enhancing ${scenesToEnhance.length} scene dialogues for v3 TTS...`);
    const newEnhanced = await enhanceDialoguesForTTS(scenesToEnhance);
    Object.assign(enhancedSceneTexts, newEnhanced);
    console.log(`  ✓ ${Object.keys(newEnhanced).length} scenes enhanced with audio tags`);
  }

  const feedbackMode = await isFeedbackCollectionMode();

  // Step 2: Per-scene TTS generation + approval loop
  for (const scene of scenes) {
    const sceneNum = scene.scene_number;
    const sceneLabel = String(sceneNum).padStart(2, '0');

    // Skip already-approved scenes (resume support)
    if (approvedSceneAudio[sceneNum]?.approved) {
      console.log(`  Scene ${sceneNum}: already approved — skipping`);
      if (approvedSceneAudio[sceneNum].audioPath) {
        sceneAudioPaths[sceneNum] = approvedSceneAudio[sceneNum].audioPath;
      }
      continue;
    }

    // Look up voice: prefer characterVoiceMap (lightweight, survives restarts) →
    // fall back to characterMap DB voice_id → character_library table → VOICE_MAP → default narrator.
    // Skip PLACEHOLDER voice IDs (legacy characters not yet assigned).
    const { characterVoiceMap } = state;
    const lightweightVoiceId = characterVoiceMap?.[scene.speaker]
      ?? characterVoiceMap?.[scene.speaker?.toLowerCase()];
    const charEntry = characterMap?.[scene.speaker] ?? characterMap?.[scene.speaker?.toLowerCase()];
    const dbVoiceId = lightweightVoiceId || charEntry?.voice_id;

    // Resolve voice ID with character_library fallback (handles state loss on pipeline resume)
    let voiceId = (dbVoiceId && dbVoiceId !== 'PLACEHOLDER') ? dbVoiceId : null;
    if (!voiceId && scene.speaker && scene.speaker !== 'narrator') {
      const { data: charRow } = await sb
        .from('character_library')
        .select('voice_id')
        .ilike('name', scene.speaker)
        .limit(1)
        .single();
      if (charRow?.voice_id) {
        voiceId = charRow.voice_id;
        console.log(`  🔍 voice_id for "${scene.speaker}" resolved from character_library: ${voiceId}`);
      }
    }
    if (!voiceId) {
      console.warn(`  ⚠️  No voice_id for "${scene.speaker}" — using default narrator voice`);
      voiceId = VOICE_MAP[scene.speaker?.toLowerCase()] || VOICE_MAP.narrator || VOICE_MAP.default || Object.values(VOICE_MAP)[0];
    }
    let enhancedText = enhancedSceneTexts[sceneNum] || `[${scene.emotion}] ${scene.text}`;
    let approved = false;

    while (!approved) {
      console.log(`  Scene ${sceneNum}: speaker=${scene.speaker}, enhanced="${enhancedText.slice(0, 80)}..."`);

      // Generate TTS with enhanced text
      const audioBuffer = await withRetry(
        () => callElevenLabs({ text: enhancedText, voiceId }),
        { maxRetries: 3, baseDelayMs: 10000, stage: STAGE, taskId }
      );

      const audioPath = join(audioDir, `scene_${sceneLabel}_audio.mp3`);
      await fs.writeFile(audioPath, audioBuffer);
      sceneAudioPaths[sceneNum] = audioPath;
      totalChars += enhancedText.length;
      console.log(`  ✓ Scene ${sceneNum} TTS generated`);

      if (!feedbackMode) {
        // Auto-mode: no per-scene approval, just generate and move on
        approvedSceneAudio[sceneNum] = { audioPath, approved: true };
        enhancedSceneTexts[sceneNum] = enhancedText;
        approved = true;
        continue;
      }

      // Feedback collection mode: send for approval
      const caption = `Scene ${sceneNum} (${scene.speaker}, ${scene.emotion}): ${enhancedText.slice(0, 200)}`;
      await sendApprovalBotMedia({ filePath: audioPath, type: 'audio', caption });

      // Send approve/reject buttons via Telegram (prefixed callback)
      const callbackPrefix = `s6_${sceneNum}`;
      const telegramMessageId = await sendTelegramMessageWithButtons(
        `🎙️ Scene ${sceneNum}/${scenes.length} Voice Review\nApprove or reject with feedback (reply "text: ..." to replace dialogue)`,
        callbackPrefix
      );

      // Wait for response from Telegram
      const decision = await waitForTelegramResponse(telegramMessageId, callbackPrefix);

      if (decision.approved) {
        approvedSceneAudio[sceneNum] = { audioPath, approved: true };
        enhancedSceneTexts[sceneNum] = enhancedText;
        approved = true;
        console.log(`  ✓ Scene ${sceneNum} approved`);
      } else {
        // Denied — record feedback and handle modification
        console.log(`  ✗ Scene ${sceneNum} denied: ${decision.comment}`);

        await recordVoiceFeedback({
          videoId: taskId,
          sceneNumber: sceneNum,
          speaker: scene.speaker,
          comment: decision.comment,
          enhancedText,
        });

        // Check if the comment contains a dialogue replacement (support both stage-2 and stage-6 conventions)
        const dialogueMatch = decision.comment?.match(/(?:change (?:dialogue|text) to|^text:)[:\s]+["']?(.+?)["']?\s*$/i);
        if (dialogueMatch) {
          // User provided new dialogue text — re-enhance with new text (original scene.text preserved)
          const modifiedScene = { ...scene, text: dialogueMatch[1].trim() };
          enhancedText = await enhanceSingleDialogue(modifiedScene);
        } else {
          // User gave feedback about delivery — re-enhance with feedback context
          // Pass feedback as visual_description suffix so Haiku can see it in the prompt
          enhancedText = await enhanceSingleDialogue({
            ...scene,
            emotion: extractEmotionHint(decision.comment) || scene.emotion,
            visual_description: `${scene.visual_description || ''}. Voice feedback: ${decision.comment}`,
          });
        }
        enhancedSceneTexts[sceneNum] = enhancedText;
      }

      // Save intermediate state for resume safety
      await sb.from('video_pipeline_runs').upsert({
        task_id: taskId,
        stage_id: STAGE_ID,
        status: 'in_progress',
        pipeline_state: { ...state, enhancedSceneTexts, approvedSceneAudio, sceneAudioPaths },
      }, { onConflict: 'task_id,stage_id' });
    }
  }

  const cost = calcTTSCost(totalChars, 1);
  tracker.addCost(STAGE, cost);
  console.log(`  TTS total: ${totalChars} chars = $${cost.toFixed(4)}`);

  console.log(`✅ Stage 6 complete. ${Object.keys(sceneAudioPaths).length} scenes voiced`);
  return { ...state, sceneAudioPaths, enhancedSceneTexts, approvedSceneAudio };
}

/**
 * Try to extract an emotion hint from feedback comment.
 * e.g., "make it more excited" → "excited", "too flat" → "excited"
 */
function extractEmotionHint(comment) {
  if (!comment) return null;
  const lower = comment.toLowerCase();

  const emotionKeywords = {
    excited: ['excited', 'more energy', 'more energetic', 'enthusiastic'],
    happy: ['happy', 'happier', 'joyful', 'cheerful'],
    sad: ['sad', 'sadder', 'melancholy', 'somber'],
    scared: ['scared', 'frightened', 'fearful', 'terrified'],
    gentle: ['gentle', 'softer', 'calm', 'soothing'],
    whisper: ['whisper', 'quieter', 'softer voice'],
    angry: ['angry', 'angrier', 'fierce', 'intense'],
    surprised: ['surprised', 'shocked', 'astonished'],
  };

  for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
    if (keywords.some(kw => lower.includes(kw))) return emotion;
  }

  // "too flat" → default to excited for more expression
  if (lower.includes('flat') || lower.includes('monotone') || lower.includes('boring')) {
    return 'excited';
  }

  return null;
}
