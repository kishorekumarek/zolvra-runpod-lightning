// stages/stage-01-concept-select.mjs — Human selects a story concept; creates pipeline task_id
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.mjs';
import { createVideoParentCard } from '../lib/nexus-client.mjs';

/**
 * Stage 1: Auto-approve concept and create task_id and parent card.
 *
 * @param {string} conceptCardId - The NEXUS card ID from Stage 0
 * @param {object} concept - The story concept object
 * @returns {{ taskId: string, conceptCardId: string, concept: object }}
 */
export async function runStage1(conceptCardId, concept) {
  console.log(`\n✅ Stage 1: Concept auto-approved (card: ${conceptCardId})`);
  console.log('  Creating task_id and parent card...');

  // Generate task_id for this entire video production
  const taskId = randomUUID();

  // Create the parent video card in NEXUS (progress timeline)
  const parentCardId = await createVideoParentCard({
    title: `🎬 Production: ${concept.title}`,
    stream: 'youtube',
  });

  // Record the run in Supabase
  const sb = getSupabase();
  await sb.from('video_pipeline_runs').insert({
    task_id:    taskId,
    stage:      1,
    status:     'completed',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  });

  console.log(`✅ Stage 1 complete. task_id: ${taskId}`);

  return { taskId, conceptCardId, parentCardId, concept };
}

/**
 * List all pending concept cards in NEXUS (helper for manual workflows).
 */
export async function listPendingConceptCards() {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('ops_tasks')
    .select('id, title, description, created_at')
    .eq('task_type', 'story_proposal')
    .eq('status', 'review')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`listPendingConceptCards failed: ${error.message}`);
  return data || [];
}
