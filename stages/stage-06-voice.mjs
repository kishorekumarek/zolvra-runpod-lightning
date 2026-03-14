// stages/stage-06-voice.mjs — ElevenLabs TTS per line, 2 takes, auto-select
// Auto-stage — checks isFeedbackCollectionMode()
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode, getAllSettings } from '../lib/settings.mjs';
import { createNexusCard } from '../lib/nexus-client.mjs';
import { generateSceneAudio } from '../lib/tts-takes.mjs';
import { concatAudioFiles } from '../lib/ffmpeg.mjs';
import { withRetry } from '../lib/retry.mjs';
import { calcTTSCost } from '../lib/cost-tracker.mjs';

const STAGE = 6;

/**
 * Stage 6: Generate voice audio for all lines in all scenes.
 * Uses 2 takes per line, auto-selects best (shorter).
 */
export async function runStage6(taskId, tracker, state = {}) {
  console.log('🎙️  Stage 6: Voice generation...');

  const { script, characterMap, tmpDir, parentCardId } = state;
  if (!script) throw new Error('Stage 6: script not found');
  if (!characterMap) throw new Error('Stage 6: characterMap not found');
  if (!tmpDir) throw new Error('Stage 6: tmpDir not found');

  const sb = getSupabase();
  const settings = await getAllSettings();

  const audioDir = join(tmpDir, 'audio');
  await fs.mkdir(audioDir, { recursive: true });

  const sceneAudioPaths = {}; // sceneNumber → concatenated audio path
  let totalChars = 0;

  for (const scene of script.scenes) {
    console.log(`  Processing scene ${scene.scene_number} audio...`);

    const lineAudioPaths = await withRetry(
      async () => {
        const lineAudios = await generateSceneAudio({
          scene,
          characterMap,
          settings,
        });

        const linePaths = [];
        for (const { buffer, lineIndex, text } of lineAudios) {
          const lineFile = join(
            audioDir,
            `scene_${String(scene.scene_number).padStart(2, '0')}_line_${String(lineIndex + 1).padStart(2, '0')}.mp3`
          );
          await fs.writeFile(lineFile, buffer);
          linePaths.push(lineFile);
          totalChars += text.length;
        }

        return linePaths;
      },
      { maxRetries: 3, baseDelayMs: 10000, stage: STAGE, taskId }
    );

    // Concatenate all lines in the scene into one audio file
    const sceneAudioPath = join(audioDir, `scene_${String(scene.scene_number).padStart(2, '0')}_combined.mp3`);
    await concatAudioFiles(lineAudioPaths, sceneAudioPath);
    sceneAudioPaths[scene.scene_number] = sceneAudioPath;
  }

  // Track cost (2 takes per segment)
  const cost = calcTTSCost(totalChars, 2);
  tracker.addCost(STAGE, cost);
  console.log(`  TTS total: ${totalChars} chars × 2 takes = $${cost.toFixed(4)}`);

  // Feedback collection mode — review audio
  if (await isFeedbackCollectionMode()) {
    await feedbackReviewAudio({ taskId, sceneAudioPaths, parentCardId, sb });
  }

  console.log(`✅ Stage 6 complete. ${Object.keys(sceneAudioPaths).length} scenes voiced`);
  return { ...state, sceneAudioPaths };
}

async function feedbackReviewAudio({ taskId, sceneAudioPaths, parentCardId, sb }) {
  console.log('  📋 Feedback collection mode: requesting audio review...');

  const pathList = Object.entries(sceneAudioPaths)
    .map(([n, path]) => `Scene ${n}: ${path}`)
    .join('\n');

  const cardId = await createNexusCard({
    title: `[Feedback] Stage 6: Voice Audio Review`,
    description: [
      `Feedback collection mode: Please review the Tamil voice audio for all scenes.`,
      `\n**Audio files (local paths):**\n${pathList}`,
      `\nApprove to continue, or Request Changes with specific feedback (e.g., "too fast", "wrong emotion for scene 3").`,
    ].join('\n'),
    task_type: 'stage_review',
    priority: 'medium',
    parent_id: parentCardId,
    stream: 'youtube',
  });

  console.log(`  NEXUS audio review card created: ${cardId} (non-blocking)`);
}
