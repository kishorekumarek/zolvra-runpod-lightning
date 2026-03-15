import 'dotenv/config';
import { readFileSync } from 'fs';
import { copyFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { runStage4 } from './stages/stage-04-illustrate.mjs';
import { runStage5 } from './stages/stage-05-animate.mjs';
import { runStage6 } from './stages/stage-06-voice.mjs';
import { runStage7 } from './stages/stage-07-assemble.mjs';
import { getSupabase } from './lib/supabase.mjs';

const taskId = '210cfd98-f7d1-4f06-ac1d-e0f2587441d4';
const tracker = {
  costs: {},
  addCost(stage, cost) { this.costs[stage] = (this.costs[stage] || 0) + cost; }
};

console.log('🚀 EP02 Minminni — Resuming from Stage 4');
console.log(`  Task ID: ${taskId}`);

// Load state from stage 2 DB record
const sb = getSupabase();
const { data: stage2, error: stage2Err } = await sb
  .from('video_pipeline_runs')
  .select('pipeline_state')
  .eq('task_id', taskId)
  .eq('stage', 2)
  .single();

if (stage2Err || !stage2) {
  throw new Error(`Failed to load stage 2 state: ${stage2Err?.message || 'no data'}`);
}

const { script, scenes } = stage2.pipeline_state;
console.log(`  Loaded ${scenes?.length ?? 0} scenes from stage 2`);

// Load character map with reference image buffers
const { data: chars, error: charsErr } = await sb
  .from('character_library')
  .select('*')
  .eq('approved', true);

if (charsErr) throw new Error(`Failed to load characters: ${charsErr.message}`);

const characterMap = {};
for (const c of chars) {
  characterMap[c.name] = c;
  const imgPath = `/tmp/${taskId}/characters/${c.name.toLowerCase()}.png`;
  try {
    c.referenceImageBuffer = readFileSync(imgPath);
    console.log(`  ✓ Loaded ref image for ${c.name}`);
  } catch {
    console.log(`  ℹ️  No ref image for ${c.name} at ${imgPath}`);
  }
}

let state = {
  script,
  scenes,
  videoType: 'short',
  characterMap,
  characterMapWithImages: characterMap,
  parentCardId: '176'
};

// --- Stage 4: Illustrate ---
console.log('\n--- STAGE 4 ---');
state = await runStage4(taskId, tracker, state);
console.log('✅ Stage 4 done');

// --- Stage 5: Animate ---
console.log('\n--- STAGE 5 ---');
state = await runStage5(taskId, tracker, state);
console.log('✅ Stage 5 done');

// --- Stage 6: Voice ---
console.log('\n--- STAGE 6 ---');
state = await runStage6(taskId, tracker, state);
console.log('✅ Stage 6 done');

// --- Stage 7: Assemble ---
console.log('\n--- STAGE 7 ---');
state = await runStage7(taskId, tracker, state);
console.log('✅ Stage 7 done');

const rawOutputPath = state.finalVideoPath || state.assembledVideoPath || state.outputPath;
console.log('\n--- PIPELINE COMPLETE ---');
console.log('Output:', rawOutputPath);
console.log('Costs:', tracker.costs);

// Copy to output/ep02-minminni-final.mp4
if (rawOutputPath) {
  const destDir = '/Users/friday/.openclaw/workspace/streams/youtube/output';
  await mkdir(destDir, { recursive: true });
  const destPath = join(destDir, 'ep02-minminni-final.mp4');
  await copyFile(rawOutputPath, destPath);
  console.log(`\n📦 Final video copied to: ${destPath}`);

  const totalCost = Object.values(tracker.costs).reduce((a, b) => a + b, 0);
  console.log(`\n🎉 EP02 stages 4-7 complete — output at ${destPath}, total cost $${totalCost.toFixed(4)}`);
} else {
  console.warn('⚠️  No output path returned from stage 7 — check pipeline state');
  console.log('Final state keys:', Object.keys(state));
}
