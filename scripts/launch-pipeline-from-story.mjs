#!/usr/bin/env node
// launch-pipeline-from-story.mjs — Unified pipeline launcher for @tinytamiltales
// This is the ONLY pipeline launcher. All other launchers have been deleted/archived.
//
// NEW PIPELINE (provide a story file):
//   node scripts/launch-pipeline-from-story.mjs <story-file> [short|long]
//   cat story.txt | node scripts/launch-pipeline-from-story.mjs - [short|long]
//
// RESUME (auto-find most recent incomplete pipeline):
//   node scripts/launch-pipeline-from-story.mjs --resume
//
// RESUME (specific task_id):
//   node scripts/launch-pipeline-from-story.mjs --resume <task_id>
//
// Args:
//   <story-file>  Path to story text file, or "-" for stdin
//   [short|long]  Video format: "short" (default, 9:16, 9 scenes) or "long" (16:9, 24 scenes)
//   --resume      Resume most recent incomplete pipeline (no story file needed)
//   <task_id>     Optional: resume a specific pipeline by UUID

import 'dotenv/config';
import { readFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.mjs';
import { CostTracker } from '../lib/cost-tracker.mjs';
import { extractConceptFromStory } from '../stages/stage-01b-story-intake.mjs';
import { runStage2 } from '../stages/stage-02-script-gen.mjs';
import { runStage3 } from '../stages/stage-03-character-prep.mjs';
import { runStage4 } from '../stages/stage-04-illustrate.mjs';
import { runStage5 } from '../stages/stage-05-animate.mjs';
import { runStage6 } from '../stages/stage-06-voice.mjs';
import { runStage7 } from '../stages/stage-07-assemble.mjs';
import { runStage8 } from '../stages/stage-08-review.mjs';
import { flushApprovalUpdates, PipelineAbortError } from '../lib/telegram.mjs';
import { STAGE_ORDER } from '../lib/stage-ids.mjs';
import { getPipelineState, getConcept } from '../lib/pipeline-db.mjs';

import { execSync } from 'child_process';

// ── Kill ghost pipeline processes (except self) ──────────────────────
try {
  const myPid = process.pid;
  const output = execSync(`pgrep -f "launch-pipeline-from-story" 2>/dev/null || true`).toString().trim();
  const pids = output.split('\n').map(p => parseInt(p.trim())).filter(p => p && p !== myPid);
  if (pids.length > 0) {
    console.log(`🧹 Killing ${pids.length} ghost pipeline process(es): ${pids.join(', ')}`);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    }
    // Brief wait for processes to exit
    await new Promise(r => setTimeout(r, 2000));
  }
} catch { /* pgrep not available or no matches — fine */ }

const sb = getSupabase();

// ── Parse CLI args ───────────────────────────────────────────────────
const args = process.argv.slice(2);
const isResumeMode = args[0] === '--resume';

let taskId;
let storyText;
let videoType = 'short';

if (isResumeMode) {
  // ── RESUME MODE ──────────────────────────────────────────────────
  const resumeTaskId = args[1]; // optional specific task_id

  if (resumeTaskId) {
    // Resume a specific pipeline
    const ps = await getPipelineState(resumeTaskId);
    if (!ps) {
      console.error(`❌ No pipeline found for task_id: ${resumeTaskId}`);
      process.exit(1);
    }
    taskId = resumeTaskId;
  } else {
    // Auto-find the most recent incomplete pipeline
    const { data: incomplete } = await sb
      .from('pipeline_state')
      .select('task_id')
      .order('created_at', { ascending: false });

    let foundTaskId = null;
    for (const row of incomplete || []) {
      const { data: stages } = await sb
        .from('video_pipeline_runs')
        .select('stage_id, status')
        .eq('task_id', row.task_id);

      const completedCount = (stages || []).filter(s => s.status === 'completed').length;
      // STAGE_ORDER has 8 entries (concept + 7 stages). Pipeline is complete if all 8 are done.
      if (completedCount < STAGE_ORDER.length) {
        foundTaskId = row.task_id;
        break;
      }
    }

    if (!foundTaskId) {
      console.error('❌ No incomplete pipeline found. Start a new one with:');
      console.error('   node scripts/launch-pipeline-from-story.mjs <story-file> [short|long]');
      process.exit(1);
    }
    taskId = foundTaskId;
  }

  // Load concept to display info
  const ps = await getPipelineState(taskId);
  const concept = ps?.concept_id ? await getConcept(ps.concept_id) : null;
  videoType = concept?.video_type || 'short';

  console.log(`\n🔄 Resuming pipeline`);
  console.log(`   Task ID: ${taskId}`);
  if (concept) {
    console.log(`   Concept: ${concept.title}`);
    console.log(`   Video type: ${videoType}`);
  }

} else {
  // ── NEW PIPELINE MODE ────────────────────────────────────────────
  const storyFileArg = args[0];
  videoType = args[1] || 'short';

  if (!storyFileArg && process.stdin.isTTY) {
    console.error('Usage:');
    console.error('  New:    node scripts/launch-pipeline-from-story.mjs <story-file> [short|long]');
    console.error('  Resume: node scripts/launch-pipeline-from-story.mjs --resume [task_id]');
    process.exit(1);
  }

  // Read story text
  if (!storyFileArg || storyFileArg === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    storyText = Buffer.concat(chunks).toString('utf8').trim();
    console.log('📄 Story read from stdin');
  } else {
    storyText = (await readFile(storyFileArg, 'utf8')).trim();
    console.log(`📄 Story loaded from ${storyFileArg} (${storyText.length} chars)`);
  }

  if (!storyText) {
    console.error('❌ Empty story text');
    process.exit(1);
  }

  taskId = randomUUID();
}

// ── Clean up stale `running` rows from previous crashes ──────────────
if (isResumeMode) {
  const { data: staleRows } = await sb
    .from('video_pipeline_runs')
    .select('stage_id')
    .eq('task_id', taskId)
    .in('status', ['running', 'in_progress']);
  if (staleRows?.length) {
    console.log(`  🧹 Cleaning ${staleRows.length} stale 'running' rows: ${staleRows.map(r => r.stage_id).join(', ')}`);
    await sb.from('video_pipeline_runs')
      .update({ status: 'failed', error: 'Stale running status — cleaned on resume', completed_at: new Date().toISOString() })
      .eq('task_id', taskId)
      .in('status', ['running', 'in_progress']);
  }
}

// ── Pipeline lock (check OTHER pipelines) ────────────────────────────
const { data: running } = await sb
  .from('video_pipeline_runs')
  .select('task_id, stage_id')
  .in('status', ['running', 'in_progress'])
  .limit(1);

if (running?.length) {
  console.error(`Another pipeline is already running (task: ${running[0].task_id}, stage: ${running[0].stage_id}). Aborting.`);
  process.exit(1);
}

// Clear stale abort flag + flush stale Telegram updates
await sb.from('pipeline_settings').upsert({ key: 'pipeline_abort', value: false }, { onConflict: 'key' });
await flushApprovalUpdates();

// ── Check which stages are already completed ─────────────────────────
const { data: completedStages } = await sb
  .from('video_pipeline_runs')
  .select('stage_id')
  .eq('task_id', taskId)
  .eq('status', 'completed');
const completedSet = new Set((completedStages || []).map(r => r.stage_id));

if (completedSet.size > 0) {
  console.log(`   Completed stages: ${[...completedSet].join(', ')}`);
}

// ── Stage 1B: Extract concept from story ─────────────────────────────
if (!completedSet.has('concept')) {
  if (!storyText) {
    console.error('❌ Concept stage not completed and no story text provided. Cannot resume without a story file.');
    console.error('   Provide a story file: node scripts/launch-pipeline-from-story.mjs <story-file> [short|long]');
    process.exit(1);
  }

  // Mark Stage 1B as running BEFORE starting — prevents concurrent launches
  await sb.from('video_pipeline_runs').upsert({
    task_id: taskId,
    stage_id: 'concept',
    status: 'running',
    started_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage_id' });

  const concept = await extractConceptFromStory(storyText, { videoType, taskId });
  console.log(`\n🎬 YouTube AI Pipeline`);
  console.log(`   Concept: ${concept.title}`);
  console.log(`   Video type: ${videoType}`);
  console.log(`   Task ID: ${taskId}`);

  // Mark Stage 1B completed
  await sb.from('video_pipeline_runs')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('task_id', taskId).eq('stage_id', 'concept');
}

// ── Stage loop ───────────────────────────────────────────────────────
const tracker = new CostTracker(taskId);

const stageFns = {
  script:      runStage2,
  characters:  runStage3,
  tts:         runStage6,
  illustrate:  runStage4,
  animate:     runStage5,
  assemble:    runStage7,
  queue:       runStage8,
};

// STAGE_ORDER: ['concept', 'script', 'characters', 'tts', 'illustrate', 'animate', 'assemble', 'queue']
// Skip 'concept' — already handled above.
const stageOrder = STAGE_ORDER.filter(id => id !== 'concept');

for (const stageId of stageOrder) {
  if (completedSet.has(stageId)) {
    console.log(`\n⏭️  Stage ${stageId} already completed — skipping`);
    continue;
  }

  const stageFn = stageFns[stageId];
  if (!stageFn) {
    console.warn(`\n⚠️  No function for stage ${stageId} — skipping`);
    continue;
  }

  console.log(`\n━━━ Stage: ${stageId} ━━━`);

  await sb.from('video_pipeline_runs').upsert({
    task_id: taskId,
    stage_id: stageId,
    status: 'running',
    started_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage_id' });

  try {
    await tracker.checkBudget();
    await stageFn(taskId, tracker);
    await tracker.flush(stageId);

    await sb.from('video_pipeline_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('task_id', taskId).eq('stage_id', stageId);

    console.log(`✅ Stage ${stageId} complete`);
  } catch (err) {
    if (err instanceof PipelineAbortError) {
      await sb.from('video_pipeline_runs')
        .update({ status: 'aborted', error: err.message, completed_at: new Date().toISOString() })
        .eq('task_id', taskId).eq('stage_id', stageId);
      console.log(`\n🛑 Pipeline aborted at stage ${stageId}: ${err.message}`);
      process.exit(0);
    }

    await sb.from('video_pipeline_runs')
      .update({ status: 'failed', error: err.message, completed_at: new Date().toISOString() })
      .eq('task_id', taskId).eq('stage_id', stageId);
    console.error(`❌ Stage ${stageId} failed: ${err.message}`);
    console.error('🛑 Pipeline halted. Resume with:');
    console.error(`   node scripts/launch-pipeline-from-story.mjs --resume ${taskId}`);
    process.exit(1);
  }
}

const finalCost = await tracker.totalSpent();
console.log(`\n🎉 Pipeline complete! Total cost: $${finalCost.toFixed(4)}\n`);
