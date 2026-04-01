// stages/stage-06-voice.mjs — ElevenLabs TTS per scene with v3 audio tag enhancement
// REWRITTEN for pipeline schema rewrite: reads from DB, uploads audio to storage, writes to scenes table.
// Dual-write: also returns old sceneAudioPaths for un-rewritten Stage 7.
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
import { uploadSceneAudio } from '../lib/storage.mjs';
import {
  getScenes, getEpisodeCharacter, updateScene,
} from '../lib/pipeline-db.mjs';

const STAGE = 6;
const STAGE_ID = 'tts';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

/**
 * Call ElevenLabs TTS v3.
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
        voice_settings: V3_VOICE_SETTINGS,
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
 * NEW: reads scenes + episode_characters from DB, uploads audio to storage,
 * writes audio_url/enhanced_text/audio_status to scenes table.
 * Writes audio_url/enhanced_text/audio_status/audio_approved to scenes table.
 */
export async function runStage6(taskId, tracker, state = {}) {
  console.log('🎙️  Stage 6: Voice generation...');

  const sb = getSupabase();

  // ── Read scenes from DB ────────────────────────────────────────────
  const allScenes = await getScenes(taskId);
  if (!allScenes || allScenes.length === 0) throw new Error('Stage 6: no scenes found in DB');

  // Filter to scenes that still need audio
  const scenesNeedingAudio = allScenes.filter(s => s.audio_status !== 'completed');
  const scenesAlreadyDone = allScenes.filter(s => s.audio_status === 'completed');

  if (scenesAlreadyDone.length > 0) {
    console.log(`  ↩️  Resume: ${scenesAlreadyDone.length} scenes already have audio — skipping`);
  }

  let tmpDir = state.tmpDir;
  if (!tmpDir) {
    tmpDir = `/tmp/zolvra-pipeline/${taskId}`;
  }
  const audioDir = join(tmpDir, 'audio');
  await fs.mkdir(audioDir, { recursive: true });

  const sceneAudioPaths = {}; // local paths for within-run use only
  const enhancedSceneTexts = {};
  const approvedSceneAudio = {};
  let totalChars = 0;

  // Pre-populate dual-write maps from already-completed scenes
  for (const s of scenesAlreadyDone) {
    approvedSceneAudio[s.scene_number] = { approved: true };
    if (s.enhanced_text) enhancedSceneTexts[s.scene_number] = s.enhanced_text;
  }

  // Step 1: Batch enhance all scenes that need audio
  if (scenesNeedingAudio.length > 0) {
    console.log(`  Enhancing ${scenesNeedingAudio.length} scene dialogues for v3 TTS...`);
    const newEnhanced = await enhanceDialoguesForTTS(scenesNeedingAudio);
    Object.assign(enhancedSceneTexts, newEnhanced);
    console.log(`  ✓ ${Object.keys(newEnhanced).length} scenes enhanced with audio tags`);
  }

  const feedbackMode = await isFeedbackCollectionMode();

  // Step 2: Per-scene TTS generation + approval loop
  for (const scene of allScenes) {
    const sceneNum = scene.scene_number;
    const sceneLabel = String(sceneNum).padStart(2, '0');

    // Skip already-completed scenes (resume support — from DB)
    if (scene.audio_status === 'completed') {
      // Ensure local file exists for dual-write
      if (scene.audio_url && !sceneAudioPaths[sceneNum]) {
        const audioPath = join(audioDir, `scene_${sceneLabel}_audio.mp3`);
        sceneAudioPaths[sceneNum] = audioPath;
      }
      continue;
    }

    // ── Resolve voice ID ─────────────────────────────────────────────
    // Priority: episode_characters → character_library → VOICE_MAP → default
    let voiceId = null;

    // Try episode_characters first (new table)
    const epChar = await getEpisodeCharacter(taskId, scene.speaker);
    if (epChar?.voice_id && epChar.voice_id !== 'PLACEHOLDER') {
      voiceId = epChar.voice_id;
    }

    // Fallback: character_library
    if (!voiceId && scene.speaker && scene.speaker !== 'narrator') {
      const { data: charRow } = await sb
        .from('character_library')
        .select('voice_id')
        .ilike('name', scene.speaker)
        .limit(1)
        .maybeSingle();
      if (charRow?.voice_id && charRow.voice_id !== 'PLACEHOLDER') {
        voiceId = charRow.voice_id;
        console.log(`  🔍 voice_id for "${scene.speaker}" resolved from character_library: ${voiceId}`);
      }
    }

    // Fallback: hardcoded VOICE_MAP
    if (!voiceId) {
      voiceId = VOICE_MAP[scene.speaker?.toLowerCase()] || VOICE_MAP.narrator || VOICE_MAP.default || Object.values(VOICE_MAP)[0];
      if (!voiceId) {
        console.warn(`  ⚠️  No voice_id for "${scene.speaker}" — cannot generate TTS`);
        await updateScene(taskId, sceneNum, { audio_status: 'failed' });
        continue;
      }
    }

    let enhancedText = enhancedSceneTexts[sceneNum] || `[${scene.emotion}] ${scene.text}`;
    let approved = false;

    while (!approved) {
      console.log(`  Scene ${sceneNum}: speaker=${scene.speaker}, enhanced="${enhancedText.slice(0, 80)}..."`);

      // Generate TTS
      const audioBuffer = await withRetry(
        () => callElevenLabs({ text: enhancedText, voiceId }),
        { maxRetries: 3, baseDelayMs: 10000, stage: STAGE, taskId }
      );

      const audioPath = join(audioDir, `scene_${sceneLabel}_audio.mp3`);
      await fs.writeFile(audioPath, audioBuffer);
      totalChars += enhancedText.length;
      console.log(`  ✓ Scene ${sceneNum} TTS generated`);

      // NEW: upload audio to Supabase Storage
      let audioUrl = null;
      try {
        audioUrl = await uploadSceneAudio({ videoId: taskId, sceneNumber: sceneNum, buffer: audioBuffer });
        console.log(`  ✓ Scene ${sceneNum} audio uploaded to storage`);
      } catch (uploadErr) {
        console.warn(`  ⚠️  Scene ${sceneNum} audio upload failed (non-fatal): ${uploadErr.message}`);
      }

      if (!feedbackMode) {
        // Auto-mode: no approval, mark done
        await updateScene(taskId, sceneNum, {
          audio_url: audioUrl,
          enhanced_text: enhancedText,
          audio_status: 'completed',
          audio_approved: true,
        });
        sceneAudioPaths[sceneNum] = audioPath;
        approvedSceneAudio[sceneNum] = { audioPath, approved: true };
        enhancedSceneTexts[sceneNum] = enhancedText;
        approved = true;
        continue;
      }

      // Feedback mode: send for approval
      const caption = `Scene ${sceneNum} (${scene.speaker}, ${scene.emotion}): ${enhancedText.slice(0, 200)}`;
      await sendApprovalBotMedia({ filePath: audioPath, type: 'audio', caption });

      const callbackPrefix = `s6_${sceneNum}`;
      const telegramMessageId = await sendTelegramMessageWithButtons(
        `🎙️ Scene ${sceneNum}/${allScenes.length} Voice Review\nApprove or reject with feedback (reply "text: ..." to replace dialogue)`,
        callbackPrefix
      );

      const decision = await waitForTelegramResponse(telegramMessageId, callbackPrefix);

      if (decision.approved) {
        // NEW: update scenes table
        await updateScene(taskId, sceneNum, {
          audio_url: audioUrl,
          enhanced_text: enhancedText,
          audio_status: 'completed',
          audio_approved: true,
        });
        sceneAudioPaths[sceneNum] = audioPath;
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

        const dialogueMatch = decision.comment?.match(/(?:change (?:dialogue|text) to|^text:)[:\s]+["']?(.+?)["']?\s*$/i);
        if (dialogueMatch) {
          const modifiedScene = { ...scene, text: dialogueMatch[1].trim() };
          enhancedText = await enhanceSingleDialogue(modifiedScene);
          // Also update the scene text in DB
          await updateScene(taskId, sceneNum, { text: modifiedScene.text });
        } else {
          enhancedText = await enhanceSingleDialogue({
            ...scene,
            emotion: extractEmotionHint(decision.comment) || scene.emotion,
            visual_description: `${scene.visual_description || ''}. Voice feedback: ${decision.comment}`,
          });
        }
        enhancedSceneTexts[sceneNum] = enhancedText;
      }
    }
  }

  const cost = calcTTSCost(totalChars, 1);
  tracker.addCost(STAGE, cost);
  console.log(`  TTS total: ${totalChars} chars = $${cost.toFixed(4)}`);

  console.log(`✅ Stage 6 complete. ${Object.keys(sceneAudioPaths).length} scenes voiced`);

}

/**
 * Try to extract an emotion hint from feedback comment.
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

  if (lower.includes('flat') || lower.includes('monotone') || lower.includes('boring')) {
    return 'excited';
  }

  return null;
}
