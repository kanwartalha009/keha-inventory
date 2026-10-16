/**
 * Action list rules (spec §7.7 incl. the 2.4 Fix rules): every trigger at its threshold and
 * just below, the € figures, and the reason keys / params. TODAY = 2026-10-16.
 */
import { describe, expect, it } from "vitest";
import {
  ACTION_RULES,
  bridgeGap,
  formatReasonParams,
  generateActions,
  median,
  type RuleContext,
  type RuleProduct,
  type RuleVariant,
} from "../../app/lib/engine/actions-rules-shared";
import { ACTION_REASONS, type ActionKind } from "../../app/lib/actions-shared";

const TODAY = "2026-10-16";
const CTX: RuleContext = { today: TODAY, aov: 50, returnsMeasured: true };

function v(over: Partial<RuleVariant> = {}): RuleVariant {
  return {
    id: "v1",
    status: "healthy",
    role: "C",
    rate: 2,
    seasonal: 1,
    trend: 1,
    onHand: 100,
    incoming: 0,
    daysLeft: 50,
    orderBy: "2026-11-20",
    orderQty: null,
    leadTimeDays: 14,
    price: 10,
    cost: 4,
    sold28: 56,
    noSaleDays: 0,
    arrival: null,
    soldNet90: null,
    returned90: null,
    ...over,
  };
}

function p(over: Partial<RuleProduct> = {}, variants: RuleVariant[] = [v()]): RuleProduct {
  return { productId: "P1", variants, sessions28: null, checkouts28: null, revenue28: null, revenue28LastYear: null, ...over };
}

const of = (drafts: ReturnType<typeof generateActions>, kind: ActionKind, productId = "P1") =>
  drafts.find((d) => d.kind === kind && d.productId === productId);

describe("reorder", () => {
  it("running low → sales at risk with the money-card maths, order-by reason", () => {
    // demand(28) = 2 × 28 = 56; stock 20 + incoming 6 → 30 units × 10 = 300.
    const d = of(generateActions([p({}, [v({ status: "running_low", onHand: 20, incoming: 6, daysLeft: 10, orderBy: "2026-10-20" })])], CTX), "reorder")!;
    expect(d.amount).toBe(300);
    expect(d.reason).toMatchObject({ key: "reorder_low", params: { days: 10, lead: 14, date: "2026-10-20" } });
    expect(d.reason.facts).toMatchObject({ rate: 2, leadTimeDays: 14, horizonDays: 28 });
  });

  it("order-by today or passed → 'Order now'", () => {
    const d = of(generateActions([p({}, [v({ status: "running_low", onHand: 20, daysLeft: 10, orderBy: TODAY })])], CTX), "reorder")!;
    expect(d.reason.key).toBe("reorder_now");
  });

  it("out with demand (rate > 0) triggers; out with rate 0 or unknown does not", () => {
    const out = (rate: number | null) => generateActions([p({}, [v({ status: "out", onHand: 0, daysLeft: 0, rate })])], CTX);
    expect(of(out(0.5), "reorder")?.reason).toMatchObject({ key: "reorder_out", params: { rate: 0.5 } });
    expect(of(out(0), "reorder")).toBeUndefined();
    expect(of(out(null), "reorder")).toBeUndefined();
  });

  it("healthy does not trigger; an unpriced variant is left out (no draft when nothing can be valued)", () => {
    expect(of(generateActions([p()], CTX), "reorder")).toBeUndefined();
    expect(of(generateActions([p({}, [v({ status: "running_low", daysLeft: 5, price: null })])], CTX), "reorder")).toBeUndefined();
  });

  it("one draft per product listing every affected variant", () => {
    const d = of(
      generateActions([p({}, [v({ id: "b", status: "running_low", daysLeft: 9 }), v({ id: "a", status: "running_low", daysLeft: 4, orderBy: "2026-10-18" }), v({ id: "c" })])], CTX),
      "reorder",
    )!;
    expect(d.variantIds).toEqual(["a", "b"]);
    expect(d.reason.params.days).toBe(4); // the most urgent variant
  });
});

describe("bridge", () => {
  const low = (over: Partial<RuleVariant> = {}) => v({ status: "running_low", onHand: 10, daysLeft: 5, orderBy: "2026-10-10", sold28: 5, ...over });

  it("order-by passed: gap = today + lead time − days left; € = rate × gap × price", () => {
    const d = of(generateActions([p({}, [low()])], CTX), "bridge")!;
    // arrival 16 Oct + 14 = 30 Oct; gap 14 − 5 = 9 days × 2/day × 10.
    expect(d.amount).toBe(180);
    expect(d.reason).toMatchObject({ key: "bridge_gap", params: { gap: 9, date: "2026-10-30" } });
    expect(d.reason.facts).toMatchObject({ arrivalSource: "lead_time", gapDays: 9 });
  });

  it("dated arrival after the run-out day triggers even when order-by has not passed", () => {
    const g = bridgeGap(v({ daysLeft: 10, orderBy: "2026-10-20", arrival: "2026-10-30" }), TODAY)!;
    expect(g).toMatchObject({ gapDays: 4, arrival: "2026-10-30", arrivalSource: "purchase_order" });
    // Arrival exactly on the run-out day: no gap.
    expect(bridgeGap(v({ daysLeft: 10, orderBy: "2026-10-20", arrival: "2026-10-26" }), TODAY)).toBeNull();
    // A late PO (date passed) counts as today.
    expect(bridgeGap(v({ status: "out", daysLeft: 0, orderBy: "2026-10-01", arrival: "2026-10-01" }), TODAY)).toBeNull();
  });

  it("undated incoming never triggers on its own", () => {
    expect(bridgeGap(v({ daysLeft: 10, orderBy: "2026-10-20", incoming: 50 }), TODAY)).toBeNull();
  });

  it("order-by passed but the stock still lasts the lead time: no gap", () => {
    expect(bridgeGap(v({ daysLeft: 15, orderBy: "2026-10-15" }), TODAY)).toBeNull();
  });

  it("needs real demand: 5 units in 28 days (threshold) but not 4", () => {
    expect(of(generateActions([p({}, [low({ sold28: 5 })])], CTX), "bridge")).toBeDefined();
    expect(of(generateActions([p({}, [low({ sold28: 4 })])], CTX), "bridge")).toBeUndefined();
  });

  it("or 50 sessions a week (200 in 28 days) but not 199", () => {
    expect(of(generateActions([p({ sessions28: 200 }, [low({ sold28: 0 })])], CTX), "bridge")).toBeDefined();
    expect(of(generateActions([p({ sessions28: 199 }, [low({ sold28: 0 })])], CTX), "bridge")).toBeUndefined();
  });

  it("sold-out variants use the 'sold out until' reason", () => {
    const d = of(generateActions([p({}, [v({ status: "out", onHand: 0, daysLeft: 0, orderBy: "2026-10-01", arrival: "2026-10-26" })])], CTX), "bridge")!;
    expect(d.reason).toMatchObject({ key: "bridge_out", params: { gap: 10, date: "2026-10-26" } });
    expect(d.amount).toBe(200);
  });
});

describe("push", () => {
  it("A/B role, healthy, trend ≥ 1 → rate × 28 × price × 20 %", () => {
    const d = of(generateActions([p({}, [v({ role: "A", trend: 1.25 })])], CTX), "push")!;
    expect(d.amount).toBeCloseTo(2 * 28 * 10 * 0.2, 2);
    expect(d.reason).toMatchObject({ key: "push_up", params: { pct: 25 } });
    expect(of(generateActions([p({}, [v({ role: "B", trend: 1 })])], CTX), "push")?.reason.key).toBe("push_steady");
  });

  it("trend just below 1, role C, or not healthy: no push", () => {
    expect(of(generateActions([p({}, [v({ role: "A", trend: 0.99 })])], CTX), "push")).toBeUndefined();
    expect(of(generateActions([p({}, [v({ role: "C", trend: 1.2 })])], CTX), "push")).toBeUndefined();
    expect(of(generateActions([p({}, [v({ role: "A", status: "running_low", daysLeft: 5 })])], CTX), "push")).toBeUndefined();
  });

  it("too much with landing conversion ≥ the store median and ≥ 200 sessions", () => {
    const tm = (sessions: number, checkouts: number, id = "P1") =>
      p({ productId: id, sessions28: sessions, checkouts28: checkouts }, [v({ id: `${id}v`, status: "too_much", daysLeft: 300, rate: 1 })]);
    const peers = [p({ productId: "Q1", sessions28: 1000, checkouts28: 20 }), p({ productId: "Q2", sessions28: 1000, checkouts28: 20 })];
    // Median of {2 %, 2 %, 2 %} = 2 %: exactly the median converts.
    const at = of(generateActions([tm(200, 4), ...peers], CTX), "push")!;
    expect(at.reason).toMatchObject({ key: "push_converts", params: { conv: 2, median: 2 } });
    // 199 sessions: not enough.
    expect(of(generateActions([tm(199, 4), ...peers], CTX), "push")).toBeUndefined();
    // Below the median (1.5 % vs median 2 %).
    expect(of(generateActions([tm(200, 3), ...peers], CTX), "push")).toBeUndefined();
  });
});

describe("fix · falling best seller", () => {
  const rows = (lastYear: number[], now: number[]) =>
    lastYear.map((ly, i) => p({ productId: `P${i + 1}`, revenue28LastYear: ly, revenue28: now[i] }, [v({ id: `v${i + 1}` })]));

  it("top 20 last year and now ≤ 70 % (threshold) → revenue gap", () => {
    const d = of(generateActions(rows([1000], [700]), CTX), "fix_falling")!;
    expect(d.amount).toBe(300);
    expect(d.reason).toMatchObject({ key: "fix_falling", params: { pct: 30 } });
    expect(of(generateActions(rows([1000], [701]), CTX), "fix_falling")).toBeUndefined();
  });

  it("only the top 20 by last year's revenue", () => {
    const ly = Array.from({ length: 21 }, (_x, i) => 10000 - i * 100); // P21 is 21st
    const now = ly.map(() => 0);
    const drafts = generateActions(rows(ly, now), CTX);
    expect(drafts.filter((d) => d.kind === "fix_falling")).toHaveLength(20);
    expect(of(drafts, "fix_falling", "P21")).toBeUndefined();
  });

  it("nothing without last year's data", () => {
    expect(of(generateActions(rows([0], [0]), CTX), "fix_falling")).toBeUndefined();
    expect(of(generateActions([p({ revenue28LastYear: null, revenue28: 0 })], CTX), "fix_falling")).toBeUndefined();
  });
});

describe("fix · missing sizes", () => {
  const sizes = (zero: number, total: number, sold28 = 10) =>
    p(
      {},
      Array.from({ length: total }, (_x, i) => v({ id: `s${i}`, onHand: i < zero ? 0 : 20, status: i < zero ? "out" : "healthy", rate: i < zero ? null : 1, sold28: i === total - 1 ? sold28 : 0 })),
    );

  it("≥ 30 % of variants at 0 while it sells (3 of 10) but not 2 of 10", () => {
    const d = of(generateActions([sizes(3, 10)], CTX), "fix_sizes")!;
    // Zero-stock sizes have no rate: estimated from siblings (1/day) × 28 × 10 × 3.
    expect(d.amount).toBe(840);
    expect(d.reason).toMatchObject({ key: "fix_sizes", params: { out: 3, total: 10 } });
    expect(d.reason.facts).toMatchObject({ estimatedFromSiblings: 3, siblingRate: 1 });
    expect(d.variantIds).toEqual(["s0", "s1", "s2"]);
    expect(of(generateActions([sizes(2, 10)], CTX), "fix_sizes")).toBeUndefined();
  });

  it("not when the product no longer sells, nor for a single-variant product", () => {
    expect(of(generateActions([sizes(3, 10, 0)], CTX), "fix_sizes")).toBeUndefined();
    expect(of(generateActions([sizes(1, 1)], CTX), "fix_sizes")).toBeUndefined();
  });
});

describe("fix · weak page", () => {
  const prod = (id: string, conv: number, price = 10, sessions = 1000) =>
    p({ productId: id, sessions28: sessions, checkouts28: conv * sessions }, [v({ id: `${id}v`, price })]);
  const peers = (n: number, price = 10) => Array.from({ length: n }, (_x, i) => prod(`Q${i}`, 0.04, price));

  it("conversion < 0.5 × peer median with ≥ 5 peers → gap × sessions × AOV", () => {
    const d = of(generateActions([prod("P1", 0.0199), ...peers(5)], CTX), "fix_page")!;
    // (4 % − 1.99 %) × 1000 × 50
    expect(d.amount).toBeCloseTo(0.0201 * 1000 * 50, 2);
    expect(d.reason).toMatchObject({ key: "fix_page", params: { conv: 2, median: 4 } });
  });

  it("exactly half the median does not trigger; 4 peers are not enough", () => {
    expect(of(generateActions([prod("P1", 0.02), ...peers(5)], CTX), "fix_page")).toBeUndefined();
    expect(of(generateActions([prod("P1", 0.01), ...peers(4)], CTX), "fix_page")).toBeUndefined();
  });

  it("peers must be priced 0.5×–2× (both ends inclusive) and have ≥ 200 sessions", () => {
    const edge = [prod("Q1", 0.04, 5), prod("Q2", 0.04, 20), prod("Q3", 0.04, 10), prod("Q4", 0.04, 10), prod("Q5", 0.04, 10)];
    expect(of(generateActions([prod("P1", 0.01), ...edge], CTX), "fix_page")).toBeDefined();
    const outside = [prod("Q1", 0.04, 4.99), ...edge.slice(1)];
    expect(of(generateActions([prod("P1", 0.01), ...outside], CTX), "fix_page")).toBeUndefined();
    const thin = [prod("Q1", 0.04, 10, 199), ...edge.slice(1)];
    expect(of(generateActions([prod("P1", 0.01), ...thin], CTX), "fix_page")).toBeUndefined();
    expect(of(generateActions([prod("P1", 0.01, 10, 199), ...peers(5)], CTX), "fix_page")).toBeUndefined();
  });

  it("no AOV → nothing", () => {
    expect(of(generateActions([prod("P1", 0.01), ...peers(5)], { ...CTX, aov: null }), "fix_page")).toBeUndefined();
  });
});

describe("fix · returns", () => {
  const ret = (id: string, net: number, returned: number) => p({ productId: id }, [v({ id: `${id}v`, soldNet90: net, returned90: returned })]);
  const normal = [ret("Q1", 95, 5), ret("Q2", 95, 5), ret("Q3", 95, 5)]; // 5 % each → median 5 %, threshold 25 %

  it("rate ≥ max(25 %, 2 × median) with ≥ 10 units → value returned", () => {
    const d = of(generateActions([ret("P1", 75, 25), ...normal], CTX), "fix_returns")!;
    expect(d.amount).toBe(250);
    expect(d.reason).toMatchObject({ key: "fix_returns", params: { pct: 25, median: 5 } });
    expect(of(generateActions([ret("P1", 76, 24), ...normal], CTX), "fix_returns")).toBeUndefined();
  });

  it("2 × the store median wins when it is above 25 %", () => {
    const high = [ret("Q1", 80, 20), ret("Q2", 80, 20), ret("Q3", 80, 20)]; // median 20 % → threshold 40 %
    expect(of(generateActions([ret("P1", 60, 40), ...high], CTX), "fix_returns")).toBeDefined();
    expect(of(generateActions([ret("P1", 61, 39), ...high], CTX), "fix_returns")).toBeUndefined();
  });

  it("needs 10 units sold (threshold) but not 9; negative quantity_returned counts as units", () => {
    expect(of(generateActions([ret("P1", 5, -5), ...normal], CTX), "fix_returns")).toBeDefined();
    expect(of(generateActions([ret("P1", 4, 5), ...normal], CTX), "fix_returns")).toBeUndefined();
  });

  it("nothing while returns are not measured", () => {
    expect(of(generateActions([ret("P1", 50, 50), ...normal], { ...CTX, returnsMeasured: false }), "fix_returns")).toBeUndefined();
  });
});

describe("clear", () => {
  it("dead → cost × on hand, with the no-sale days", () => {
    const d = of(generateActions([p({}, [v({ status: "dead", rate: 0, daysLeft: Infinity, onHand: 30, noSaleDays: 120 })])], CTX), "clear")!;
    expect(d.amount).toBe(120);
    expect(d.reason).toMatchObject({ key: "clear_dead", params: { days: 120, units: 30 } });
    expect(d.reason.facts).toMatchObject({ costBasis: "cost" });
  });

  it("too much → cost × (on hand − 90 × forecast rate), retail price when the cost is unknown", () => {
    const d = of(generateActions([p({}, [v({ status: "too_much", rate: 1, trend: 0.9, onHand: 300, daysLeft: 333, cost: null })])], CTX), "clear")!;
    expect(d.amount).toBeCloseTo((300 - 90 * 0.9) * 10, 2);
    expect(d.reason).toMatchObject({ key: "clear_too_much", params: { days: 333 } });
    expect(d.reason.facts).toMatchObject({ costBasis: "retail" });
  });

  it("healthy or running low never clears", () => {
    expect(of(generateActions([p({}, [v({ status: "healthy" }), v({ id: "v2", status: "running_low", daysLeft: 3 })])], CTX), "clear")).toBeUndefined();
  });
});

describe("contract", () => {
  it("every reason key used is in ACTION_REASONS and its params fill every placeholder", () => {
    const drafts = generateActions(
      [
        p({}, [v({ status: "running_low", daysLeft: 5, orderBy: "2026-10-10", sold28: 9 })]),
        p({ productId: "P2" }, [v({ id: "x", status: "dead", rate: 0, daysLeft: Infinity, noSaleDays: 100 })]),
        p({ productId: "P3" }, [v({ id: "y", role: "A", trend: 1.1 })]),
      ],
      CTX,
    );
    expect(drafts.length).toBeGreaterThanOrEqual(4);
    for (const d of drafts) {
      const tpl = ACTION_REASONS[d.reason.key];
      expect(tpl, d.reason.key).toBeDefined();
      for (const m of tpl.match(/\{(\w+)\}/g) ?? []) expect(d.reason.params, `${d.reason.key} ${m}`).toHaveProperty(m.slice(1, -1));
      expect(d.amount).toBeGreaterThanOrEqual(0);
    }
  });

  it("templates follow the copy rules (§12)", () => {
    const all = Object.values(ACTION_REASONS).join(" ");
    expect(all).not.toMatch(/velocity|days of cover|carrying cost|run rate|insufficient/i);
  });

  it("formats ISO days as '20 Oct' and numbers per locale", () => {
    expect(formatReasonParams({ date: "2026-10-20", rate: 1.5, days: 4 }, "en")).toEqual({ date: "20 Oct", rate: "1.5", days: "4" });
    expect(formatReasonParams({ rate: 1.5 }, "de").rate).toBe("1,5");
  });

  it("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("thresholds are the spec's", () => {
    expect(ACTION_RULES).toMatchObject({ bridgeMinUnits28: 5, bridgeMinSessionsPerWeek: 50, minSessions: 200, fallingTop: 20, fallingMaxShare: 0.7, sizesMinShare: 0.3, pageMinPeers: 5, returnsMinRate: 0.25, returnsMinUnits: 10, pushShare: 0.2 });
  });
});
