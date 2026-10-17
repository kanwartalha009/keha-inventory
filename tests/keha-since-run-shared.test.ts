/** H2: Keha orders changed since the nightly run — the pure rules (lib/keha-since-run-shared, forward-plan withoutIncoming, compute kehaOrderShares). */
import { describe, expect, it } from "vitest";
import { kehaSinceRun, readKehaShares, type KehaOrderNow } from "../app/lib/keha-since-run-shared";
import { forwardInputFromMetric, withoutIncoming } from "../app/lib/engine/forward-plan-shared";
import { kehaOrderShares, withLandedEstimate, type OpenPo } from "../app/lib/compute-shared";

const open = (remaining: number, over: Partial<KehaOrderNow> = {}): KehaOrderNow => ({ counts: true, sent: true, remaining, closedSinceRun: false, ...over });
const closed = (remaining: number, over: Partial<KehaOrderNow> = {}): KehaOrderNow => ({ counts: false, sent: false, remaining, closedSinceRun: true, ...over });
const shares = (list: unknown[]) => ({ kehaOnOrder: 40, kehaOrders: list });

describe("kehaSinceRun with per-order shares", () => {
  const A = { po: "a", open: 40, units: 40, day: "2026-10-19" };

  it("nothing changed: nothing added, nothing removed", () => {
    expect(kehaSinceRun(shares([A]), new Map([["a", open(40)]]))).toEqual({ notCounted: 0, removed: [] });
  });

  it("closed short / cancelled: what was left comes out on its arrival day; deleted: all of it", () => {
    expect(kehaSinceRun(shares([A]), new Map([["a", closed(40)]]))).toEqual({ notCounted: 0, removed: [{ day: "2026-10-19", units: 40 }] });
    // Received 25 by hand, then closed short: 15 never come.
    expect(kehaSinceRun(shares([A]), new Map([["a", closed(15)]])).removed).toEqual([{ day: "2026-10-19", units: 15 }]);
    expect(kehaSinceRun(shares([A]), new Map()).removed).toEqual([{ day: "2026-10-19", units: 40 }]);
  });

  it("received by hand: not removed (the units moved to the shelf)", () => {
    expect(kehaSinceRun(shares([A]), new Map([["a", open(0)]]))).toEqual({ notCounted: 0, removed: [] });
    expect(kehaSinceRun(shares([A]), new Map([["a", closed(0)]]))).toEqual({ notCounted: 0, removed: [] });
  });

  it("units the run estimated as landed are never taken out twice", () => {
    const L = { po: "a", open: 40, units: 10, day: "2026-10-19" };
    expect(kehaSinceRun(shares([L]), new Map([["a", closed(40)]])).removed).toEqual([{ day: "2026-10-19", units: 10 }]);
    // Received the 30 landed ones, then closed short: the 10 incoming go.
    expect(kehaSinceRun(shares([L]), new Map([["a", closed(10)]])).removed).toEqual([{ day: "2026-10-19", units: 10 }]);
    // Received 35 (5 more than landed: those 5 came out of the incoming and stay counted), closed short: 5 go.
    expect(kehaSinceRun(shares([L]), new Map([["a", closed(5)]])).removed).toEqual([{ day: "2026-10-19", units: 5 }]);
  });

  it("added since the run: drafts, orders sent since, a re-opened order", () => {
    const now = new Map([["a", open(40)], ["d", open(30, { sent: false })], ["b", open(20)]]);
    expect(kehaSinceRun(shares([A]), now)).toEqual({ notCounted: 50, removed: [] });
    // A removal and an addition don't cancel out: one comes out on its day, one arrives after a lead time.
    expect(kehaSinceRun(shares([A]), new Map([["a", closed(40)], ["b", open(50)]]))).toEqual({ notCounted: 50, removed: [{ day: "2026-10-19", units: 40 }] });
  });

  it("reads shares defensively", () => {
    expect(readKehaShares({})).toBeNull();
    expect(readKehaShares({ kehaOrders: [] })).toEqual([]);
    expect(readKehaShares({ kehaOrders: [{ po: "a", open: 3, units: 2, day: "bad" }, { po: 1 }, null] })).toEqual([{ po: "a", open: 3, units: 2, day: null }]);
  });
});

describe("kehaSinceRun for rows written before the shares (legacy)", () => {
  it("a drop explained by an order closed since the run comes out, capped at the Keha units still incoming", () => {
    expect(kehaSinceRun({ kehaOnOrder: 40 }, new Map([["a", closed(40)]]))).toEqual({ notCounted: 0, removed: [{ day: null, units: 40 }] });
    expect(kehaSinceRun({ kehaOnOrder: 40, kehaLanded: 30 }, new Map([["a", closed(40)]])).removed).toEqual([{ day: null, units: 10 }]);
  });

  it("a hand receipt (no order closed short) or an order closed before the run is not a drop", () => {
    expect(kehaSinceRun({ kehaOnOrder: 40 }, new Map([["a", open(0)]]))).toEqual({ notCounted: 0, removed: [] });
    expect(kehaSinceRun({ kehaOnOrder: 40 }, new Map([["a", closed(40, { closedSinceRun: false })]]))).toEqual({ notCounted: 0, removed: [] });
  });

  it("units added since the run are counted as before", () => {
    expect(kehaSinceRun({ kehaOnOrder: 40 }, new Map([["a", open(40)], ["d", open(30, { sent: false })]]))).toEqual({ notCounted: 30, removed: [] });
    expect(kehaSinceRun({ kehaOnOrder: 0 }, new Map([["d", open(30, { sent: false })]]))).toEqual({ notCounted: 30, removed: [] });
  });
});

describe("withoutIncoming", () => {
  const arr = [
    { day: "2026-10-19", units: 40 },
    { day: "2026-11-02", units: 20 },
  ];
  it("takes a cut off its own day first, then the latest arrivals, then the undated part", () => {
    expect(withoutIncoming(70, arr, [{ day: "2026-10-19", units: 40 }])).toEqual({ incoming: 30, arrivals: [{ day: "2026-11-02", units: 20 }], taken: 40 });
    expect(withoutIncoming(70, arr, [{ day: null, units: 30 }])).toEqual({ incoming: 40, arrivals: [{ day: "2026-10-19", units: 30 }], taken: 30 });
    expect(withoutIncoming(70, arr, [{ day: null, units: 65 }])).toEqual({ incoming: 5, arrivals: [], taken: 65 });
    // Never more than the incoming.
    expect(withoutIncoming(70, arr, [{ day: null, units: 500 }])).toEqual({ incoming: 0, arrivals: [], taken: 70 });
  });

  it("forwardInputFromMetric: the stored need grows by the units taken", () => {
    const m = { status: "running_low", rate: 4, sigma: 1, orderQty: 30, inputs: { leadTimeDays: 14, cycleDays: 14, safety: 5, onHand: 10, incoming: 40, orderNeed: 67, arrivals: [{ day: "2026-10-19", units: 40 }] } };
    const x = { today: "2026-10-16", pack: null, moq: null, notCounted: 0, days: 91 };
    const plain = forwardInputFromMetric(m, x);
    expect(plain).toMatchObject({ incoming: 40, need: 67, arrivals: [{ day: "2026-10-19", units: 40 }] });
    expect(forwardInputFromMetric(m, { ...x, removed: [{ day: "2026-10-19", units: 40 }] })).toMatchObject({ incoming: 0, need: 107, arrivals: [] });
  });
});

describe("compute: each Keha order's share of the incoming", () => {
  it("open units and the part still incoming after the landed estimate, per order and variant", () => {
    const raw: OpenPo[] = [
      { id: "a", source: "keha", arrival: "2026-10-19", sentDay: "2026-09-01", lines: [{ variantId: "v1", qty: 100, received: 60, baseOnHand: 0 }, { variantId: "v1", qty: 10 }] },
      { id: "s", source: "shopify", arrival: "2026-10-20", sentDay: null, lines: [{ variantId: "v1", qty: 5 }] },
    ];
    // On-hand rose 90 since the send, 60 of it recorded as received: 30 more landed (estimate).
    const landed = withLandedEstimate(raw, { onHand: new Map([["v1", 90]]), baseline: () => 0, soldSince: () => 0 });
    expect(kehaOrderShares(raw, landed).get("v1")).toEqual([{ po: "a", open: 50, units: 20, day: "2026-10-19" }]);
  });
});
