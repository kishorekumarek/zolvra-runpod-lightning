// lib/pipeline-utils.mjs — Pipeline helper utilities
// Provides utilities for managing pipeline state, scene regeneration, etc.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  return createClient(url, key);
}

/**
 * Reset a specific scene so Stage 4 will regenerate its image.
 *
 * This clears BOTH sources of truth:
 *   1. scene_assets row → sets status='pending', image_url=null  (PRIMARY — DB truth)
 *   2. video_pipeline_runs stage 4 pipeline_state → removes scene from approvedImages + sceneImagePaths
 *
 * WARNING: Clearing only pipeline_state is NOT sufficient — Stage 4 always checks
 * scene_assets first and will skip any scene where status='completed'.
 *
 * @param {string} taskId       - The pipeline task UUID
 * @param {number} sceneNumber  - The scene number to reset (1-indexed)
 */
export async function resetSceneForRegeneration(taskId, sceneNumber) {
  const sb = getSupabaseClient();

  console.log(`🔄 resetSceneForRegeneration: task=${taskId}, scene=${sceneNumber}`);

  // ── 1. Reset scene_assets row ──────────────────────────────────────
  const { error: assetErr } = await sb
    .from('scene_assets')
    .update({ status: 'pending', image_url: null })
    .eq('video_id', taskId)
    .eq('scene_number', sceneNumber);

  if (assetErr) {
    console.warn(`  ⚠️  Failed to reset scene_assets for scene ${sceneNumber}: ${assetErr.message}`);
  } else {
    console.log(`  ✓ scene_assets[scene=${sceneNumber}] → status=pending, image_url=null`);
  }

  // ── 2. Read Stage 4 pipeline_state ────────────────────────────────
  const { data: stage4Row, error: readErr } = await sb
    .from('video_pipeline_runs')
    .select('pipeline_state')
    .eq('task_id', taskId)
    .eq('stage', 4)
    .order('started_at', { ascending: false })
    .limit(1)
    .single();

  if (readErr || !stage4Row?.pipeline_state) {
    console.warn(`  ⚠️  No Stage 4 pipeline_state found for task ${taskId} — only scene_assets was reset`);
    return;
  }

  const ps = { ...stage4Row.pipeline_state };

  // Remove scene from approvedImages
  if (ps.approvedImages && ps.approvedImages[sceneNumber] !== undefined) {
    delete ps.approvedImages[sceneNumber];
    console.log(`  ✓ approvedImages[${sceneNumber}] removed from pipeline_state`);
  }

  // Remove scene from sceneImagePaths
  if (ps.sceneImagePaths && ps.sceneImagePaths[sceneNumber] !== undefined) {
    delete ps.sceneImagePaths[sceneNumber];
    console.log(`  ✓ sceneImagePaths[${sceneNumber}] removed from pipeline_state`);
  }

  // ── 3. Write updated pipeline_state back ─────────────────────────
  const { error: writeErr } = await sb
    .from('video_pipeline_runs')
    .update({ pipeline_state: ps })
    .eq('task_id', taskId)
    .eq('stage', 4);

  if (writeErr) {
    console.warn(`  ⚠️  Failed to update Stage 4 pipeline_state: ${writeErr.message}`);
  } else {
    console.log(`  ✓ Stage 4 pipeline_state updated`);
  }

  console.log(`✅ Scene ${sceneNumber} reset for task ${taskId} — Stage 4 will regenerate it on next run`);
}
