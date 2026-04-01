#!/usr/bin/env node
// scripts/launch-jungle-jambu.mjs — Jungle Jambu series launcher
//
// Wraps launch-pipeline-from-story.mjs without modifying it.
// Handles JJ-specific DB setup (series columns, character spec side-channel),
// then spawns the existing launcher via child_process.
//
// Usage:
//   node scripts/launch-jungle-jambu.mjs <concept_card_id> <ep_number> [--dry-run]
//
// Args:
//   concept_card_id  UUID of a pre-seeded row in the `concepts` table
//   ep_number        Integer episode number (e.g. 1)
//   --dry-run        Print DB writes + spawn command; do NOT execute

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Jungle Jambu character spec (injected into concepts.series_context) ──────
const JJ_CHARACTER_SPEC = {
  series: 'jungle_jambu',
  character_spec: {
    name:        'Jungle Jambu',
    appearance:  'Chubby man in his 20s, khaki hunter uniform, cross belt, binoculars around neck, rifle/gun, hunter hat',
    personality: 'Overconfident, cowardly, always claims credit for accidents, comic relief',
    catchphrase_energy:
      'Acts brave → gets outsmarted by animal → chaos → "Ayyo!" → pretends it was his plan',
    language:   'Tanglish (colloquial Tamil + English), funny, light',
    setting:    'Indian jungle',
    tone:       'Slapstick situational comedy, 9 scenes per Short',
    target_audience:
      'Tamil diaspora kids (UAE, UK, US, Canada, Singapore, Australia)',
  },
};

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const filteredArgs = args.filter(a => a !== '--dry-run');

const [conceptCardId, epNumberStr] = filteredArgs;

if (!conceptCardId || !epNumberStr) {
  console.error('Usage: node scripts/launch-jungle-jambu.mjs <concept_card_id> <ep_number> [--dry-run]');
  process.exit(1);
}

const epNumber = parseInt(epNumberStr, 10);
if (isNaN(epNumber) || epNumber < 1) {
  console.error(`❌ Invalid ep_number: "${epNumberStr}". Must be a positive integer.`);
  process.exit(1);
}

console.log(`\n🦁 Jungle Jambu Launcher — EP${epNumber}`);
console.log(`   Concept ID: ${conceptCardId}`);
if (dryRun) console.log('   [DRY-RUN MODE — no DB writes or subprocess spawns]\n');

// ── Main ─────────────────────────────────────────────────────────────────────
const sb = getSupabase();

// 1. Validate concept exists and is not already in-progress
console.log('  Validating concept row…');
if (!dryRun) {
  const { data: concept, error: conceptErr } = await sb
    .from('concepts')
    .select('id, title, video_type, status')
    .eq('id', conceptCardId)
    .maybeSingle();

  if (conceptErr) {
    console.error(`❌ Supabase error reading concept: ${conceptErr.message}`);
    process.exit(1);
  }
  if (!concept) {
    console.error(`❌ Concept not found: ${conceptCardId}`);
    process.exit(1);
  }
  console.log(`  ✓ Concept: "${concept.title}" (type=${concept.video_type}, status=${concept.status})`);

  if (concept.status === 'in_progress') {
    // Check for an active pipeline_state row tied to this concept
    const { data: ps } = await sb
      .from('pipeline_state')
      .select('task_id')
      .eq('concept_id', conceptCardId)
      .maybeSingle();
    if (ps?.task_id) {
      console.error(`❌ Concept already has an active pipeline (task_id: ${ps.task_id}).`);
      console.error('   Resume it with: node scripts/launch-pipeline-from-story.mjs --resume ' + ps.task_id);
      process.exit(1);
    }
  }

  // 2. Stamp series fields on the concept row + inject character spec
  console.log('  Updating concept with series context…');
  const { error: updateConceptErr } = await sb
    .from('concepts')
    .update({
      series:         'jungle_jambu',
      series_context: JJ_CHARACTER_SPEC,
    })
    .eq('id', conceptCardId);

  if (updateConceptErr) {
    console.error(`❌ Failed to update concept: ${updateConceptErr.message}`);
    process.exit(1);
  }
  console.log('  ✓ Concept stamped with series=jungle_jambu + character spec');

  // 3. Upsert video_queue pre-seed row
  //    The pipeline launcher will create/update this row — we just pre-populate the series columns
  //    so they are set before Stage 1B runs.  We key on concept_id to avoid duplicates.
  const videoQueuePayload = {
    concept_id:       conceptCardId,
    series:           'jungle_jambu',
    series_ep_number: epNumber,
    video_type:       'short',
    status:           'pending',
  };

  console.log('  Upserting video_queue pre-seed row…');
  console.log('  Payload:', JSON.stringify(videoQueuePayload, null, 4));

  const { data: vqRow, error: vqErr } = await sb
    .from('video_queue')
    .upsert(videoQueuePayload, { onConflict: 'concept_id', ignoreDuplicates: false })
    .select('id')
    .maybeSingle();

  if (vqErr) {
    // If upsert fails due to no unique constraint, fall back to insert
    console.warn(`  ⚠️  Upsert failed (${vqErr.message}), trying insert…`);
    const { error: insertErr } = await sb.from('video_queue').insert(videoQueuePayload);
    if (insertErr) {
      console.error(`❌ video_queue insert failed: ${insertErr.message}`);
      process.exit(1);
    }
    console.log('  ✓ video_queue row inserted');
  } else {
    console.log(`  ✓ video_queue pre-seeded (id: ${vqRow?.id ?? 'n/a'})`);
  }

  // 4. Write active_series_context side-channel into pipeline_settings
  //    Stage 2 wiring task will read this to inject character spec into system prompt.
  const { error: settingsErr } = await sb
    .from('pipeline_settings')
    .upsert(
      { key: 'active_series_context', value: JJ_CHARACTER_SPEC },
      { onConflict: 'key' }
    );

  if (settingsErr) {
    console.warn(`  ⚠️  pipeline_settings update failed: ${settingsErr.message} (non-fatal)`);
  } else {
    console.log('  ✓ active_series_context side-channel set in pipeline_settings');
  }
} else {
  // dry-run: print what would happen
  console.log('\n  [DRY-RUN] Would update concepts set:');
  console.log('    series = "jungle_jambu"');
  console.log('    series_context =', JSON.stringify(JJ_CHARACTER_SPEC, null, 6));
  console.log('\n  [DRY-RUN] Would upsert video_queue:');
  console.log('    concept_id =', conceptCardId);
  console.log('    series = "jungle_jambu"');
  console.log('    series_ep_number =', epNumber);
  console.log('    video_type = "short"');
  console.log('    status = "pending"');
  console.log('\n  [DRY-RUN] Would set pipeline_settings:');
  console.log('    key = "active_series_context"');
  console.log('    value =', JSON.stringify(JJ_CHARACTER_SPEC, null, 6));
}

// 5. Spawn existing launcher with --resume handoff
//    The launcher uses concept_id to find/create the pipeline_state row.
//    We provide the story file path so Stage 1B can seed from it if needed.
const launcherPath = join(__dirname, 'launch-pipeline-from-story.mjs');
const spawnArgs    = ['--resume', conceptCardId];

console.log(`\n  Spawning: node ${launcherPath} ${spawnArgs.join(' ')}`);

if (dryRun) {
  console.log('\n  [DRY-RUN] ✓ Spawn skipped. Would execute:');
  console.log(`    node scripts/launch-pipeline-from-story.mjs --resume ${conceptCardId}`);
  console.log('\n✅ Dry-run complete — no changes made.');
  process.exit(0);
}

const child = spawn(process.execPath, [launcherPath, ...spawnArgs], {
  stdio: 'inherit',
  env:   process.env,
  cwd:   join(__dirname, '..'),
});

child.on('error', err => {
  console.error(`❌ Failed to spawn launcher: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (code === 0) {
    console.log(`\n✅ Jungle Jambu EP${epNumber} pipeline completed.`);
  } else {
    console.error(`\n❌ Pipeline exited with code ${code} (signal: ${signal})`);
    process.exit(code ?? 1);
  }
});
