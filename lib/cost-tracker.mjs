// lib/cost-tracker.mjs — CostTracker class + BudgetCapExceededError
import { getSupabase } from './supabase.mjs';
import { getSetting } from './settings.mjs';
import { STAGE_NUM_TO_ID } from './stage-ids.mjs';

export class BudgetCapExceededError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'BudgetCapExceededError';
  }
}

export class CostTracker {
  constructor(taskId) {
    this.taskId = taskId;
    this.stageCosts = {};
  }

  addCost(stage, amountUsd) {
    this.stageCosts[stage] = (this.stageCosts[stage] ?? 0) + amountUsd;
  }

  async flush(stage) {
    const sb = getSupabase();
    const cost = this.stageCosts[stage] ?? 0;

    const { error } = await sb
      .from('video_pipeline_runs')
      .update({ cost_usd: cost })
      .eq('task_id', this.taskId)
      .eq('stage_id', STAGE_NUM_TO_ID[stage]);

    if (error) {
      console.error(`CostTracker.flush(stage ${stage}) error:`, error.message);
    }
  }

  async totalSpent() {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('video_pipeline_runs')
      .select('cost_usd')
      .eq('task_id', this.taskId);

    if (error) throw new Error(`totalSpent failed: ${error.message}`);
    return (data || []).reduce((sum, row) => sum + parseFloat(row.cost_usd || 0), 0);
  }

  async checkBudget() {
    const spent = await this.totalSpent();
    const target = parseFloat(await getSetting('budget_target_usd'));
    const cap    = parseFloat(await getSetting('budget_hard_cap_usd'));

    if (spent >= cap) {
      throw new BudgetCapExceededError(
        `Hard cap $${cap} exceeded. Spent: $${spent.toFixed(4)}. Pipeline halted.`
      );
    }

    if (spent >= target) {
      console.warn(
        `⚠️  Budget target $${target} reached (spent: $${spent.toFixed(4)}). Pipeline continuing to hard cap of $${cap}.`
      );
    }

    return { spent, target, cap, overBudget: spent >= target };
  }
}

// Per-stage cost rates (USD)
export const COST_RATES = {
  imagen_fast:     0.004,  // per image
  imagen_quality:  0.040,  // per image
  kling_v15_5s:    0.140,  // per 5s clip
  elevenlabs_1000: 0.300,  // per 1000 characters
};

export function calcImageCost(count = 1, model = 'fast') {
  const rate = model === 'quality' ? COST_RATES.imagen_quality : COST_RATES.imagen_fast;
  return count * rate;
}

export function calcAnimationCost(clipCount = 1) {
  return clipCount * COST_RATES.kling_v15_5s;
}

export function calcTTSCost(totalChars = 0, takes = 2) {
  return (totalChars * takes * COST_RATES.elevenlabs_1000) / 1000;
}
