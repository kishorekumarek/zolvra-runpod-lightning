#!/usr/bin/env node
// scripts/run-pipeline.mjs — Manual pipeline trigger
// Usage: node scripts/run-pipeline.mjs <task_id> [start_stage]
import 'dotenv/config';
import { runPipeline, resumePipeline } from '../pipeline/orchestrator.mjs';

const [,, taskId, startStageArg] = process.argv;

if (!taskId) {
  console.error('Usage: node scripts/run-pipeline.mjs <task_id> [start_stage]');
  console.error('  task_id:     UUID of the pipeline run');
  console.error('  start_stage: stage to start from (default: 2)');
  process.exit(1);
}

// Validate UUID format
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) {
  console.error('❌ Invalid task_id — must be a UUID (e.g. 550e8400-e29b-41d4-a716-446655440000)');
  process.exit(1);
}

const startStage = startStageArg ? parseInt(startStageArg, 10) : 2;

if (isNaN(startStage) || startStage < 0 || startStage > 9) {
  console.error('❌ start_stage must be between 0 and 9');
  process.exit(1);
}

console.log(`\n🎬 YouTube AI Pipeline — Manual Run`);
console.log(`   Task ID:     ${taskId}`);
console.log(`   Start stage: ${startStage}`);
console.log();

runPipeline(taskId, startStage)
  .then(result => {
    if (result.success) {
      console.log('\n🎉 Pipeline completed successfully!');
      console.log(`   Total cost: $${result.totalCostUsd?.toFixed(4)}`);
    } else {
      console.error(`\n❌ Pipeline failed at stage ${result.stage}: ${result.error}`);
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('\n💥 Unhandled error:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
