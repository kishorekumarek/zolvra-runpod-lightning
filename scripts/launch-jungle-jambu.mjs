// scripts/launch-jungle-jambu.mjs — Jungle Jambu series pipeline launcher
//
// Starts a full pipeline for a Jungle Jambu episode using an existing concept card.
// Injects the JJ character spec into the concept, runs all stages (with JJ-aware assembly),
// and marks the video_queue record with series metadata.
//
// Usage: node scripts/launch-jungle-jambu.mjs <concept_card_id> <ep_number>
//
//   concept_card_id — UUID of an existing row in the concepts table
//   ep_number       — Episode number (integer), e.g. 1

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.mjs';
import { CostTracker } from '../lib/cost-tracker.mjs';
import { runStage2 } from '../stages/stage-02-script-gen.mjs';
import { runStage3 } from '../stages/stage-03-character-prep.mjs';
import { runStage4 } from '../stages/stage-04-illustrate.mjs';
import { runStage5 } from '../stages/stage-05-animate.mjs';
import { runStage6 } from '../stages/stage-06-voice.mjs';
import { runStage8 } from '../stages/stage-08-review.mjs';
import { assembleJungleJambu } from './assemble-jungle-jambu.mjs';
import {
  getConcept, insertConcept, insertPipelineState,
  getPipelineState, getYoutubeSeo,
} from '../lib/pipeline-db.mjs';
import { PipelineAbortError } from '../lib/telegram.mjs';

// ── Jungle Jambu character spec (injected into concept outline for Stage 2) ──
const JJ_CHARACTER_SPEC = `
---
SERIES: Jungle Jambu
CHARACTER SPEC (inject into every scene):

Character: Jungle Jambu
- Appearance: Chubby man in his 20s, khaki hunter uniform, cross belt, binoculars around neck, rifle/gun, hunter hat.
- Personality: Overconfident, cowardly, always claims credit for accidents, comic relief.
- Catchphrase energy: Acts brave → gets outsmarted by animal → chaos → "Ayyo!" → pretends it was his plan.
- Language: Tanglish (colloquial Tamil + English mix), funny, light.
- Setting: Indian jungle.
- Tone: Slapstick situational comedy, 9 scenes per Short.
- Target audience: Tamil diaspora kids.
---
`.trim();

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/launch-jungle-jambu.mjs <concept_card_id> <ep_number>');
  process.exit(1);
}
const [conceptCardId, epNumberStr] = args;
const epNumber = parseInt(epNumberStr, 10);
if (!conceptCardId || isNaN(epNumber)) {
  console.error('Error: concept_card_id must be a UUID and ep_number must be an integer');
  process.exit(1);
}

const sb = getSupabase();

// ── Load existing concept card ────────────────────────────────────────────────
console.log(`\n🦁 Jungle Jambu Series Launcher`);
console.log(`   Concept card: ${conceptCardId}`);
console.log(`   Episode:      EP${epNumber}`);

const originalConcept = await getConcept(conceptCardId).catch(err => {
  console.error(`❌ Concept not found (${conceptCardId}): ${err.message}`);
  process.exit(1);
});

console.log(`   Concept title: ${originalConcept.title}`);

// ── Create a new enriched concept (JJ spec injected) ─────────────────────────
const enrichedOutline = [
  originalConcept.outline || originalConcept.synopsis || '',
  '',
  JJ_CHARACTER_SPEC,
].join('\n').trim();

const enrichedCharacters = Array.from(new Set([
  ...(originalConcept.characters || []),
  'jungle jambu',
]));

const newConceptId = await insertConcept({
  title:      originalConcept.title,
  theme:      originalConcept.theme || '',
  synopsis:   originalConcept.synopsis || '',
  characters: enrichedCharacters,
  outline:    enrichedOutline,
  art_style:  originalConcept.art_style || '3D Pixar animation still',
  video_type: 'short',
});
console.log(`   New concept created: ${newConceptId} (JJ spec injected)`);

// ── Create pipeline ───────────────────────────────────────────────────────────
const taskId = randomUUID();
await insertPipelineState(taskId, newConceptId);
console.log(`   Task ID: ${taskId}`);

// ── Stage runner helper ───────────────────────────────────────────────────────
async function runStage(stageId, fn, tracker) {
  console.log(`\n━━━ Stage: ${stageId} ━━━`);

  await sb.from('video_pipeline_runs').upsert({
    task_id:    taskId,
    stage_id:   stageId,
    status:     'running',
    started_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage_id' });

  try {
    await tracker.checkBudget();
    await fn(taskId, tracker);
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
    console.error(`🛑 Pipeline halted. Resume with task_id: ${taskId}`);
    process.exit(1);
  }
}

// ── Lookup Tamil title from DB after stage 2 ─────────────────────────────────
async function getEpTitleTamil() {
  try {
    const ps = await getPipelineState(taskId);
    if (ps?.seo_id) {
      const seo = await getYoutubeSeo(ps.seo_id);
      if (seo?.title) return seo.title;
    }
    // Fallback: use concept title
    if (ps?.concept_id) {
      const concept = await getConcept(ps.concept_id);
      return concept.title || null;
    }
  } catch (err) {
    console.warn(`  ⚠️  Could not fetch Tamil title from DB: ${err.message}`);
  }
  return null;
}

// ── Run pipeline ──────────────────────────────────────────────────────────────
console.log(`\n🚀 Starting Jungle Jambu EP${epNumber} pipeline`);

const tracker = new CostTracker(taskId);

// Stage order: 1B (concept) already done via concept card lookup above.
// Order mirrors TTT: script → characters → tts → illustrate → animate → assemble → queue
await runStage('script',     runStage2, tracker);
await runStage('characters', runStage3, tracker);
await runStage('tts',        runStage6, tracker);
await runStage('illustrate', runStage4, tracker);
await runStage('animate',    runStage5, tracker);

// JJ-specific assembly (replaces standard stage 7)
const epTitleTamil = await getEpTitleTamil();
console.log(`\n━━━ Stage: assemble (Jungle Jambu) ━━━`);

await sb.from('video_pipeline_runs').upsert({
  task_id:    taskId,
  stage_id:   'assemble',
  status:     'running',
  started_at: new Date().toISOString(),
}, { onConflict: 'task_id,stage_id' });

try {
  await assembleJungleJambu(taskId, epNumber, epTitleTamil);

  await sb.from('video_pipeline_runs')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('task_id', taskId).eq('stage_id', 'assemble');
  console.log('✅ Stage assemble complete');
} catch (err) {
  await sb.from('video_pipeline_runs')
    .update({ status: 'failed', error: err.message, completed_at: new Date().toISOString() })
    .eq('task_id', taskId).eq('stage_id', 'assemble');
  console.error(`❌ Stage assemble failed: ${err.message}`);
  console.error(`🛑 Pipeline halted. Task ID: ${taskId}`);
  process.exit(1);
}

await runStage('queue', runStage8, tracker);

// ── Tag video_queue record with series metadata ───────────────────────────────
const { error: tagErr } = await sb
  .from('video_queue')
  .update({ series: 'jungle_jambu', series_ep_number: epNumber })
  .eq('task_id', taskId);

if (tagErr) {
  console.warn(`  ⚠️  Could not update video_queue series fields: ${tagErr.message}`);
} else {
  console.log(`  ✓ video_queue tagged: series=jungle_jambu, ep=${epNumber}`);
}

const finalCost = await tracker.totalSpent();
console.log(`\n🎉 Jungle Jambu EP${epNumber} pipeline complete! Total cost: $${finalCost.toFixed(4)}`);
console.log(`   Task ID: ${taskId}`);
console.log(`   Publish: node scripts/publish-video.mjs ${taskId}\n`);
