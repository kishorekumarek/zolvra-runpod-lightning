// stages/stage-07-assemble.mjs — AI editor agent + ffmpeg assembly of final video
// Auto-stage — checks isFeedbackCollectionMode()
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode } from '../lib/settings.mjs';
import { createNexusCard } from '../lib/nexus-client.mjs';
import {
  getDurationSeconds,
  assembleSceneShots,
  assembleAllScenes,
} from '../lib/ffmpeg.mjs';
import { generateEditPlan } from '../lib/editor-agent.mjs';
import { submitKlingJob, pollKlingJob, downloadKlingVideo } from '../lib/kling.mjs';
import { getSignedUrl, BUCKETS } from '../lib/storage.mjs';

const STAGE = 7;

/**
 * Stage 7: AI Editor Agent + Video Assembly.
 * 1. Measure audio durations per scene
 * 2. Build sceneMeasurements and call generateEditPlan (AI shot planning + filler gen)
 * 3. Assemble shots per scene via xfade
 * 4. Assemble all scenes into final video
 * 5. Validate duration
 */
export async function runStage7(taskId, tracker, state = {}) {
  console.log('🎞️  Stage 7: AI Editor Agent + Video assembly...');

  const { script, sceneImagePaths, sceneAnimPaths, sceneAudioPaths, tmpDir, parentCardId } = state;
  if (!script) throw new Error('Stage 7: script not found');
  if (!tmpDir) throw new Error('Stage 7: tmpDir not found');

  const sb = getSupabase();
  const assemblyDir = join(tmpDir, 'assembly');
  await fs.mkdir(assemblyDir, { recursive: true });

  // 1. Measure audio durations and build sceneMeasurements
  const sceneMeasurements = [];

  for (const scene of script.scenes) {
    const sceneNum = scene.scene_number;
    const audioPath = sceneAudioPaths?.[sceneNum];
    if (!audioPath) {
      console.warn(`  ⚠️  No audio for scene ${sceneNum} — skipping`);
      continue;
    }

    const audioDuration = getDurationSeconds(audioPath);
    const animPath = sceneAnimPaths?.[sceneNum]?.animPath || null;
    const imagePath = sceneImagePaths?.[sceneNum]?.imagePath || null;

    let animDuration = 0;
    if (animPath) {
      try {
        animDuration = getDurationSeconds(animPath);
      } catch {
        console.warn(`  ⚠️  Could not measure anim duration for scene ${sceneNum}`);
      }
    }

    sceneMeasurements.push({
      sceneNumber: sceneNum,
      audioDuration,
      animDuration,
      animPath,
      imagePath,
      audioPath,
    });
  }

  if (sceneMeasurements.length === 0) {
    throw new Error('No scenes with audio found — cannot assemble');
  }

  console.log(`  📐 Measured ${sceneMeasurements.length} scenes`);

  // 1b. Generate additional Hailuo clips for scenes where Kling clip < audio
  const extraClipsDir = join(tmpDir, 'extra_clips');
  await fs.mkdir(extraClipsDir, { recursive: true });
  const sceneExtraClips = {};

  for (const m of sceneMeasurements) {
    if (!m.animPath) continue; // no anim — will use stills, skip extra clips

    // Use actual measured Kling clip duration, not hardcoded 10
    const existingClipDuration = m.animDuration || 10;  // animDuration was already measured from the file
    const remainingAudio = m.audioDuration - existingClipDuration;
    const additionalNeeded = remainingAudio > 0 ? Math.ceil(remainingAudio / 10) : 0;
    if (additionalNeeded <= 0) continue;

    const sceneNum = m.sceneNumber;
    const storagePath = sceneImagePaths?.[sceneNum]?.storagePath;
    if (!storagePath) {
      console.warn(`  ⚠️  No storage path for scene ${sceneNum} — skipping extra clips`);
      continue;
    }
    const imageUrl = await getSignedUrl({ bucket: BUCKETS.scenes, path: storagePath, expiresInSeconds: 3600 });

    const scene = script.scenes.find(s => s.scene_number === sceneNum);
    const visualDesc = scene?.visual_description || scene?.description || 'gentle animation, Tamil village';

    console.log(`  🎬 Scene ${sceneNum}: generating ${additionalNeeded} additional Hailuo clips to cover ${m.audioDuration.toFixed(1)}s audio`);

    const clips = [];
    for (let i = 0; i < additionalNeeded; i++) {
      try {
        const taskId = await submitKlingJob({
          imageUrl,
          prompt: visualDesc,
          motionParams: { duration: 10, mode: 'std' },
        });

        const videoUrl = await pollKlingJob(taskId);
        const videoBuffer = await downloadKlingVideo(videoUrl);

        const clipPath = join(extraClipsDir, `scene_${m.sceneNumber}_clip_${i}.mp4`);
        await fs.writeFile(clipPath, videoBuffer);

        tracker.addCost(7, 0.10);
        clips.push(clipPath);
        console.log(`    ✅ Extra clip ${i + 1}/${additionalNeeded} for scene ${m.sceneNumber}`);
      } catch (err) {
        console.warn(`    ⚠️  Extra clip ${i + 1} for scene ${m.sceneNumber} failed: ${err.message}`);
      }
    }

    if (clips.length > 0) {
      sceneExtraClips[m.sceneNumber] = clips;
    }
  }

  // 2. Generate edit plan via AI editor agent
  console.log('  🤖 Generating AI edit plan...');
  const edl = await generateEditPlan({ script, sceneMeasurements, sceneExtraClips, tmpDir });
  console.log(`  ✅ Edit plan: ${edl.scenes.length} scenes, ${edl.scenes.reduce((s, sc) => s + sc.shots.length, 0)} total shots`);

  // 3. Assemble shots per scene
  const scenePaths = [];

  for (const scene of edl.scenes) {
    const sceneLabel = String(scene.sceneNumber).padStart(2, '0');
    const sceneOutputPath = join(assemblyDir, `scene_${sceneLabel}_final.mp4`);

    console.log(`  🔧 Assembling scene ${scene.sceneNumber} (${scene.shots.length} shots)...`);

    await assembleSceneShots({
      shots: scene.shots.map(shot => ({
        sourcePath: shot.sourcePath,
        duration: shot.duration,
        transition: shot.transition || 'fade',
        transitionDuration: shot.transitionDuration || 0.5,
      })),
      outputPath: sceneOutputPath,
    });

    // Merge assembled video with scene audio (pad silence or trim to match video duration)
    const withAudioPath = join(assemblyDir, `scene_${sceneLabel}_with_audio.mp4`);
    const { execSync } = await import('child_process');

    const videoDur = getDurationSeconds(sceneOutputPath);
    const audioDur = getDurationSeconds(scene.audioPath);

    let mergeCmd;
    if (audioDur < videoDur) {
      // Audio shorter than video — pad with silence to match video duration
      mergeCmd = [
        `"/opt/homebrew/bin/ffmpeg" -y`,
        `-i "${sceneOutputPath}"`,
        `-i "${scene.audioPath}"`,
        `-filter_complex "[1:a]apad=whole_dur=${videoDur}[aout]"`,
        `-map 0:v -map "[aout]"`,
        `-c:v copy`,
        `-c:a aac -b:a 192k`,
        `-t ${videoDur}`,
        `"${withAudioPath}"`,
      ].join(' ');
    } else if (audioDur > videoDur) {
      // Audio longer than video — loop video to fill audio duration
      mergeCmd = [
        `"/opt/homebrew/bin/ffmpeg" -y`,
        `-stream_loop -1 -i "${sceneOutputPath}"`,
        `-i "${scene.audioPath}"`,
        `-map 0:v -map 1:a`,
        `-c:v libx264 -preset medium -crf 22`,
        `-c:a aac -b:a 192k`,
        `-t ${audioDur}`,
        `"${withAudioPath}"`,
      ].join(' ');
    } else {
      mergeCmd = [
        `"/opt/homebrew/bin/ffmpeg" -y`,
        `-i "${sceneOutputPath}"`,
        `-i "${scene.audioPath}"`,
        `-c:v copy`,
        `-c:a aac -b:a 192k`,
        `-shortest`,
        `"${withAudioPath}"`,
      ].join(' ');
    }

    execSync(mergeCmd, { stdio: 'pipe' });

    scenePaths.push({
      path: withAudioPath,
      transition: scene.sceneTransition || 'fade',
      transitionDuration: scene.sceneTransitionDuration || 0.5,
    });

    console.log(`  ✓ Scene ${scene.sceneNumber} assembled`);
  }

  if (scenePaths.length === 0) {
    throw new Error('No scenes were assembled — cannot create final video');
  }

  // 4. Assemble all scenes into final video
  const finalPath = join(assemblyDir, 'final.mp4');

  await assembleAllScenes({
    scenePaths,
    musicPath: null,
    outputPath: finalPath,
  });

  // 5. Validate duration
  const duration = getDurationSeconds(finalPath);
  const targetDuration = script.metadata?.target_duration_seconds || 300;
  const tolerance = 0.2;

  if (Math.abs(duration - targetDuration) / targetDuration > tolerance) {
    console.warn(
      `  ⚠️  Final video duration ${duration.toFixed(1)}s is outside ±${tolerance * 100}% of target ${targetDuration}s`
    );
  } else {
    console.log(`  ✓ Final video: ${duration.toFixed(1)}s (target: ${targetDuration}s)`);
  }

  // 6. Feedback collection mode — review assembled video
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
