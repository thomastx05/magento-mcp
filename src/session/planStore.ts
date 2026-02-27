/**
 * Plan store for two-phase commit operations.
 * Stores prepared plans in-memory with expiry.
 */

import { v4 as uuidv4 } from 'uuid';
import { BulkPlan } from '../protocol/types';

export class PlanStore {
  private plans = new Map<string, BulkPlan>();

  create(
    action: string,
    payload: unknown,
    affectedCount: number,
    expiryMinutes: number,
    sampleDiffs?: unknown[],
    warnings?: string[],
  ): BulkPlan {
    const now = new Date();
    const plan: BulkPlan = {
      plan_id: uuidv4(),
      action,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + expiryMinutes * 60_000).toISOString(),
      payload,
      affected_count: affectedCount,
      sample_diffs: sampleDiffs,
      warnings,
    };
    this.plans.set(plan.plan_id, plan);
    return plan;
  }

  get(planId: string): BulkPlan | undefined {
    const plan = this.plans.get(planId);
    if (!plan) return undefined;

    // Check expiry
    if (new Date(plan.expires_at) < new Date()) {
      this.plans.delete(planId);
      return undefined;
    }

    return plan;
  }

  consume(planId: string): BulkPlan | undefined {
    const plan = this.get(planId);
    if (plan) {
      this.plans.delete(planId);
    }
    return plan;
  }

  /**
   * Clean up expired plans.
   */
  cleanup(): number {
    const now = new Date();
    let removed = 0;
    for (const [id, plan] of this.plans.entries()) {
      if (new Date(plan.expires_at) < now) {
        this.plans.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
