/**
 * The first-sync screen's model (owner 2026-10-17, lib/sync-progress-shared): five stages from
 * the backfill state, the ETA measured from this store's own read (estimate from store size
 * before that), S / M / L store size, the month a failing dataset was reading, skipped months,
 * throttles that are not errors, the plan build, the partial label and the ready notice.
 */
import { describe, expect, it } from "vitest";
import {
  PRIOR,
  READY_NOTICE_MS,
  buildSyncView,
  etaBasisText,
  etaText,
  formatMonth,
  partialText,
  showReadyNotice,
  sizeText,
  stageErrorText,
  stageStatusText,
  storeSize,
  type SyncViewInput,
} from "../app/lib/sync-progress-shared";
import type { BackfillState } from "../app/lib/sync/backfill-shared";

const t = (s: string) => s;
const count = (n: number) => String(n);
const pct = (r: number) => `${Math.round(r * 100)}%`;

const T0 = "2026-10-16T08:00:00.000Z";
const RANGE = { from: "2025-09-01", until: "2026-10-15" }; // 14 calendar months, newest first
const at = (min: number) => new Date(new Date(T0).getTime() + min * 60_000);

function state(over: Partial<Record<"stock" | "sales" | "visits" | "totals", number>> = {}, extra: Partial<BackfillState> = {}): BackfillState {
  const ds = (n: number) => ({ done: n, total: 14 });
  return {
    startedAt: "2026-10-16T07:50:00.000Z",
    range: RANGE,
    datasets: {
      products: { done: 1, total: 1, finishedAt: T0 },
      stock: ds(over.stock ?? 0),
      sales: ds(over.sales ?? 0),
      visits: ds(over.visits ?? 0),
      totals: ds(over.totals ?? 0),
    },
    ...extra,
  };
}

const input = (s: BackfillState, over: Partial<SyncViewInput> = {}): SyncViewInput => ({
  state: s,
  now: at(60),
  trackedVariants: 1000,
  catalogDone: true,
  planBuiltAt: null,
  emailOnReady: true,
  ...over,
});

describe("stages", () => {
  it("five stages in order; products done, history running by months, the plan waits for the history", () => {
    const v = buildSyncView(input(state({ stock: 5, sales: 5, visits: 5, totals: 5 })));
    expect(v.stages.map((s) => s.key)).toEqual(["products", "stock", "sales", "visits", "plan"]);
    expect(v.stages.map((s) => s.status)).toEqual(["done", "running", "running", "running", "waiting"]);
    expect(v.stages[1]).toMatchObject({ done: 5, total: 14, percent: 36 });
    expect(stageStatusText(v.stages[1], t, count, pct)).toBe("5 of 14 months");
    expect(stageStatusText(v.stages[4], t, count, pct)).toBe("Starts when the history is read");
    expect(v.months).toBe(14);
    expect(v.monthsRead).toBe(5);
    expect(v.percent).toBe(Math.round((100 + 36 + 36 + 36) / 4));
  });

  it("nothing yet: every stage waits; products running once its pass started", () => {
    const v = buildSyncView(input({}, { catalogDone: false, trackedVariants: 0 }));
    expect(v.stages.map((s) => s.status)).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting"]);
    expect(v.size).toBeNull();
    expect(v.variants).toBeNull();
    const running = buildSyncView(input({ datasets: { products: { done: 0, total: 1, stage: "catalog" } } }, { catalogDone: false }));
    expect(running.stages[0].status).toBe("running");
  });

  it("the plan build runs once the history is read, and is done when a plan was computed after that", () => {
    const fin = "2026-10-16T09:00:00.000Z";
    const s = { ...state({ stock: 14, sales: 14, visits: 14, totals: 14 }), finishedAt: fin };
    expect(buildSyncView(input(s)).stages[4].status).toBe("running");
    expect(buildSyncView(input(s, { planBuiltAt: "2026-10-16T08:30:00.000Z" })).stages[4].status).toBe("running"); // an older (90-day) plan
    const done = buildSyncView(input(s, { planBuiltAt: "2026-10-16T09:05:00.000Z" }));
    expect(done.stages[4].status).toBe("done");
    expect(done.complete).toBe(true);
    expect(done.eta).toBeNull();
  });

  it("partial: numbers from the newest months while older ones load", () => {
    const v = buildSyncView(input(state({ stock: 3, sales: 4 }, { first90Ready: true })));
    expect(v.partial).toBe(true);
    expect(partialText(v.monthsRead, t, count)).toBe("Based on the last 90 days so far");
    expect(partialText(7, t, count)).toBe("Based on the last 7 months so far");
    expect(buildSyncView(input({ ...state({ stock: 14, sales: 14, visits: 14, totals: 14 }), first90Ready: true, finishedAt: T0 })).partial).toBe(false);
  });
});

describe("errors in plain words", () => {
  it("names the month a failing dataset was reading; the job retries by itself", () => {
    const s = state({ stock: 2, sales: 3 });
    s.datasets!.sales = { done: 3, total: 14, lastError: "ShopifyqlError: boom", lastErrorCode: "unknown", attempts: 2 };
    const v = buildSyncView(input(s));
    const sales = v.stages.find((x) => x.key === "sales")!;
    expect(sales.status).toBe("retrying");
    expect(sales.failedMonth).toBe("2026-07-01"); // months newest first: Oct, Sep, Aug, then July
    expect(stageErrorText(sales, t, "en")).toBe("We couldn't read sales for {month} — we'll retry automatically.".replace("{month}", "July 2026"));
    expect(formatMonth("2025-03-01", "en")).toBe("March 2025");
    expect(formatMonth("2025-03-01", "de")).toBe("März 2025");
  });

  it("a throttle is a pause, not an error", () => {
    const s = state({ stock: 2 });
    s.datasets!.stock = { done: 2, total: 14, lastError: "Throttled", lastErrorCode: "throttled" };
    const stock = buildSyncView(input(s)).stages[1];
    expect(stock.status).toBe("running");
    expect(stageErrorText(stock, t, "en")).toBeNull();
  });

  it("products failing, and months skipped after repeated failures", () => {
    const p = buildSyncView(input({ datasets: { products: { done: 0, total: 1, lastError: "x", lastErrorCode: "unknown" } } }));
    expect(stageErrorText(p.stages[0], t, "en")).toBe("We couldn't read your products — we'll retry automatically.");
    const s = state({ stock: 14, sales: 14, visits: 14, totals: 14 });
    s.datasets!.visits = { done: 14, total: 14, degraded: true, skippedMonths: ["2025-03-01", "2025-04-01"] };
    const visits = buildSyncView(input(s)).stages[3];
    expect(visits.status).toBe("gaps");
    expect(stageStatusText(visits, t, count, pct)).toBe("Done, with gaps");
    expect(stageErrorText(visits, t, "en")).toBe(
      "We couldn't read store visits for March 2025, April 2025 after several tries. Your plan uses the other months.",
    );
  });
});

describe("ETA", () => {
  it("measured from this store's read: months per minute since the history started", () => {
    // 20 months in 60 minutes = 3 min a month; 36 left = 108 min, + the plan build (60 s + 3 s per 1,000 variants).
    const v = buildSyncView(input(state({ stock: 5, sales: 5, visits: 5, totals: 5 })));
    expect(v.eta).toEqual({ basis: "measured", minutes: Math.ceil(108 + (PRIOR.buildMs + PRIOR.buildPerKVariantMs) / 60_000) });
    expect(etaText(v.eta, t, count)).toBe("About 2 hours left");
    expect(etaBasisText(v.eta, v.variants, t, count)).toBe("Worked out from how fast your store has been read so far.");
  });

  it("slower when the queue is slower: the same months in twice the time doubles the history part", () => {
    const fast = buildSyncView(input(state({ stock: 5, sales: 5, visits: 5, totals: 5 }), { now: at(60) })).eta!;
    const slow = buildSyncView(input(state({ stock: 5, sales: 5, visits: 5, totals: 5 }), { now: at(120) })).eta!;
    expect(slow.minutes).toBeGreaterThan(fast.minutes * 1.9);
  });

  it("before anything is measured: a first estimate from the store's size (S, M, L)", () => {
    const small = buildSyncView(input(state(), { trackedVariants: 300 }));
    const large = buildSyncView(input(state(), { trackedVariants: 30_000 }));
    expect(small.eta?.basis).toBe("estimate");
    expect(large.eta!.minutes).toBeGreaterThan(small.eta!.minutes * 3);
    expect(etaText(large.eta, t, count)).toBe("About 3 hours left");
    expect(etaBasisText(small.eta, small.variants, t, count)).toBe(
      "A first estimate from your store's size (300 variants). It gets more precise once the first months are in.",
    );
    // Too few months (or too little time) to measure: still the estimate.
    expect(buildSyncView(input(state({ stock: 1, sales: 1 }))).eta?.basis).toBe("estimate");
    expect(buildSyncView(input(state({ stock: 2, sales: 2, visits: 1 }), { now: at(0.5) })).eta?.basis).toBe("estimate");
  });

  it("wording buckets", () => {
    expect(etaText(null, t, count)).toBe("Working out how long this takes…");
    expect(etaText({ minutes: 2, basis: "measured" }, t, count)).toBe("Almost done");
    expect(etaText({ minutes: 7, basis: "measured" }, t, count)).toBe("About 5 minutes left");
    expect(etaText({ minutes: 23, basis: "measured" }, t, count)).toBe("About 25 minutes left");
    expect(etaText({ minutes: 70, basis: "measured" }, t, count)).toBe("About 1 hour left");
    expect(etaText({ minutes: 300, basis: "measured" }, t, count)).toBe("About 5 hours left");
    expect(etaText({ minutes: 2000, basis: "measured" }, t, count)).toBe("More than a day left");
  });
});

describe("store size and the ready notice", () => {
  it("S below 2,000 tracked variants, M below 20,000, L from 20,000; unknown before the catalog", () => {
    expect(storeSize(1999, true)).toBe("S");
    expect(storeSize(2000, true)).toBe("M");
    expect(storeSize(19_999, true)).toBe("M");
    expect(storeSize(20_000, true)).toBe("L");
    expect(storeSize(50_000, false)).toBeNull();
    expect(sizeText("L", t)).toBe("Large stores take a few hours — you can close this page.");
    expect(sizeText("S", t)).toBe("You can close this page — we keep reading in the background.");
  });

  it("'Your order plan is ready' for three days after the read finished, only when the store is ready", () => {
    const s: BackfillState = { finishedAt: T0 };
    expect(showReadyNotice(s, true, at(60))).toBe(true);
    expect(showReadyNotice(s, false, at(60))).toBe(false);
    expect(showReadyNotice(s, true, new Date(new Date(T0).getTime() + READY_NOTICE_MS + 1))).toBe(false);
    expect(showReadyNotice({}, true, at(60))).toBe(false);
  });
});
