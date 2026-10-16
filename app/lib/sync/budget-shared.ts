/**
 * Per-tick budgets for the data jobs (review H4). Pure: the real sleep is injected.
 *
 *  - Throttle waits (ShopifyQL windowResetAt, Admin API restore) go through a sleep budget:
 *    once a tick has waited THROTTLE_BUDGET_MS in total, the next wait throws
 *    ThrottleBudgetError instead of sleeping, the job stops, and the next tick resumes.
 *  - Each shop gets at most STEPS_PER_TICK backfill steps per scheduler tick, so one large
 *    store never holds the hourly job for hours.
 */

export const THROTTLE_BUDGET_MS = 30_000;
export const STEPS_PER_TICK = 6;

/** A throttle wait would exceed the tick's budget: stop and resume on the next tick. */
export class ThrottleBudgetError extends Error {
  readonly waitMs: number;
  constructor(waitMs: number, spentMs: number, budgetMs: number) {
    super(`throttle wait of ${waitMs} ms exceeds the tick budget (${spentMs}/${budgetMs} ms used)`);
    this.name = "ThrottleBudgetError";
    this.waitMs = waitMs;
  }
}

export type SleepBudget = {
  sleep: (ms: number) => Promise<void>;
  spent: () => number;
};

export function createSleepBudget(sleep: (ms: number) => Promise<void>, budgetMs: number = THROTTLE_BUDGET_MS): SleepBudget {
  let spent = 0;
  return {
    sleep: async (ms: number) => {
      const wait = Math.max(0, ms);
      if (spent + wait > budgetMs) throw new ThrottleBudgetError(wait, spent, budgetMs);
      spent += wait;
      await sleep(wait);
    },
    spent: () => spent,
  };
}
