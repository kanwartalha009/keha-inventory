import { describe, expect, it } from "vitest";
import { planVariant, type ForwardVariantInput } from "../../app/lib/engine/forward-plan-shared";
import { dueText } from "../../app/lib/order-plan-shared";
import { TODAY } from "./fixtures";

// Live 2026-10-18: a slow seller under its safety stock showed "Overdue · runs out Feb 8" next to
// 113 days of stock. It is below safety stock, not late: it lasts longer than a new order takes.
const v = (over: Partial<ForwardVariantInput>): ForwardVariantInput => ({
  today: TODAY, status: "healthy", rate: 1, seasonal: 1, trend: 1, plan: 1, curve: null, safety: 5, leadTimeDays: 21, cycleDays: 30,
  onHand: 4, incoming: 0, arrivals: [], pack: null, moq: null, days: 91, need: 1, ...over,
});
const t = (s: string) => s;

describe("below safety stock vs overdue", () => {
  it("lasts longer than the lead time: below safety stock, with its run-out day", () => {
    const p = planVariant(v({ rate: 0.035 }));
    expect(p.overdue).toBe(true);
    expect(p.deadline).toBeNull();
    expect(p.context).toMatchObject({ belowSafety: true });
    expect(dueText(null, TODAY, t, "en", true, p.context)).toMatch(/^Below safety stock · runs out /);
  });
  it("runs out before a new order could arrive: still Overdue", () => {
    const p = planVariant(v({ rate: 1, onHand: 4, safety: 10 }));
    expect(p.context?.runsOut).toBeTruthy();
    expect(p.context!.belowSafety ?? false).toBe(false);
    expect(dueText(null, TODAY, t, "en", true, p.context)).toMatch(/^Overdue · runs out /);
  });
});
