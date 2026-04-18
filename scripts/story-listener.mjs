#!/usr/bin/env node
/**
 * story-listener.mjs — Supabase Realtime listener for story_submissions.
 *
 * IDEMPOTENT: uses a PID lock file so only one instance runs at a time.
 * If another instance is already running, this process exits silently.
 *
 * Subscribes to INSERT events on story_submissions table.
 * When a new row with status='pending' arrives, spawns the pipeline via
 * trigger-pipeline-from-submission.mjs.
 *
 * On startup, sweeps for any pending rows missed while offline.
 *
 * Usage:
 *   node scripts/story-listener.mjs
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRIGGER_SCRIPT = join(__dirname, 'trigger-pipeline-from-submission.mjs');
const PID_FILE = join(__dirname, '..', '.story-listener.pid');

// ── Idempotency: PID lock ────────────────────────────────────────────────
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = just check if alive
    return true;
  } catch {
    return false;
  }
}

if (existsSync(PID_FILE)) {
  const existingPid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`👂 Story listener already running (pid ${existingPid}) — exiting`);
    process.exit(0);
  }
  // Stale PID file — previous process died without cleanup
  console.log(`🧹 Removing stale PID file (pid ${existingPid} not running)`);
}

writeFileSync(PID_FILE, String(process.pid), 'utf8');

function cleanupPid() {
  try { unlinkSync(PID_FILE); } catch { /* already gone */ }
}
process.on('exit', cleanupPid);
process.on('SIGTERM', () => { cleanupPid(); process.exit(0); });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Track in-flight pipelines to prevent double-pickup
const inFlight = new Set();

function launchPipeline(id, videoType) {
  if (inFlight.has(id)) {
    console.log(`  ⏭️  ${id} already in-flight — skipping`);
    return;
  }

  inFlight.add(id);
  console.log(`🚀 Launching pipeline for ${id} (${videoType})`);

  const child = spawn('node', [TRIGGER_SCRIPT, id, videoType], {
    cwd: join(__dirname, '..'),
    stdio: 'inherit',
  });

  child.on('close', (code) => {
    inFlight.delete(id);
    if (code === 0) {
      console.log(`✅ Pipeline completed for ${id}`);
    } else {
      console.error(`❌ Pipeline failed for ${id} (exit ${code})`);
    }
  });

  child.on('error', (err) => {
    inFlight.delete(id);
    console.error(`❌ Failed to spawn pipeline for ${id}: ${err.message}`);
  });
}

// ── Startup sweep: pick up any pending submissions missed while offline ──
async function sweepPending() {
  const { data, error } = await supabase
    .from('story_submissions')
    .select('id, video_type')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('⚠️  Sweep failed:', error.message);
    return;
  }

  if (data.length === 0) {
    console.log('📭 No pending submissions found');
    return;
  }

  console.log(`📬 Found ${data.length} pending submission(s) — processing...`);
  for (const row of data) {
    launchPipeline(row.id, row.video_type || 'short');
    // Wait for current pipeline to finish before starting next
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (!inFlight.has(row.id)) {
          clearInterval(check);
          resolve();
        }
      }, 2000);
    });
  }
}

// ── Realtime subscription ────────────────────────────────────────────────
function subscribe() {
  const channel = supabase
    .channel('story-submissions-listener')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'story_submissions' },
      (payload) => {
        const row = payload.new;
        if (row.status !== 'pending') {
          console.log(`  ℹ️  New submission ${row.id} with status=${row.status} — ignoring`);
          return;
        }
        console.log(`📩 New submission: ${row.id} (${row.video_type})`);
        launchPipeline(row.id, row.video_type || 'short');
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('🔌 Realtime connected — listening for story submissions');
      } else if (status === 'CLOSED') {
        console.warn('⚠️  Realtime disconnected — reconnecting in 5s...');
        setTimeout(subscribe, 5000);
      } else if (status === 'CHANNEL_ERROR') {
        console.error('❌ Realtime channel error — reconnecting in 10s...');
        setTimeout(subscribe, 10000);
      }
    });

  return channel;
}

// ── Main ─────────────────────────────────────────────────────────────────
console.log('👂 Story listener starting...');
await sweepPending();
subscribe();

// Keep process alive
process.on('SIGINT', () => {
  console.log('\n🛑 Story listener shutting down');
  cleanupPid();
  process.exit(0);
});
