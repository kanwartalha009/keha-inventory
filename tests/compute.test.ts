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
    ...extra,
  });
  db.tables.variant = [
    v(A, "PA", "tee"),
    v(B, "PB", "mug", { price: 20 }),
    v(C, "PC", "old"),
    v(BUNDLE, "PD", "box", { isBundle: true }),
    v(UNTRACKED, "PE", "card", { tracked: false }),
  ];
  db.tables.salesDaily = [];
  db.tables.stockDaily = [];
  const all = daysBetween("2026-07-18", "2026-10-15"); // the 90 days before today
  for (const day of all) {
    // A: 2 a day online, in stock; location-view rows must be ignored.
    db.tables.salesDaily.push({ shop: S, day: d(day), variantId: A, locationKey: "all", channel: "Online Store", sold: 2, returned: 0, gross: 50 });
    db.tables.salesDaily.push({ shop: S, day: d(day), variantId: A, locationKey: "online", channel: "all", sold: 999, returned: 0, gross: 0 });
    db.tables.stockDaily.push({ shop: S, day: d(day), variantId: A, locationId: L1, endUnits: 100, outOfStock: false });
    db.tables.stockDaily.push({ shop: S, day: d(day), variantId: A, locationId: L2, endUnits: 5, outOfStock: false });
    // B: sells 1 a day until it sells out on 6 Oct.
    const out = day >= "2026-10-06";
    if (!out) db.tables.salesDaily.push({ shop: S, day: d(day), variantId: B, locationKey: "all", channel: "Online Store", sold: 1, returned: 0, gross: 20 });
    db.tables.stockDaily.push({ shop: S, day: d(day), variantId: B, locationId: L1, endUnits: out ? 0 : 20, outOfStock: out });
    // C: stock, never sells.
    db.tables.stockDaily.push({ shop: S, day: d(day), variantId: C, locationId: L1, endUnits: 30, outOfStock: false });
    // BUNDLE: sells, must be skipped.
    db.tables.salesDaily.push({ shop: S, day: d(day), variantId: BUNDLE, locationKey: "all", channel: "Online Store", sold: 5, returned: 0, gross: 300 });
  }
  db.tables.stockNow = [
    { shop: S, variantId: A, locationId: L1, onHand: 100, incoming: 0 },
    { shop: S, variantId: A, locationId: L2, onHand: 50, incoming: 0 }, // not in the online pool
    { shop: S, variantId: B, locationId: L1, onHand: 0, incoming: 24 },
    { shop: S, variantId: C, locationId: L1, onHand: 30, incoming: 0 },
  ];
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
  db.tables.variantMetric = [{ shop: S, variantId: "gid://shopify/ProductVariant/999", scope: "online", computedAt: new Date("2026-10-01T00:00:00Z") }];
  db.tables.moneyAtStake = [];
}

const metric = (id: string) => db.tables.variantMetric.find((m) => m.variantId === id)!;

beforeEach(seed);

describe("computeShop", () => {
  it("writes one online metric per tracked, non-bundle variant and drops stale ones", async () => {
    const r = await computeShop(S, { now: () => NOW });
    expect(r).toEqual({ status: "computed", today: "2026-10-16", variants: 3, money: "computed" });
    expect(db.tables.variantMetric.map((m) => m.variantId).sort()).toEqual([A, B, C]);
    expect(db.tables.variantMetric.every((m) => m.scope === "online" && (m.computedAt as Date).getTime() === NOW)).toBe(true);
  });

  it("uses the channel view and the online pool only", async () => {
    await computeShop(S, { now: () => NOW });
    const a = metric(A);
    expect(a.rate).toBeCloseTo(2, 10); // not 999 + 2, not affected by the store location
    expect(a.daysLeft).toBeCloseTo(50, 10); // 100 pooled units ÷ 2/day (L2's 50 not counted)
    expect(a.status).toBe("healthy");
    expect(a.role).toBe("A");
    expect((a.inputs as { onHand: number }).onHand).toBe(100);
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
