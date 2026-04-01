#!/usr/bin/env node
// One-off: initialise a pipeline run for the approved concept (task 13)
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.mjs';

const sb = getSupabase();

// Fetch approved concept
const { data: card, error } = await sb
  .from('ops_tasks')
  .select('*')
  .eq('id', 13)
  .single();

if (error) { console.error('Error:', error.message); process.exit(1); }

const taskId = randomUUID();

// Create parent video production card in NEXUS
const { data: parentCard, error: e2 } = await sb
  .from('ops_tasks')
  .insert({
    title: "🎬 Production: Pandi the Peacock's Feather Gift",
    description: 'Full video production pipeline — auto-created by Stage 1',
    stream: 'youtube',
    status: 'in_progress',
    priority: 'high',
    task_type: 'video_production',
    auto_created: true,
    pipeline_stage: 'stage-01',
  })
  .select()
  .single();

if (e2) { console.error('Parent card error:', e2.message); process.exit(1); }

// Record Stage 1 completion
await sb.from('video_pipeline_runs').insert({
  task_id: taskId,
  stage_id: 'concept',
  status: 'completed',
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
});

console.log(JSON.stringify({
  taskId,
  parentCardId: parentCard.id,
  conceptTitle: card.title,
}));
