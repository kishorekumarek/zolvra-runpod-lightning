// lib/pipeline-utils.mjs — Pipeline helper utilities
// REWRITTEN for pipeline schema rewrite: uses scenes table instead of scene_assets.
import 'dotenv/config';
import { getSupabase } from './supabase.mjs';

/**
 * Reset a specific scene so Stage 4 will regenerate its image.
 *
 * Clears the scene's image data in the scenes table:
 *   - image_url = null, image_status = 'pending', image_approved = false
 *
 * Optionally also resets animation data (if you want Stage 5 to regenerate too):
 *   - animation_url = null, animation_status = 'pending', animation_approved = false
 *
 * @param {string} taskId       - The pipeline task UUID
 * @param {number} sceneNumber  - The scene number to reset (1-indexed)
 * @param {object} [opts]
 * @param {boolean} [opts.resetAnimation=true] - Also reset animation data
 */
export async function resetSceneForRegeneration(taskId, sceneNumber, { resetAnimation = true } = {}) {
  const sb = getSupabase();

  console.log(`🔄 resetSceneForRegeneration: task=${taskId}, scene=${sceneNumber}`);

  const updates = {
    image_url: null,
    prompt_used: null,
    image_status: 'pending',
    image_approved: false,
  };

  if (resetAnimation) {
    updates.animation_url = null;
    updates.animation_status = 'pending';
    updates.animation_approved = false;
  }

  const { error } = await sb
    .from('scenes')
    .update(updates)
    .eq('task_id', taskId)
    .eq('scene_number', sceneNumber);

  if (error) {
    console.warn(`  ⚠️  Failed to reset scene ${sceneNumber}: ${error.message}`);
  } else {
    console.log(`  ✓ scene ${sceneNumber} reset (image${resetAnimation ? ' + animation' : ''} cleared)`);
  }

  console.log(`✅ Scene ${sceneNumber} reset for task ${taskId} — Stage 4 will regenerate it on next run`);
}
