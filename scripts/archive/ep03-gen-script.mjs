#!/usr/bin/env node
// EP03 runner: extract concept from Darl's story, generate 24-scene Tamil script, save to Supabase, launch stage 3+

// Force .env to override shell env BEFORE any module loads the Anthropic client
import { readFileSync } from 'fs';
const envContent = readFileSync('.env', 'utf8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

// Now dynamically import everything (Anthropic client will see the correct key)
const { randomUUID } = await import('crypto');
const { extractConceptFromStory } = await import('./stages/stage-01b-story-intake.mjs');
const { runStage2 } = await import('./stages/stage-02-script-gen.mjs');
const { setSetting } = await import('./lib/settings.mjs');
const { getSupabase } = await import('./lib/supabase.mjs');
const { CostTracker } = await import('./lib/cost-tracker.mjs');

const CONCEPT_CARD_ID = 255;

const storyText = `Tara the squirrel and her friends Mini (mouse), Albert (owl), Miko (frog) live in an ancient banyan tree. A monsoon storm arrives. The banyan root starts lifting from floodwater. Tara decides alone: 'Naan panren' — I'll do it. She builds a clay dam, evacuates Mini to the upper hollow ('Promise me'), convinces reluctant Albert with gentle words ('Tree-ku unna vennum'), finds Miko already working at roots. Lightning destroys the dam. Tara climbs the storm-lashed canopy and ties the fraying anchoring vine. Wind pushes hard — she holds. Storm ends. Banyan stands. Reunion: Miko 'NAMMA JEYICHOM!', Albert's slow nod. Moral: Kaadai kaapathuvadu namma ellorum duty. Oru sinna kaiyum oru periya maramum kaapathum.`;

const taskId = randomUUID();
console.log(`\n🆔 New task_id: ${taskId}\n`);

// Step 1: Set video_type = 'long'
await setSetting('video_type', 'long');
console.log('✅ video_type set to "long"');

// Step 2: Extract concept from story
const concept = await extractConceptFromStory(storyText);
console.log(`\n📦 Concept extracted: ${concept.title}`);

// Step 3: Create Supabase records
const sb = getSupabase();

// Record Stage 1 as completed
await sb.from('video_pipeline_runs').upsert({
  task_id: taskId,
  stage: 1,
  status: 'completed',
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  pipeline_state: { concept },
}, { onConflict: 'task_id,stage' });
console.log('✅ Stage 1 recorded');

// Get or create parent card
let parentCardId;
const { data: existingParent } = await sb
  .from('ops_tasks')
  .select('id')
  .eq('task_type', 'video_production')
  .eq('stream', 'youtube')
  .like('title', `%${concept.title}%`)
  .single();

if (existingParent) {
  parentCardId = existingParent.id;
  console.log(`  Using existing parent card: ${parentCardId}`);
} else {
  const { data: newParent } = await sb
    .from('ops_tasks')
    .insert({
      title: `🎬 Production: ${concept.title}`,
      description: `Full video production pipeline — EP03\n**Theme:** ${concept.theme}\n**Characters:** ${concept.characters.join(', ')}\n**Synopsis:** ${concept.synopsis}`,
      stream: 'youtube',
      status: 'in_progress',
      priority: 'high',
      task_type: 'video_production',
      auto_created: true,
      pipeline_stage: 'stage-01',
    })
    .select()
    .single();
  parentCardId = newParent?.id;
  console.log(`  Created parent card: ${parentCardId}`);
}

// Step 4: Run Stage 2 (generates script, does per-scene approval via Telegram/NEXUS)
const tracker = new CostTracker(taskId);
const state = { concept, parentCardId };

console.log('\n━━━ Running Stage 2: Script Generation ━━━');
const result = await runStage2(taskId, tracker, state);
await tracker.flush(2);

console.log(`\n✅ Stage 2 complete — ${result.scenes?.length || 0} scenes generated`);
console.log(`🆔 Task ID: ${taskId}`);
console.log(`📋 Episode: ${result.episodeNumber}`);
console.log(`🎬 Ready to launch pipeline from stage 3`);
console.log(`\nRun next: node scripts/launch-pipeline.mjs ${CONCEPT_CARD_ID} 3 ${taskId}`);
