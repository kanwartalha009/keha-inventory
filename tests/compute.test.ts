/**
 * compute.server (task 1.5) on seeded facts (in-memory Prisma): online pool only, channel
 * view only, bundles / untracked skipped, VariantMetric upserted (neverRunsOut), stale
 * metrics removed, MoneyAtStake for the store-local day with the sold-out traffic figure,
 * and the Free plan's monthly money refresh.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ variantMetric: ["shop", "variantId", "scope"], moneyAtStake: ["shop", "day"] });
  return { default: db.client, __fake: db };
});
vi.mock("../app/services/entitlements.server", () => ({ planFor: async () => "growth" }));

import * as dbModule from "../app/db.server";
import { computeShop } from "../app/services/compute.server";
import { addDays } from "../app/lib/sync/shopifyql-shared";
import type { MoneyBasisJson } from "../app/lib/money-shared";
import { forwardInputFromMetric, planVariant } from "../app/lib/engine/forward-plan-shared";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const NOW = Date.parse("2026-10-16T08:00:00Z"); // 10:00 Madrid → today 2026-10-16
const d = (day: string) => new Date(`${day}T00:00:00.000Z`);
const L1 = "gid://shopify/Location/1"; // warehouse, online
const L2 = "gid://shopify/Location/2"; // store, not online
const A = "gid://shopify/ProductVariant/1";
const B = "gid://shopify/ProductVariant/2";
const C = "gid://shopify/ProductVariant/3";
const BUNDLE = "gid://shopify/ProductVariant/4";
const UNTRACKED = "gid://shopify/ProductVariant/5";
const DRAFT = "gid://shopify/ProductVariant/6";
const SPARSE = "gid://shopify/ProductVariant/7";

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let x = from; x <= to; x = addDays(x, 1)) out.push(x);
  return out;
}

function seed() {
  db.reset();
  db.tables.shop = [{ domain: S, timezone: "Europe/Madrid", currency: "EUR", settings: {}, uninstalledAt: null }];
  db.tables.location = [
    { id: L1, shop: S, active: true, online: true },
    { id: L2, shop: S, active: true, online: false },
  ];
  const v = (id: string, productId: string, handle: string, extra: Record<string, unknown> = {}) => ({
    id,
    shop: S,
    productId,
    handle,
    tracked: true,
    isBundle: false,
    cost: 10,
    price: 25,
    productCreatedAt: new Date("2025-01-01T00:00:00Z"),
    caseQty: null,
    supplierId: null,
    status: "ACTIVE",
    ...extra,
  });
  db.tables.variant = [
    v(A, "PA", "tee"),
    v(B, "PB", "mug", { price: 20 }),
    v(C, "PC", "old"),
    v(BUNDLE, "PD", "box", { isBundle: true }),
    v(UNTRACKED, "PE", "card", { tracked: false }),
    v(DRAFT, "PF", "draft-tee", { status: "DRAFT" }),
    v(SPARSE, "PG", "sparse"),
  ];
  db.tables.salesDaily = [];
  db.tables.stockDaily = [];
  const all = daysBetween("2026-07-18", "2026-10-15"); // the 90 days before today
  for (const day of all) {
    // A: 2 a day online + 7 a day in the store L2 (outside the pool: must not count).
    db.tables.salesDaily.push({ shop: S, day: d(day), variantId: A, locationKey: "online", channel: "all", sold: 2, returned: 0, gross: 0 });
    db.tables.salesDaily.push({ shop: S, day: d(day), variantId: A, locationKey: L2, channel: "all", sold: 7, returned: 0, gross: 0 });
    db.tables.salesDaily.push({ shop: S, day: d(day), variantId: A, locationKey: "all", channel: "Online Store", sold: 2, returned: 0, gross: 50 });
    db.tables.salesDaily.push({ shop: S, day: d(day), variantId: A, locationKey: "all", channel: "Point of Sale", sold: 7, returned: 0, gross: 175 });
    db.tables.stockDaily.push({ shop: S, day: d(day), variantId: A, locationId: L1, endUnits: 100, outOfStock: false });
    db.tables.stockDaily.push({ shop: S, day: d(day), variantId: A, locationId: L2, endUnits: 5, outOfStock: false });
    // B: sells 1 a day until it sells out on 6 Oct.
    const out = day >= "2026-10-06";
    if (!out) {
      db.tables.salesDaily.push({ shop: S, day: d(day), variantId: B, locationKey: "online", channel: "all", sold: 1, returned: 0, gross: 0 });
      db.tables.salesDaily.push({ shop: S, day: d(day), variantId: B, locationKey: "all", channel: "Online Store", sold: 1, returned: 0, gross: 20 });
    }
    db.tables.stockDaily.push({ shop: S, day: d(day), variantId: B, locationId: L1, endUnits: out ? 0 : 20, outOfStock: out });
    // C: stock, never sells.
    db.tables.stockDaily.push({ shop: S, day: d(day), variantId: C, locationId: L1, endUnits: 30, outOfStock: false });
    // DRAFT: sells and has stock, but its product is not active.
    db.tables.salesDaily.push({ shop: S, day: d(day), variantId: DRAFT, locationKey: "online", channel: "all", sold: 3, returned: 0, gross: 0 });
    db.tables.stockDaily.push({ shop: S, day: d(day), variantId: DRAFT, locationId: L1, endUnits: 40, outOfStock: false });
    // BUNDLE: sells, must be skipped.
    db.tables.salesDaily.push({ shop: S, day: d(day), variantId: BUNDLE, locationKey: "all", channel: "Online Store", sold: 5, returned: 0, gross: 300 });
  }
  db.tables.stockNow = [
    { shop: S, variantId: A, locationId: L1, onHand: 100, available: 100, incoming: 0 },
    { shop: S, variantId: A, locationId: L2, onHand: 50, available: 50, incoming: 0 }, // not in the online pool
    { shop: S, variantId: B, locationId: L1, onHand: 0, available: 0, incoming: 24 },
    { shop: S, variantId: C, locationId: L1, onHand: 30, available: 30, incoming: 0 },
    { shop: S, variantId: DRAFT, locationId: L1, onHand: 40, available: 40, incoming: 0 },
    { shop: S, variantId: SPARSE, locationId: L1, onHand: 20, available: 20, incoming: 0 },
  ];
  // Review H2 case: SPARSE sold 1 unit on 15 of the 90 days and has NO pool stock rows.
  for (const day of all.filter((_x, i) => i % 6 === 0)) {
    db.tables.salesDaily.push({ shop: S, day: d(day), variantId: SPARSE, locationKey: "online", channel: "all", sold: 1, returned: 0, gross: 0 });
    db.tables.salesDaily.push({ shop: S, day: d(day), variantId: SPARSE, locationKey: "all", channel: "Online Store", sold: 1, returned: 0, gross: 25 });
  }
  db.tables.sessionsDaily = [];
  db.tables.shopDaily = [];
  for (const day of daysBetween("2026-09-16", "2026-10-15")) {
    db.tables.sessionsDaily.push({ shop: S, day: d(day), landingPath: "/products/tee", trafficType: "google", sessions: 100, checkouts: 2 });
    db.tables.shopDaily.push({ shop: S, day: d(day), orders: 4, gross: 200 });
    if (day >= "2026-10-06") {
      db.tables.sessionsDaily.push({ shop: S, day: d(day), landingPath: "/products/mug", trafficType: "google", sessions: 10, checkouts: 0 });
      db.tables.sessionsDaily.push({ shop: S, day: d(day), landingPath: "/es/products/mug", trafficType: "direct", sessions: 5, checkouts: 0 });
    }
  }
  db.tables.variantMetric = [
    { shop: S, variantId: "gid://shopify/ProductVariant/999", scope: "online", computedAt: new Date("2026-10-01T00:00:00Z") },
    { shop: S, variantId: DRAFT, scope: "online", computedAt: new Date("2026-10-01T00:00:00Z") },
  ];
  db.tables.moneyAtStake = [];
}

const metric = (id: string) => db.tables.variantMetric.find((m) => m.variantId === id)!;

beforeEach(seed);

describe("computeShop", () => {
  it("writes one online metric per ACTIVE tracked, non-bundle variant and drops stale / draft ones", async () => {
    const r = await computeShop(S, { now: () => NOW });
    expect(r).toMatchObject({ status: "computed", today: "2026-10-16", variants: 4, money: "computed" });
    expect(db.tables.variantMetric.map((m) => m.variantId).sort()).toEqual([A, B, C, SPARSE]);
    expect(db.tables.variantMetric.every((m) => m.scope === "online" && (m.computedAt as Date).getTime() === NOW)).toBe(true);
  });

  it("pools sales from the location view (online + pool locations), never the store outside the pool", async () => {
    await computeShop(S, { now: () => NOW });
    const a = metric(A);
    expect(a.rate).toBeCloseTo(2, 10); // not 9 (channel view incl. the L2 store's POS sales)
    expect((a.inputs as { price: number }).price).toBe(25); // channel view still prices it
    expect(a.daysLeft).toBeCloseTo(50, 10); // 100 pooled units ÷ 2/day (L2's 50 not counted)
    expect(a.status).toBe("healthy");
    expect(a.role).toBe("A");
    expect((a.inputs as { onHand: number }).onHand).toBe(100);
  });

  it("audit C2: the planning position is Shopify available (negative when oversold), not on_hand", async () => {
    // Oversold: nothing on the shelf, 1,500 sold but not shipped (committed) → available −1,500.
    const row = db.tables.stockNow.find((s) => s.variantId === A && s.locationId === L1)!;
    Object.assign(row, { onHand: 0, available: -1500, committed: 1500 });
    await computeShop(S, { now: () => NOW });
    const a = metric(A);
    expect((a.inputs as { onHand: number }).onHand).toBe(-1500);
    expect(a.status).toBe("out");
  });

  it("review fix: Keha order units that already landed are not counted as incoming again", async () => {
    // Sent 10 Oct with 30 on hand; now 100 on hand after 12 sold since (2/day × 6 days) → 82 landed ≥ 80.
    db.tables.purchaseOrder = [
      { id: "po1", shop: S, source: "keha", status: "sent", sentAt: new Date("2026-10-10T09:00:00Z"), expectedDate: d("2026-10-30"), confirmedShipDate: null, lines: [{ variantId: A, qty: 80, baseOnHand: 30 }] },
    ];
    await computeShop(S, { now: () => NOW });
    expect(metric(A).inputs).toMatchObject({ incoming: 0, kehaOnOrder: 80, kehaLanded: 80 });
    // Partly landed: base 60 → 100 − 60 + 12 = 52 landed → 28 still to come.
    (db.tables.purchaseOrder[0]!.lines as { baseOnHand: number }[])[0]!.baseOnHand = 60;
    await computeShop(S, { now: () => NOW });
    expect(metric(A).inputs).toMatchObject({ incoming: 28, kehaOnOrder: 80, kehaLanded: 52 });
  });

  it("review fix: sales at risk leaves out dated Keha units arriving after today + 27", async () => {
    // B is out, Shopify incoming 24: the card is (28 − 24) × 20 = 80. A Keha order of 10 more…
    const po = (expected: string) => [
      { id: "po2", shop: S, source: "keha", status: "sent", sentAt: new Date("2026-10-14T09:00:00Z"), expectedDate: d(expected), confirmedShipDate: null, lines: [{ variantId: B, qty: 10, baseOnHand: 0 }] },
    ];
    db.tables.purchaseOrder = po("2026-11-12"); // …arriving on the last day of the window: counted → 0 short.
    await computeShop(S, { now: () => NOW });
    expect(db.tables.moneyAtStake[0]!.atRisk).toBe(0);
    db.tables.moneyAtStake = [];
    db.tables.purchaseOrder = po("2026-11-13"); // …arriving the day after: not counted → 80.
    await computeShop(S, { now: () => NOW });
    expect(db.tables.moneyAtStake[0]!.atRisk).toBe(80);
    expect(action("reorder:PB")!.amount).toBe(80);
  });

  it("review H2: sales on days with no pool stock data are missing, not in-stock days", async () => {
    await computeShop(S, { now: () => NOW });
    const sp = metric(SPARSE);
    expect(sp.rate).not.toBe(1);
    expect(sp.rate).toBeNull();
    expect(sp.status).toBe("not_enough_data");
    expect((sp.inputs as { dataDays: number }).dataDays).toBe(0);
  });

  it("dead works when deadDays > 90 for a never-sold variant (oldest pool stock day starts the no-sale period)", async () => {
    db.tables.shop[0].settings = { deadDays: 180 };
    await computeShop(S, { now: () => NOW });
    expect(metric(C).status).not.toBe("dead"); // only 90 days of stock data
    db.tables.stockDaily.push({ shop: S, day: d("2026-03-30"), variantId: C, locationId: L1, endUnits: 30, outOfStock: false });
    await computeShop(S, { now: () => NOW });
    expect(metric(C).status).toBe("dead");
    expect((metric(C).inputs as { noSaleDays: number }).noSaleDays).toBe(200);
  });

  it("marks the sold-out variant out and the never-selling one dead with neverRunsOut", async () => {
    await computeShop(S, { now: () => NOW });
    expect(metric(B).status).toBe("out");
    expect(metric(B).daysLeft).toBe(0);
    const c = metric(C);
    expect(c.status).toBe("dead");
    expect(c.neverRunsOut).toBe(true);
    expect(c.daysLeft).toBeNull();
  });

  it("stores the four money cards for today with their basis", async () => {
    await computeShop(S, { now: () => NOW });
    expect(db.tables.moneyAtStake).toHaveLength(1);
    const m = db.tables.moneyAtStake[0];
    expect((m.day as Date).toISOString()).toBe("2026-10-16T00:00:00.000Z");
    // Sold-out page traffic: 15 sessions × 10 fully-out days (/products/mug + /es/products/mug)
    // × conversion 60 / 3150 × AOV 50.
    expect(m.soldOutTraffic).toBeCloseTo(142.86, 2);
    // Cash stuck: C is dead, 30 units × cost 10.
    expect(m.cashStuck).toBe(300);
    // Sales at risk: B is out; demand 28 × rate 1 = 28 − incoming 24 = 4 units × 20.
    expect(m.atRisk).toBe(80);
    // Lost to sell-outs: B out 10 days × rate 1 × 20.
    expect(m.lost90).toBe(200);
    const basis = m.basis as MoneyBasisJson;
    expect(basis).toMatchObject({ currency: "EUR", refresh: "daily" });
    expect(basis.soldOutTraffic).toMatchObject({ productsSoldOut: 1, soldOutSessions: 150, aov: 50 });
  });

  it("Free plan: money only once per calendar month, metrics every run", async () => {
    await computeShop(S, { now: () => NOW, plan: async () => "free" });
    const first = db.tables.moneyAtStake[0];
    expect((first.basis as MoneyBasisJson).refresh).toBe("monthly");
    const later = Date.parse("2026-10-20T08:00:00Z");
    const r = await computeShop(S, { now: () => later, plan: async () => "free" });
    expect(r.money).toBe("not_due");
    expect(db.tables.moneyAtStake).toHaveLength(1);
    expect(db.tables.variantMetric.every((m) => (m.computedAt as Date).getTime() === later)).toBe(true);
    const nextMonth = Date.parse("2026-11-01T08:00:00Z");
    expect((await computeShop(S, { now: () => nextMonth, plan: async () => "free" })).money).toBe("computed");
    expect(db.tables.moneyAtStake).toHaveLength(2);
  });

  it("a failed plan check fails open (daily money)", async () => {
    await computeShop(S, { now: () => NOW, plan: async () => Promise.reject(new Error("partner api down")) });
    expect((db.tables.moneyAtStake[0].basis as MoneyBasisJson).refresh).toBe("daily");
  });

  it("skips unknown and uninstalled shops", async () => {
    expect(await computeShop("nope.myshopify.com", { now: () => NOW })).toEqual({ status: "skipped" });
    db.tables.shop[0].uninstalledAt = new Date();
    expect(await computeShop(S, { now: () => NOW })).toEqual({ status: "skipped" });
  });

  it("money cards are null (—) with no data, never 0", async () => {
    db.tables.salesDaily = [];
    db.tables.stockDaily = [];
    db.tables.sessionsDaily = [];
    db.tables.shopDaily = [];
    db.tables.stockNow = [];
    await computeShop(S, { now: () => NOW });
    const m = db.tables.moneyAtStake[0];
    expect(m.soldOutTraffic).toBeNull();
    expect(m.lost90).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 2.1 / 2.4: seasonality, suppliers, the action list
// ---------------------------------------------------------------------------

const action = (key: string) => db.tables.action?.find((a) => a.dedupeKey === key);

describe("computeShop — action list", () => {
  it("writes one open action per (kind, product) with the store currency", async () => {
    const r = await computeShop(S, { now: () => NOW });
    const keys = (db.tables.action ?? []).map((a) => a.dedupeKey).sort();
    expect(keys).toEqual(["bridge:PB", "clear:PC", "push:PA", "reorder:PB"]);
    expect(r.actions).toBe(4);
    for (const a of db.tables.action) expect(a).toMatchObject({ shop: S, state: "open", currency: "EUR" });
    // B is out: demand 28 × 1/day − incoming 24 = 4 units × 20 (the money card's maths).
    expect(action("reorder:PB")).toMatchObject({ kind: "reorder", productId: "PB", variantIds: [B], amount: 80 });
    expect((action("reorder:PB")!.reason as { key: string }).key).toBe("reorder_out");
    // Bridge: no dated order, order-by passed → arrives today + 14; gap 14 days × 1/day × 20.
    expect(action("bridge:PB")).toMatchObject({ amount: 280 });
    expect((action("bridge:PB")!.reason as { params: Record<string, unknown> }).params).toEqual({ gap: 14, date: "2026-10-30" });
    // C is dead: cash stuck 30 × cost 10.
    expect(action("clear:PC")).toMatchObject({ amount: 300 });
    // A: role A, healthy, flat trend → potential 2 × 28 × 25 × 20 %.
    expect(action("push:PA")).toMatchObject({ amount: 280 });
  });

  it("updates in place, keeps state / stateAmount / snoozeUntil / doneAt, deletes open rows that no longer trigger", async () => {
    const until = new Date("2026-10-20T00:00:00Z");
    db.tables.action = [
      { id: "a1", shop: S, kind: "clear", productId: "PC", dedupeKey: "clear:PC", variantIds: [], amount: 50, currency: "EUR", reason: {}, state: "snoozed", stateAmount: 50, snoozeUntil: until, doneAt: null },
      { id: "a2", shop: S, kind: "fix_page", productId: "PA", dedupeKey: "fix_page:PA", variantIds: [A], amount: 10, currency: "EUR", reason: {}, state: "open" },
      { id: "a3", shop: S, kind: "fix_sizes", productId: "PA", dedupeKey: "fix_sizes:PA", variantIds: [], amount: 10, currency: "EUR", reason: {}, state: "dismissed", stateAmount: 10 },
      { id: "a4", shop: S, kind: "reorder", productId: "PB", dedupeKey: "reorder:PB", variantIds: [], amount: 1, currency: "EUR", reason: {}, state: "done", doneAt: until },
    ];
    await computeShop(S, { now: () => NOW });
    expect(action("clear:PC")).toMatchObject({ id: "a1", amount: 300, state: "snoozed", stateAmount: 50, snoozeUntil: until, variantIds: [C] });
    expect(action("fix_page:PA")).toBeUndefined();
    expect(action("fix_sizes:PA")).toMatchObject({ id: "a3", state: "dismissed" });
    expect(action("reorder:PB")).toMatchObject({ id: "a4", state: "done", doneAt: until, amount: 80 });
    // Idempotent: a second run changes nothing.
    const before = JSON.stringify(db.tables.action);
    await computeShop(S, { now: () => NOW });
    expect(JSON.stringify(db.tables.action)).toBe(before);
  });

  it("review fix: a snoozed row whose problem is gone is deleted (it must not come back after the snooze); a dismissed one is kept; rows of archived / unknown products are purged", async () => {
    const until = new Date("2026-10-20T00:00:00Z");
    db.tables.action = [
      { id: "s1", shop: S, kind: "fix_page", productId: "PA", dedupeKey: "fix_page:PA", variantIds: [A], amount: 10, currency: "EUR", reason: {}, state: "snoozed", stateAmount: 10, snoozeUntil: until },
      { id: "s2", shop: S, kind: "fix_returns", productId: "PA", dedupeKey: "fix_returns:PA", variantIds: [A], amount: 10, currency: "EUR", reason: {}, state: "dismissed", stateAmount: 10 },
      { id: "s3", shop: S, kind: "clear", productId: "PF", dedupeKey: "clear:PF", variantIds: [DRAFT], amount: 10, currency: "EUR", reason: {}, state: "dismissed", stateAmount: 10 },
      { id: "s4", shop: S, kind: "clear", productId: "PZ", dedupeKey: "clear:PZ", variantIds: [], amount: 10, currency: "EUR", reason: {}, state: "done", doneAt: until },
    ];
    await computeShop(S, { now: () => NOW });
    expect(action("fix_page:PA")).toBeUndefined();
    expect(action("fix_returns:PA")).toMatchObject({ id: "s2", state: "dismissed" });
    expect(action("clear:PF")).toBeUndefined();
    expect(action("clear:PZ")).toBeUndefined();
  });

  it("Free plan: actions refresh with the money cards (monthly)", async () => {
    await computeShop(S, { now: () => NOW, plan: async () => "free" });
    action("clear:PC")!.amount = 1;
    const r = await computeShop(S, { now: () => Date.parse("2026-10-20T08:00:00Z"), plan: async () => "free" });
    expect(r.money).toBe("not_due");
    expect(r.actions).toBeUndefined();
    expect(action("clear:PC")!.amount).toBe(1);
  });
});

describe("computeShop — seasonality, trend, suppliers, safety level", () => {
  /** Last year's online sales for A: 2/day from Aug 2025, 4/day over the 28 days from 16 Oct 2025. */
  function seedLastYear() {
    db.tables.shop[0].backfillState = { datasets: { sales: { done: 13, total: 13, doneThrough: "2025-08-01", syncedThrough: "2026-10-15" } } };
    for (const day of daysBetween("2025-08-01", "2026-07-17")) {
      const sold = day >= "2025-10-16" && day <= "2025-11-12" ? 4 : 2;
      db.tables.salesDaily.push({ shop: S, day: d(day), variantId: A, locationKey: "online", channel: "all", sold, returned: 0, gross: 0 });
    }
  }

  it("without sales coverage every variant keeps 1.0, labelled 'No seasonal data yet'", async () => {
    await computeShop(S, { now: () => NOW });
    const inputs = metric(A).inputs as { seasonal: number; trend: number; season: Record<string, unknown> };
    expect(inputs.seasonal).toBe(1);
    expect(inputs.trend).toBe(1);
    expect(inputs.season).toMatchObject({ level: "store", seasonalApplied: false, seasonalReason: "short_history", label: "No seasonal data yet" });
  });

  it("applies the store's seasonal index to days left; the trend is measured but not applied (growth assumption off)", async () => {
    seedLastYear();
    await computeShop(S, { now: () => NOW });
    const a = metric(A);
    const inputs = a.inputs as { seasonal: number; trend: number; season: Record<string, unknown> };
    // LY horizon 4/day (3-week smoothed at its end) ÷ LY base (the rate-window blend, ≈ 2/day) → raw ≈ 1.77; one year → shrunk halfway to 1.
    const raw = (inputs.season as { seasonalRaw: number }).seasonalRaw;
    expect(raw).toBeGreaterThan(1.7);
    expect(inputs.seasonal).toBeCloseTo(1 + 0.5 * (raw - 1), 10);
    expect(inputs.season).toMatchObject({ level: "store", seasonalApplied: true, seasonalYears: 1, seasonalWeight: 0.5, horizonDays: 28, trendApplied: false, trendReason: "off", trendNote: "Not applied: the growth assumption is off" });
    // Store units now (A 2 + draft 3 + B + sparse) vs last year ≈ 2/day → clamped at 2: measured, not applied.
    expect((inputs.season as { trendMeasured: number }).trendMeasured).toBe(2);
    expect(inputs.trend).toBe(1);
  });

  it("C4: trendMode 'store' applies the trend (the old behaviour)", async () => {
    seedLastYear();
    db.tables.shop[0].settings = { trendMode: "store" };
    await computeShop(S, { now: () => NOW });
    const a = metric(A);
    const inputs = a.inputs as { seasonal: number; trend: number; season: Record<string, unknown> };
    expect(inputs.trend).toBe(2);
    expect(inputs.season).toMatchObject({ trendApplied: true, trendMode: "store", trendNote: null });
  });

  it("stores the forward plan's inputs and takes the order-by date from it (one date for every screen)", async () => {
    seedLastYear();
    await computeShop(S, { now: () => NOW });
    const a = metric(A);
    const inputs = a.inputs as { seasonCurve: (number | null)[] | null; safety: number; arrivals: unknown[]; caseQty: number | null; minOrder: number | null };
    // The index was applied → its weekly shape (LY units/day ÷ the same base) is kept, ≥ the 13 weeks + horizon.
    expect(Array.isArray(inputs.seasonCurve)).toBe(true);
    expect(inputs.seasonCurve!.length).toBeGreaterThanOrEqual(Math.ceil((91 + 28) / 7));
    expect(typeof inputs.safety).toBe("number"); // z × σ × √lead (σ is 0 for a steady 2 a day)
    expect(inputs.arrivals).toEqual([]);
    const fwd = planVariant(
      forwardInputFromMetric(
        { status: a.status as string, rate: a.rate as number, sigma: a.sigma as number, orderQty: a.orderQty as number | null, inputs: a.inputs },
        { today: "2026-10-16", pack: inputs.caseQty, moq: inputs.minOrder, notCounted: 0, days: 0 },
      ),
    );
    expect((a.orderBy as Date).toISOString().slice(0, 10)).toBe(fwd.deadline);
  });

  it("no seasonal index → no seasonal shape (the forward plan stays flat)", async () => {
    await computeShop(S, { now: () => NOW });
    expect((metric(A).inputs as { seasonCurve: unknown }).seasonCurve).toBeNull();
  });

  it("takes lead time and case pack from the supplier matched by vendor; z from the safety level", async () => {
    db.tables.supplier = [{ id: "S1", shop: S, name: "Acme", leadTimeDays: 30, minOrder: null, minOrderTotal: 500, casePack: 12, vendorMatch: ["acme co"] }];
    db.tables.variant.find((v) => v.id === A)!.vendor = "Acme Co";
    db.tables.shop[0].settings = { safetyLevel: "safe" };
    await computeShop(S, { now: () => NOW });
    const a = metric(A);
    expect(a.inputs).toMatchObject({ leadTimeDays: 30, leadTimeSource: "supplier", caseQty: 12, supplierId: "S1", z: 2.05, safetyLevel: "safe", serviceLevel: 0.98 });
    expect((a.orderQty as number) % 12).toBe(0);
    expect(metric(B).inputs).toMatchObject({ leadTimeSource: "default", z: 1.65, serviceLevel: 0.95 }); // role B on Safe
  });
});
