// lib/editor-agent.mjs — AI-driven video edit plan generator
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import { join } from 'path';
import { generateSceneImage } from './image-gen.mjs';
import { submitKlingJob, pollKlingJob, downloadKlingVideo } from './kling.mjs';
import { getSupabase } from './supabase.mjs';
import { stillImageToVideo } from './ffmpeg.mjs';
import { withRateLimit } from './claude-rate-limiter.mjs';

const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Generate an Edit Decision List (EDL) for the video.
 * STEP 1: Use Claude to plan shots per scene.
 * STEP 2: Execute filler generation (Imagen + Kling or still).
 * Returns resolved EDL with all sourcePaths pointing to real files.
 */
export async function generateEditPlan({ script, sceneMeasurements, sceneExtraClips = {}, tmpDir }) {
  const client = new Anthropic();

  // STEP 1 — Generate shot plans per scene via Claude
  const edl = { scenes: [] };

  for (const measurement of sceneMeasurements) {
    const scene = script.scenes.find(s => s.scene_number === measurement.sceneNumber);
    if (!scene) continue;

    const extraClips = sceneExtraClips[measurement.sceneNumber] || [];

    if (edl.scenes.length > 0) {
      // 2s delay between per-scene Claude calls to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));
    }

    const shotPlan = await generateShotPlan({
      client,
      scene,
      measurement,
      extraClips,
    });

    edl.scenes.push({
      sceneNumber: measurement.sceneNumber,
      audioPath: measurement.audioPath,
      audioDuration: measurement.audioDuration,
      shots: shotPlan,
      sceneTransition: 'fade',
      sceneTransitionDuration: 0.5,
      measurement, // carry measurement for fallback access in executeFillers
    });
  }

  // STEP 2 — Execute filler/still generation
  await executeFillers({ edl, tmpDir });

  // STEP 3 — Strip shots with invalid sourcePaths (e.g. 'none', null, undefined)
  for (const scene of edl.scenes) {
    scene.shots = scene.shots.filter(shot => {
      if (!shot.sourcePath || shot.sourcePath === 'none') {
        console.warn(`  ⚠️  Scene ${scene.sceneNumber}: dropping shot with invalid sourcePath: ${shot.sourcePath}`);
        return false;
      }
      return true;
    });
  }

  return edl;
}

/**
 * Call Claude to generate a shot list for a single scene.
 * Retries up to 3 times on invalid JSON.
 */
async function generateShotPlan({ client, scene, measurement, extraClips = [] }) {
  const { sceneNumber, audioDuration, animDuration, animPath, imagePath } = measurement;

  const sceneType = scene.type || 'narration';
  const sceneDesc = scene.description || scene.visual_description || '';

  // Build extra clips description for the prompt
  let extraClipsInfo = '';
  if (extraClips.length > 0) {
    const clipList = extraClips.map((p, i) => `  clip ${i + 1}: "${p}" (~10s)`).join('\n');
    extraClipsInfo = `\n- "animation" (extra): additional pre-rendered Hailuo clips available for this scene (~10s each). Use these AFTER the primary animation clip to fill remaining audio duration:\n${clipList}\n- When extra clips are available, prefer using them over fillers to maintain visual consistency`;
  }

  const systemPrompt = `You are a video editor planning shots for a children's animated Tamil village story.
You will receive scene details and must return a JSON array of shots that cover the full audio duration.

Rules:
- Shots must cover exactly ${audioDuration.toFixed(1)} seconds total duration
- No two consecutive animation shots — always place a filler between animations
- For action scenes: max 1 animation shot, the rest must be fillers
- For dialogue/narration scenes: max 2 animation shots with fillers between them
- Filler shots should have Tamil village story context: peacock in village, forest path, children playing, village temple, paddy fields, river bank
- Set animate:true for energetic/action scenes, animate:false for calm/dialogue scenes
- Each shot duration must be between 3 and 12 seconds
- When extra Hailuo clips are available, use them as "animation" type shots (with their sourcePath) before resorting to fillers. Use the primary animation clip first, then extra clips in order.
- Return ONLY a valid JSON array, no other text

Shot types:
- "animation": uses the pre-rendered scene animation (duration ~${animDuration.toFixed(1)}s). ${animPath ? 'Set sourcePath to "' + animPath + '"' : 'This shot has no pre-rendered animation. Use type "still" instead and set sourcePath to the scene base image.'}${extraClipsInfo}
- "filler": a new image generated to fill time. Provide an imagenPrompt describing the filler visual
${imagePath ? `- "still": uses the scene's base image as a static shot. Set sourcePath to "${imagePath}"` : ''}

Each shot object: { "type": string, "sourcePath": string|null, "imagenPrompt": string|null, "duration": number, "animate": boolean, "transition": "fade"|"dissolve"|"wipeleft"|"slideleft", "transitionDuration": number (0.3-0.8) }`;

  const extraClipsNote = extraClips.length > 0
    ? `Extra Hailuo clips available: ${extraClips.length} (each ~10s)\n`
    : '';

  const userPrompt = `Scene ${sceneNumber} (${sceneType}): "${sceneDesc}"
Audio duration: ${audioDuration.toFixed(1)}s
Animation duration: ${animDuration.toFixed(1)}s
Has animation: ${!!animPath}
Has base image: ${!!imagePath}
${extraClipsNote}
Return the shot list as a JSON array.`;

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await withRateLimit(() => client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }));

      const text = response.content[0]?.text || '';
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array found in response');

      const shots = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(shots) || shots.length === 0) {
        throw new Error('Empty or invalid shots array');
      }

      // Validate total duration
      const totalDuration = shots.reduce((sum, s) => sum + s.duration, 0);
      if (Math.abs(totalDuration - audioDuration) > 1.0) {
        console.warn(`  ⚠️  Scene ${sceneNumber}: shot total ${totalDuration.toFixed(1)}s vs audio ${audioDuration.toFixed(1)}s — adjusting last shot`);
        const diff = audioDuration - totalDuration;
        shots[shots.length - 1].duration += diff;
      }

      console.log(`  🎬 Scene ${sceneNumber}: ${shots.length} shots planned`);
      return shots;
    } catch (err) {
      lastError = err;
      console.warn(`  ⚠️  Scene ${sceneNumber} shot plan attempt ${attempt + 1}/3 failed: ${err.message}`);
    }
  }

  throw new Error(`Failed to generate shot plan for scene ${sceneNumber} after 3 attempts: ${lastError.message}`);
}

/**
 * Execute all filler and still shot generation across the EDL.
 * - filler + animate:true  → Imagen → Supabase → Kling → mp4
 * - filler + animate:false → Imagen → stillImageToVideo → mp4
 * - still                  → stillImageToVideo using scene base image → mp4
 * - animation              → sourcePath already set
 *
 * Kling jobs run in parallel batches of 3. Failed Kling falls back to still.
 */
async function executeFillers({ edl, tmpDir }) {
  const fillersDir = join(tmpDir, 'fillers');
  await fs.mkdir(fillersDir, { recursive: true });

  // Collect all jobs that need Kling animation
  const klingJobs = [];
  // Collect all jobs that need still/static generation
  const staticJobs = [];

  for (const scene of edl.scenes) {
    const measurement = scene.measurement || {};
    for (let i = 0; i < scene.shots.length; i++) {
      const shot = scene.shots[i];

      if (shot.type === 'animation') {
        // Already has sourcePath — nothing to do
        continue;
      }

      if (shot.type === 'filler' && shot.animate) {
        klingJobs.push({ scene, shotIndex: i, shot, measurement });
      } else {
        // filler + !animate, or still
        staticJobs.push({ scene, shotIndex: i, shot, measurement });
      }
    }
  }

  // Execute static jobs (Imagen → stillImageToVideo)
  for (const { scene, shotIndex, shot, measurement } of staticJobs) {
    const label = `s${scene.sceneNumber}_shot${shotIndex}`;
    console.log(`  🖼️  Generating static filler: ${label}`);

    try {
      const outputPath = join(fillersDir, `${label}.mp4`);

      if (shot.type === 'still') {
        // Use existing scene image — fall back to scene base image if shot.sourcePath is missing
        const stillImg = (shot.sourcePath && shot.sourcePath !== 'none') ? shot.sourcePath : measurement.imagePath;
        if (!stillImg) {
          console.warn(`  ⚠️  No image available for still shot ${label} — skipping`);
          continue;
        }
        await stillImageToVideo({
          imagePath: stillImg,
          duration: shot.duration,
          outputPath,
        });
      } else {
        // Generate new image via Imagen
        const imgBuffer = await generateSceneImage({
          prompt: shot.imagenPrompt || 'Tamil village scene, children animated style',
        });
        const imgPath = join(fillersDir, `${label}.png`);
        await fs.writeFile(imgPath, imgBuffer);

        await stillImageToVideo({
          imagePath: imgPath,
          duration: shot.duration,
          outputPath,
        });
      }

      shot.sourcePath = outputPath;
    } catch (err) {
      // On quota/rate limit, fall back to the scene's existing illustration
      if (err.message?.includes('429') || err.message?.includes('quota') || err.message?.includes('exceeded')) {
        console.warn(`  ⚠️  Imagen quota hit for ${label} — using scene image as fallback`);
        const sceneMeasurement = scene.measurement || {};
        const fallbackImg = sceneMeasurement.imagePath;
        if (fallbackImg) {
          const outputPath = join(fillersDir, `${label}_quotafallback.mp4`);
          await stillImageToVideo({ imagePath: fallbackImg, duration: shot.duration, outputPath });
          shot.sourcePath = outputPath;
        } else if (sceneMeasurement.animPath) {
          // Last resort: use animation clip
          shot.sourcePath = sceneMeasurement.animPath;
        } else {
          console.warn(`  ⚠️  No fallback image or anim for ${label} — shot will be skipped`);
        }
      } else {
        console.error(`  ❌ Static filler ${label} failed: ${err.message}`);
        throw err;
      }
    }
  }

  // Execute Kling jobs in batches of 3
  const sb = getSupabase();
  for (let batchStart = 0; batchStart < klingJobs.length; batchStart += 3) {
    const batch = klingJobs.slice(batchStart, batchStart + 3);

    const results = await Promise.allSettled(
      batch.map(({ scene, shotIndex, shot }) =>
        executeKlingFiller({ scene, shotIndex, shot, fillersDir, sb })
      )
    );

    // Handle failures — fall back to still image
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const { scene, shotIndex, shot } = batch[i];
        const label = `s${scene.sceneNumber}_shot${shotIndex}`;
        console.warn(`  ⚠️  Kling filler ${label} failed, falling back to still: ${results[i].reason?.message}`);

        try {
          const outputPath = join(fillersDir, `${label}_fallback.mp4`);
          // If quota exceeded, skip Imagen and use scene's existing image directly
          const isQuota = results[i].reason?.message?.includes('429') ||
                          results[i].reason?.message?.includes('quota') ||
                          results[i].reason?.message?.includes('exceeded');
          let imgPath;
          if (isQuota) {
            console.warn(`  ⚠️  Quota fallback for ${label} — using scene image`);
            imgPath = batch[i].measurement?.imagePath || scene.shots.find(s => s.type === 'still')?.sourcePath;
          }
          if (!imgPath) {
            const imgBuffer = await generateSceneImage({
              prompt: shot.imagenPrompt || 'Tamil village scene, children animated style',
            });
            imgPath = join(fillersDir, `${label}_fallback.png`);
            await fs.writeFile(imgPath, imgBuffer);
          }

          if (!imgPath) {
            console.warn(`  ⚠️  No fallback image for ${label} — using anim clip`);
            shot.sourcePath = shot.sourcePath || batch[i].measurement?.animPath;
          } else {
            await stillImageToVideo({ imagePath: imgPath, duration: shot.duration, outputPath });
            shot.sourcePath = outputPath;
          }
        } catch (fallbackErr) {
          console.error(`  ❌ Fallback also failed for ${label}: ${fallbackErr.message}`);
          // Last resort: reuse the animation clip
          shot.sourcePath = shot.sourcePath || batch[i].measurement?.animPath;
        }
      }
    }
  }
}

/**
 * Generate a single Kling-animated filler shot.
 * Imagen → upload to Supabase → Kling animate → download mp4.
 */
async function executeKlingFiller({ scene, shotIndex, shot, fillersDir, sb }) {
  const label = `s${scene.sceneNumber}_shot${shotIndex}`;
  console.log(`  🎬 Generating animated filler: ${label}`);

  // 1. Generate image via Imagen
  const imgBuffer = await generateSceneImage({
    prompt: shot.imagenPrompt || 'Tamil village scene, children animated style',
  });
  const imgPath = join(fillersDir, `${label}.png`);
  await fs.writeFile(imgPath, imgBuffer);

  // 2. Upload to Supabase storage for Kling access
  const storagePath = `fillers/${label}_${Date.now()}.png`;
  const { error: uploadError } = await sb.storage
    .from('scenes')
    .upload(storagePath, imgBuffer, { contentType: 'image/png', upsert: true });

  if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

  const { data: signedUrlData, error: urlError } = await sb.storage
    .from('scenes')
    .createSignedUrl(storagePath, 3600);

  if (urlError) throw new Error(`Supabase signed URL failed: ${urlError.message}`);

  const imageUrl = signedUrlData.signedUrl;

  // 3. Submit to Kling and poll
  const taskId = await submitKlingJob({
    imageUrl,
    prompt: shot.imagenPrompt || 'gentle animation, Tamil village',
    motionParams: { duration: 5, mode: 'std' },
  });

  const videoUrl = await pollKlingJob(taskId);

  // 4. Download and save mp4
  const videoBuffer = await downloadKlingVideo(videoUrl);
  const outputPath = join(fillersDir, `${label}.mp4`);
  await fs.writeFile(outputPath, videoBuffer);

  shot.sourcePath = outputPath;
  console.log(`  ✅ Animated filler complete: ${label}`);
}
