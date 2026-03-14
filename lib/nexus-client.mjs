// lib/nexus-client.mjs — NEXUS board via direct Supabase ops_tasks writes
import { getSupabase } from './supabase.mjs';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Create a NEXUS card for human review.
 */
export async function createNexusCard({
  title,
  description = '',
  task_type = 'task',
  priority = 'medium',
  parent_id = null,
  content_url = null,
  stream = 'youtube',
}) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('ops_tasks')
    .insert({
      title,
      description,
      task_type,
      priority,
      parent_id: parent_id || null,
      content_url: content_url || null,
      stream,
      status: 'review',
      auto_created: true,
    })
    .select('id')
    .single();

  if (error) throw new Error(`createNexusCard failed: ${error.message}`);
  return data.id;
}

/**
 * Create the parent video card (shows progress timeline in NEXUS).
 */
export async function createVideoParentCard({ title, stream = 'youtube' }) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('ops_tasks')
    .insert({
      title,
      task_type: 'video_parent',
      stream,
      status: 'in_progress',
      auto_created: true,
    })
    .select('id')
    .single();

  if (error) throw new Error(`createVideoParentCard failed: ${error.message}`);
  return data.id;
}

/**
 * Create a NEXUS review card for a specific stage asset.
 * Used in feedback collection mode and human-gated stages.
 */
export async function createNexusReviewCard({
  taskId,
  stage,
  assetUrl = null,
  promptUsed = null,
  description = '',
  task_type = 'stage_review',
  parentId = null,
}) {
  return createNexusCard({
    title: `Stage ${stage} Review — Video ${taskId?.slice(0, 8)}`,
    description: [
      description,
      assetUrl ? `Asset: ${assetUrl}` : '',
      promptUsed ? `Prompt: ${promptUsed}` : '',
    ].filter(Boolean).join('\n'),
    task_type,
    priority: 'medium',
    parent_id: parentId,
    content_url: assetUrl,
    stream: 'youtube',
  });
}

/**
 * Poll ops_tasks for a human decision.
 * Returns { approved: boolean, comment: string|null }
 *
 * NEXUS sets status = 'done' for approval.
 * Request Changes: status stays 'review', latest comment has type = 'request_changes'.
 */
export async function awaitNexusDecision(cardId, timeoutMs = 86400000) {
  const sb = getSupabase();
  const start = Date.now();

  console.log(`⏳ Awaiting NEXUS decision on card ${cardId} (timeout: ${timeoutMs / 1000}s)...`);

  while (Date.now() - start < timeoutMs) {
    const { data, error } = await sb
      .from('ops_tasks')
      .select('status, comments')
      .eq('id', cardId)
      .single();

    if (error) {
      console.error('awaitNexusDecision poll error:', error.message);
      await sleep(30000);
      continue;
    }

    if (data?.status === 'done') {
      console.log(`✅ NEXUS card ${cardId} approved`);
      return { approved: true, comment: null };
    }

    // Check for 'request_changes' comment
    const comments = Array.isArray(data?.comments) ? data.comments : [];
    const changeReq = [...comments].reverse().find(c => c?.type === 'request_changes');
    if (changeReq) {
      console.log(`❌ NEXUS card ${cardId} denied: ${changeReq.text}`);
      return { approved: false, comment: changeReq.text };
    }

    if (data?.status === 'cancelled') {
      return { approved: false, comment: 'Card cancelled in NEXUS' };
    }

    await sleep(30000); // poll every 30s
  }

  throw new Error(`NEXUS card ${cardId} timed out after ${timeoutMs}ms`);
}

/**
 * Add a system comment to a NEXUS card.
 */
export async function addNexusComment(cardId, text, type = 'system') {
  const sb = getSupabase();
  const comment = {
    author: 'friday',
    type,
    text,
    timestamp: new Date().toISOString(),
  };

  const { data: card } = await sb
    .from('ops_tasks')
    .select('comments')
    .eq('id', cardId)
    .single();

  const comments = Array.isArray(card?.comments) ? card.comments : [];
  comments.push(comment);

  await sb
    .from('ops_tasks')
    .update({ comments })
    .eq('id', cardId);
}
