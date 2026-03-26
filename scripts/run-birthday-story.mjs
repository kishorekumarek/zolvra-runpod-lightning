#!/usr/bin/env node
// Runner: "Meenu and the Birthday That Changed Everything" — Stage 1B → full pipeline
import 'dotenv/config';
import { extractConceptFromStory } from '../stages/stage-01b-story-intake.mjs';
import { getSupabase } from '../lib/supabase.mjs';
import { CostTracker } from '../lib/cost-tracker.mjs';
import { runStage2 } from '../stages/stage-02-script-gen.mjs';
import { runStage3 } from '../stages/stage-03-character-prep.mjs';
import { runStage4 } from '../stages/stage-04-illustrate.mjs';
import { runStage5 } from '../stages/stage-05-animate.mjs';
import { runStage6 } from '../stages/stage-06-voice.mjs';
import { runStage7 } from '../stages/stage-07-assemble.mjs';
import { runStage8 } from '../stages/stage-08-review.mjs';
import { runStage9 } from '../stages/stage-09-publish.mjs';
import { flushApprovalUpdates, PipelineAbortError } from '../lib/telegram.mjs';
import { STAGE_NUM_TO_ID } from '../lib/stage-ids.mjs';

const STORY = `🌾 "Meenu and the Birthday That Changed Everything"

Theme: Kindness + Dignity + Community

In a small village, Meenu lived with her parents, Siva and Seetha.
They were a simple family, working hard every day just to meet their needs.

As Meenu's birthday approached, Seetha wished to celebrate it, even if it was small.
Siva also wanted to make his daughter happy, but he didn't have enough money.

Hoping to manage somehow, Siva went to the village shopkeeper and asked for groceries on credit, promising to pay in installments.
But the shopkeeper refused rudely and insulted him in front of others.

Siva walked away quietly, feeling hurt.
On his way back, he noticed that the shopkeeper behaved the same way with many people in the village—especially those who were poor or in need.

That night, Siva shared everything with Seetha and Meenu.
Meenu listened carefully.

Instead of feeling sad about her birthday, Meenu had a different thought.

She told her parents that she didn't need any celebration.
Instead, she suggested taking a small loan and starting their own grocery shop—one where people could buy what they need with dignity, even if they couldn't pay immediately.

Siva and Seetha were unsure at first, but they trusted Meenu's idea.

With courage, they started a small grocery shop in the village.
It wasn't big, but it was built on kindness.

Siva treated everyone with respect.
He allowed people to take groceries on credit, especially for important occasions like birthdays and functions.
He trusted them to pay when they could.

Slowly, villagers began to notice the difference.
They felt comfortable and respected at Siva's shop.

Over time, more and more people started coming to him.
The shop grew, not because of money, but because of trust.

On the other hand, the greedy shopkeeper lost customers.
People stopped going to him because of his rude behavior.

A year later, on Meenu's birthday, something special happened.
The entire village came together to celebrate with her.

It wasn't a grand celebration—but it was filled with warmth, gratitude, and love.

Meenu's small idea had not only changed her family's life…
but also brought dignity and kindness back into the village.

❤️ Moral:
When you treat people with kindness and respect, success will follow you.`;

const sb = getSupabase();

// ── Pipeline lock check ──────────────────────────────────────────────
const { data: running } = await sb
  .from('video_pipeline_runs')
  .select('task_id, stage')
  .in('status', ['running', 'in_progress'])
  .limit(1);

if (running?.length) {
  console.error(`Another pipeline already running (task: ${running[0].task_id}, stage: ${running[0].stage}). Aborting.`);
  process.exit(1);
}

await sb.from('pipeline_settings').upsert({ key: 'pipeline_abort', value: false }, { onConflict: 'key' });
await flushApprovalUpdates();

// ── Stage 1B: extract concept ────────────────────────────────────────
const concept = await extractConceptFromStory(STORY, { videoType: 'short' });

// ── Save concept to ops_tasks ────────────────────────────────────────
const { data: card, error: cardErr } = await sb
  .from('ops_tasks')
  .insert({
    title: `Story Concept: ${concept.title}`,
    description: JSON.stringify(concept),
    status: 'in_progress',
    stream: 'youtube',
  })
  .select()
  .single();

if (cardErr) { console.error('Failed to save concept card:', cardErr.message); process.exit(1); }
console.log(`✅ Concept saved → ops_task #${card.id}: ${concept.title}`);

const taskId = card.id.toString();
const tracker = new CostTracker(taskId);
let pipelineState = { taskId, concept };

const stageFns = [
  [2, runStage2], [3, runStage3], [4, runStage4], [5, runStage5],
  [6, runStage6], [7, runStage7], [8, runStage8], [9, runStage9],
];

for (const [stageNum, stageFn] of stageFns) {
  console.log(`\n━━━ Stage ${stageNum} ━━━`);

  await sb.from('video_pipeline_runs').upsert({
    task_id: taskId,
    stage: stageNum,
    status: 'running',
    started_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage' });

  try {
    await tracker.checkBudget();
    pipelineState = await stageFn(taskId, tracker, pipelineState) || pipelineState;
    await tracker.flush(stageNum);
    const stateSnapshot = { ...pipelineState };
    delete stateSnapshot.taskId;
    await sb.from('video_pipeline_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), pipeline_state: stateSnapshot })
      .eq('task_id', taskId).eq('stage_id', STAGE_NUM_TO_ID[stageNum]);
    console.log(`✅ Stage ${stageNum} complete`);
  } catch (err) {
    if (err instanceof PipelineAbortError) {
      await sb.from('video_pipeline_runs')
        .update({ status: 'aborted', error: err.message, completed_at: new Date().toISOString() })
        .eq('task_id', taskId).eq('stage_id', STAGE_NUM_TO_ID[stageNum]);
      console.log(`\n🛑 Pipeline aborted at stage ${stageNum}: ${err.message}`);
      process.exit(0);
    }
    await sb.from('video_pipeline_runs')
      .update({ status: 'failed', error: err.message, completed_at: new Date().toISOString() })
      .eq('task_id', taskId).eq('stage_id', STAGE_NUM_TO_ID[stageNum]);
    console.error(`❌ Stage ${stageNum} failed: ${err.message}`);
    process.exit(1);
  }
}

console.log('\n🎉 Pipeline complete!');
process.exit(0);
