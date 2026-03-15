// stages/stage-04-illustrate.mjs — Scene image generation via Google AI Imagen
// Auto-stage — checks isFeedbackCollectionMode()
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import { isFeedbackCollectionMode, getVideoType } from '../lib/settings.mjs';
import { createNexusCard } from '../lib/nexus-client.mjs';
import { generateSceneImage, buildScenePrompt, estimateImageCost } from '../lib/image-gen.mjs';
import { uploadSceneImage, getSceneImageUrl, BUCKETS } from '../lib/storage.mjs';
import { createTmpDir } from '../lib/ffmpeg.mjs';
import { withRetry } from '../lib/retry.mjs';
import { calcImageCost } from '../lib/cost-tracker.mjs';

const STAGE = 4;
const MAX_SCENE_FAILURES = 5;

/**
 * Stage 4: Generate one image per scene.
 * Handles partial failures gracefully (up to MAX_SCENE_FAILURES).
 */
export async function runStage4(taskId, tracker, state = {}) {
  console.log('🎨 Stage 4: Scene illustration...');

  const videoType = state.videoType ?? await getVideoType(); // 'long' | 'short'
  const aspectRatio = videoType === 'short' ? '9:16' : '16:9';
  console.log(`  video_type=${videoType}, aspectRatio=${aspectRatio}`);

  let { scenes, parentCardId } = state;
  // Prefer characterMap with reference image buffers if available
  const characterMap = state.characterMapWithImages ?? state.characterMap;

  if (!scenes) {
    // Fallback: load from the most recent stage-2 run for this task
    console.log('  ℹ️  scenes not in current state, loading from stage 2...');
    const sb2 = getSupabase();
    const { data: stage2Row } = await sb2
      .from('video_pipeline_runs')
      .select('pipeline_state')
      .eq('task_id', taskId)
      .eq('stage', 2)
      .order('started_at', { ascending: false })
      .limit(1)
      .single();
    const ps = stage2Row?.pipeline_state;
    // Support new format (ps.scenes) and legacy format (ps.script.scenes)
    scenes = ps?.scenes || ps?.script?.scenes;
  }

  if (!scenes) throw new Error('Stage 4: scenes not found in pipeline state or stage 2 history');
  if (!characterMap) throw new Error('Stage 4: characterMap not found in pipeline state');

  const sb = getSupabase();
  const tmpDir = await createTmpDir(taskId);
  const sceneImagePaths = {};

  // Check which scenes already have completed assets (resume-safe)
  const { data: existingAssets } = await sb.from('scene_assets')
    .select('scene_number')
    .eq('video_id', taskId)
    .eq('status', 'completed');
  const doneScenes = new Set((existingAssets || []).map(a => a.scene_number));
  if (doneScenes.size > 0) {
    console.log(`  ↩️  Skipping ${doneScenes.size} already-illustrated scenes: ${[...doneScenes].join(', ')}`);
  }

  // Sequential with 7s delay to stay within Imagen 10 req/min quota
  const results = [];
  for (const scene of scenes) {
    if (doneScenes.has(scene.scene_number)) {
      const { data: asset } = await sb.from('scene_assets')
        .select('image_url')
        .eq('video_id', taskId)
        .eq('scene_number', scene.scene_number)
        .single();
      results.push({ status: 'fulfilled', value: { scene, imagePath: null, storagePath: asset?.image_url }, scene });
      continue;
    }
    const result = await illustrateScene({ taskId, scene, characterMap, tmpDir, tracker, aspectRatio })
      .then(val => ({ status: 'fulfilled', value: val, scene }))
      .catch(err => ({ status: 'rejected', reason: err, scene }));
    results.push(result);
    if (result.status === 'fulfilled') {
      await new Promise(r => setTimeout(r, 7000)); // ~8 req/min, safe under limit
    }
  }

  const failed = results.filter(r => r.status === 'rejected');

  if (failed.length > MAX_SCENE_FAILURES) {
    throw new Error(
      `Too many scene illustration failures (${failed.length}/${scenes.length}). ` +
      `Errors: ${failed.map(f => f.reason?.message).join('; ')}`
    );
  }

  if (failed.length > 0) {
    for (const f of failed) {
      console.warn(`  ⚠️  Scene ${f.scene.scene_number} failed: ${f.reason?.message}`);
      await createNexusCard({
        title: `Manual asset needed: Scene ${f.scene.scene_number}`,
        description: `Scene illustration failed: ${f.reason?.message}\nPlease upload a replacement 16:9 image to the scenes bucket.\nPath: ${taskId}/scene_${String(f.scene.scene_number).padStart(2, '0')}_image.png`,
        task_type: 'stage_review',
        priority: 'high',
        parent_id: parentCardId,
        stream: 'youtube',
      });
    }
  }

  // Collect successful image paths
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { scene, imagePath, storagePath } = r.value;
      sceneImagePaths[scene.scene_number] = { imagePath, storagePath };
    }
  }

  // Feedback collection mode — review all images
  if (await isFeedbackCollectionMode()) {
    await feedbackReviewImages({ taskId, scenes, sceneImagePaths, parentCardId, sb });
  }

  console.log(`✅ Stage 4 complete. ${Object.keys(sceneImagePaths).length}/${scenes.length} scenes illustrated`);
  return { ...state, scenes, sceneImagePaths, tmpDir };
}

async function illustrateScene({ taskId, scene, characterMap, tmpDir, tracker, aspectRatio = '16:9' }) {
  // Look up primary character by scene.speaker
  const character = characterMap[scene.speaker]
    ?? characterMap[scene.speaker?.toUpperCase()]
    ?? characterMap['NARRATOR']
    ?? null;

  const prompt = buildScenePrompt(scene, character);
  console.log(`  Generating image for scene ${scene.scene_number} (${scene.speaker}/${scene.emotion}, ${aspectRatio})...`);

  // Collect reference image buffers from characters appearing in this scene
  const sceneCharacterKeys = scene.characters?.length
    ? scene.characters
    : (scene.speaker ? [scene.speaker] : []);
  const referenceImages = sceneCharacterKeys
    .map(key => characterMap[key]?.referenceImageBuffer ?? characterMap[key?.toUpperCase()]?.referenceImageBuffer)
    .filter(Boolean)
    .slice(0, 4); // Gemini 3.1 Flash cap: 4 reference images

  if (referenceImages.length > 0) {
    console.log(`  ↩️  Attaching ${referenceImages.length} character reference image(s) for scene ${scene.scene_number}`);
  }

  const imageBuffer = await withRetry(
    () => generateSceneImage({ prompt, sceneNumber: scene.scene_number, aspectRatio, referenceImages }),
    { maxRetries: 3, baseDelayMs: 15000, stage: STAGE, taskId }
  );

  // Save locally
  const scenesDir = join(tmpDir, 'scenes');
  await fs.mkdir(scenesDir, { recursive: true });
  const imagePath = join(scenesDir, `scene_${String(scene.scene_number).padStart(2, '0')}_image.png`);
  await fs.writeFile(imagePath, imageBuffer);

  // Upload to Supabase Storage
  const storagePath = await uploadSceneImage({
    videoId: taskId,
    sceneNumber: scene.scene_number,
    buffer: imageBuffer,
  });

  // Record in scene_assets
  const sb = getSupabase();
  await sb.from('scene_assets').upsert({
    video_id:     taskId,
    scene_number: scene.scene_number,
    image_url:    storagePath,
    prompt_used:  prompt,
    status:       'completed',
  }, { onConflict: 'video_id,scene_number' });

  const cost = calcImageCost(1, 'fast');
  tracker.addCost(STAGE, cost);

  console.log(`  ✓ Scene ${scene.scene_number} illustrated ($${cost.toFixed(4)})`);
  return { scene, imagePath, storagePath };
}

async function feedbackReviewImages({ taskId, scenes, sceneImagePaths, parentCardId, sb }) {
  console.log('  📋 Feedback collection mode: requesting image review...');

  const signedUrls = {};
  for (const [sceneNum, { storagePath }] of Object.entries(sceneImagePaths)) {
    try {
      signedUrls[sceneNum] = await getSceneImageUrl(taskId, parseInt(sceneNum));
    } catch {
      signedUrls[sceneNum] = storagePath;
    }
  }

  const urlList = Object.entries(signedUrls)
    .map(([n, url]) => `Scene ${n}: ${url}`)
    .join('\n');

  const cardId = await createNexusCard({
    title: `[Feedback] Stage 4: Scene Images Review`,
    description: [
      `Feedback collection mode: Please review all scene images.`,
      `\n**Images:**\n${urlList}`,
      `\nApprove if all images look good, or Request Changes with specific scene feedback.`,
    ].join('\n'),
    task_type: 'stage_review',
    priority: 'medium',
    parent_id: parentCardId,
    stream: 'youtube',
  });

  console.log(`  NEXUS image review card created: ${cardId} (non-blocking)`);
}
