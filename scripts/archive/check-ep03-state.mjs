#!/usr/bin/env node
// Check existing pipeline state for EP03 in Supabase
import 'dotenv/config';
import { getSupabase } from '../lib/supabase.mjs';

const sb = getSupabase();
const EXISTING_TASK_ID = 'cb03d267-388a-48c1-8678-3ef14fbf0ceb';

const { data: runs, error } = await sb
  .from('video_pipeline_runs')
  .select('stage_id, status, pipeline_state, completed_at, error')
  .eq('task_id', EXISTING_TASK_ID)
  .order('stage_id', { ascending: true });

if (error) {
  console.log('Query error:', error.message);
} else if (!runs?.length) {
  console.log('No runs found for task', EXISTING_TASK_ID);
} else {
  console.log(`Found ${runs.length} stage(s) for task ${EXISTING_TASK_ID}:\n`);
  for (const run of runs) {
    console.log(`Stage ${run.stage_id}: ${run.status} (completed: ${run.completed_at || 'N/A'})`);
    if (run.error) console.log(`  Error: ${run.error}`);
    if (run.pipeline_state) {
      const keys = Object.keys(run.pipeline_state);
      console.log(`  State keys: ${keys.join(', ')}`);
      if (run.pipeline_state.scenes) {
        console.log(`  Scenes: ${run.pipeline_state.scenes.length}`);
        // Show first scene as sample
        console.log(`  Scene 1:`, JSON.stringify(run.pipeline_state.scenes[0]).slice(0, 200));
      }
      if (run.pipeline_state.concept) {
        console.log(`  Concept title: ${run.pipeline_state.concept.title}`);
      }
    }
  }
}

// Also check concept card 255
const { data: card, error: cardErr } = await sb
  .from('ops_tasks')
  .select('id, title, description')
  .eq('id', 255)
  .single();

if (card) {
  console.log(`\nConcept card 255: "${card.title}"`);
  console.log(`  Description (first 300 chars): ${card.description?.slice(0, 300)}`);
}

process.exit(0);
