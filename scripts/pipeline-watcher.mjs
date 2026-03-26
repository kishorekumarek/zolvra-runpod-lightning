#!/usr/bin/env node
// pipeline-watcher.mjs — Event-driven pipeline runner
// Polls NEXUS for approved cards and resumes pipeline stages.
// Run with: nohup node scripts/pipeline-watcher.mjs >> /tmp/pipeline-watcher.log 2>&1 &
import 'dotenv/config';
import { openSync, constants as fsConstants } from 'fs';
import { getSupabase } from '../lib/supabase.mjs';

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const sb = getSupabase();

console.log(`[${new Date().toISOString()}] 🔍 Pipeline watcher started (PID: ${process.pid})`);

async function checkAndResume() {
  // Find approved script_proposal cards that haven't triggered Stage 3 yet
  const { data: approved } = await sb
    .from('ops_tasks')
    .select('id, title, parent_id, comments')
    .eq('task_type', 'script_proposal')
    .eq('status', 'done')
    .eq('stream', 'youtube');

  for (const card of approved || []) {
    const isApproved = (card.comments || []).some(c => c.type === 'approval');
    if (!isApproved) continue;

    // Find the pipeline run for this parent card's task_id
    const { data: parentCard } = await sb
      .from('ops_tasks')
      .select('id')
      .eq('id', card.parent_id)
      .single();

    if (!parentCard) continue;

    // Find active pipeline task for this production card
    const { data: runs } = await sb
      .from('video_pipeline_runs')
      .select('task_id, stage, status')
      .order('stage', { ascending: false });

    // Group by task_id, find ones stuck at stage 2 awaiting_review
    const byTask = {};
    for (const r of runs || []) {
      if (!byTask[r.task_id]) byTask[r.task_id] = [];
      byTask[r.task_id].push(r);
    }

    for (const [taskId, taskRuns] of Object.entries(byTask)) {
      const stage2 = taskRuns.find(r => r.stage === 2);
      const stage3 = taskRuns.find(r => r.stage === 3);

      // If stage 2 is approved/awaiting_review and stage 3 hasn't started → resume
      if (stage2?.status === 'awaiting_review' && !stage3) {
        // Atomically claim: only update if still 'awaiting_review' (prevents double-spawn)
        const { data: claimed, error: claimErr } = await sb
          .from('video_pipeline_runs')
          .update({ status: 'completed' })
          .eq('task_id', taskId)
          .eq('stage_id', 'script')
          .eq('status', 'awaiting_review')
          .select('task_id');

        if (claimErr || !claimed?.length) {
          // Another poll already claimed this — skip
          continue;
        }

        console.log(`[${new Date().toISOString()}] ✅ Script approved (card ${card.id}), resuming pipeline task ${taskId} from stage 3`);

        // Find concept task (the approved story_proposal)
        const { data: conceptCards } = await sb
          .from('ops_tasks')
          .select('id')
          .eq('task_type', 'story_proposal')
          .eq('status', 'done')
          .eq('stream', 'youtube')
          .limit(1);

        const conceptId = conceptCards?.[0]?.id || 13;

        // Launch pipeline from stage 3 in background
        const { spawn } = await import('child_process');
        const child = spawn(
          'node',
          ['scripts/launch-pipeline.mjs', String(conceptId), '3', taskId],
          {
            cwd: new URL('..', import.meta.url).pathname,
            detached: true,
            stdio: ['ignore',
              openLog(`/tmp/pipeline-${taskId.slice(0,8)}-stage3.log`),
              openLog(`/tmp/pipeline-${taskId.slice(0,8)}-stage3.log`)
            ],
          }
        );
        child.unref();

        console.log(`[${new Date().toISOString()}] 🚀 Launched pipeline child PID: ${child.pid}`);
      }
    }
  }
}

function openLog(path) {
  return openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND);
}

// Run once immediately, then poll
async function loop() {
  try {
    await checkAndResume();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Watcher error: ${err.message}`);
  }
  setTimeout(loop, POLL_INTERVAL_MS);
}

loop();
