// stages/stage-07-assemble.mjs — Simple 1:1 scene assembly (clip + audio → final)
// Auto-stage — checks isFeedbackCollectionMode()
import 'dotenv/config';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode } from '../lib/settings.mjs';
import { createNexusCard } from '../lib/nexus-client.mjs';
import {
  getDurationSeconds,
  assembleVideo,
  stillImageToVideo,
} from '../lib/ffmpeg.mjs';

const STAGE = 7;
const FFMPEG = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';

/**
 * Merge a video clip with audio, trimming/looping the clip to match audio duration.
 */
function mergeClipWithAudio({ clipPath, audioPath, audioDuration, outputPath }) {
  // stream_loop -1 allows the clip to loop if shorter than audio;
  // -t audioDuration trims if longer. Re-encode video so stream_loop works.
  const cmd = [
    `"${FFMPEG}" -y`,
    `-stream_loop -1 -i "${clipPath}"`,
    `-i "${audioPath}"`,
    `-t ${audioDuration}`,
    `-map 0:v -map 1:a`,
    `-c:v libx264 -preset fast -crf 22`,
    `-c:a aac -b:a 192k`,
    `"${outputPath}"`,
  ].join(' ');
  execSync(cmd, { stdio: 'pipe' });
}

/**
 * Stage 7: Simple paired assembly.
 * For each scene N: clip + audio → scene_N_final.mp4 (trimmed to audio duration).
 * Then concat all scene finals → final.mp4.
 */
export async function runStage7(taskId, tracker, state = {}) {
  console.log('🎞️  Stage 7: Video assembly...');

  const { scenes, sceneImagePaths, sceneAnimPaths, sceneAudioPaths, tmpDir, parentCardId } = state;
  if (!scenes) throw new Error('Stage 7: scenes not found');
  if (!tmpDir) throw new Error('Stage 7: tmpDir not found');

  const sb = getSupabase();
  const assemblyDir = join(tmpDir, 'assembly');
  await fs.mkdir(assemblyDir, { recursive: true });

  const sceneFinalPaths = []; // ordered list of assembled scene paths

  for (const scene of scenes) {
    const sceneNum = scene.scene_number;
    const sceneLabel = String(sceneNum).padStart(2, '0');

    const audioPath = sceneAudioPaths?.[sceneNum];
    if (!audioPath) {
      console.warn(`  ⚠️  No audio for scene ${sceneNum} — skipping`);
      continue;
    }

    const audioDuration = getDurationSeconds(audioPath);
    const animPath = sceneAnimPaths?.[sceneNum]?.animPath ?? null;
    const imagePath = sceneImagePaths?.[sceneNum]?.imagePath ?? null;

    const finalPath = join(assemblyDir, `scene_${sceneLabel}_final.mp4`);

    if (animPath) {
      // Merge animation clip with audio (loop clip if needed to fill audio duration)
      console.log(`  🔧 Scene ${sceneNum}: merging clip + audio (${audioDuration.toFixed(1)}s)...`);
      mergeClipWithAudio({ clipPath: animPath, audioPath, audioDuration, outputPath: finalPath });
    } else if (imagePath) {
      // No animation — use still image + audio (zoompan)
      console.log(`  🖼️  Scene ${sceneNum}: still image + audio (${audioDuration.toFixed(1)}s)...`);
      await stillImageToVideo({ imagePath, audioPath, outputPath: finalPath });
    } else {
      console.warn(`  ⚠️  Scene ${sceneNum}: no clip or image — skipping`);
      continue;
    }

    sceneFinalPaths.push(finalPath);
    console.log(`  ✓ Scene ${sceneNum} assembled`);
  }

  if (sceneFinalPaths.length === 0) {
    throw new Error('No scenes were assembled — cannot create final video');
  }

  // Concatenate all scene finals into one video
  console.log(`  📼 Concatenating ${sceneFinalPaths.length} scenes into final video...`);
  const finalPath = join(assemblyDir, 'final.mp4');

  await assembleVideo({
    sceneCombinedPaths: sceneFinalPaths,
    musicPath: null,
    outputPath: finalPath,
  });

  const duration = getDurationSeconds(finalPath);
  console.log(`  ✓ Final video: ${duration.toFixed(1)}s`);

  // Feedback collection mode — review assembled video
  if (await isFeedbackCollectionMode()) {
    await feedbackReviewAssembly({ taskId, finalPath, duration, parentCardId, sb });
  }

  console.log(`✅ Stage 7 complete. Final video: ${finalPath}`);
  return { ...state, finalVideoPath: finalPath, finalDurationSeconds: duration };
}

async function feedbackReviewAssembly({ taskId, finalPath, duration, parentCardId, sb }) {
  console.log('  📋 Feedback collection mode: requesting assembly review...');

  const cardId = await createNexusCard({
    title: `[Feedback] Stage 7: Assembled Video Review`,
    description: [
      `Feedback collection mode: Please review the assembled video before upload.`,
      `\n**File:** ${finalPath}`,
      `**Duration:** ${duration.toFixed(1)}s`,
      `\nApprove to upload to YouTube (unlisted), or Request Changes.`,
    ].join('\n'),
    task_type: 'stage_review',
    priority: 'medium',
    parent_id: parentCardId,
    stream: 'youtube',
  });

  console.log(`  NEXUS assembly review card created: ${cardId} (non-blocking)`);
}
