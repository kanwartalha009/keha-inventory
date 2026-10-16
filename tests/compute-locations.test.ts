/**
 * Phase 3 compute (Pro `locations`): the "counts for online sales" override in the online
 * pool, and one VariantMetric per variant × warehouse / store (scope = Location.id) from the
 * location's own sales view and stock — never the channel view — with stale scopes removed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ variantMetric: ["shop", "variantId", "scope"], moneyAtStake: ["shop", "day"] });
  return { default: db.client, __fake: db };
});
vi.mock("../app/services/entitlements.server", () => ({ planFor: async () => "pro" }));

import * as dbModule from "../app/db.server";
import { computeShop } from "../app/services/compute.server";
import { addDays } from "../app/lib/sync/shopifyql-shared";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const NOW = Date.parse("2026-10-16T08:00:00Z");
const d = (day: string) => new Date(`${day}T00:00:00.000Z`);
const WH = "gid://shopify/Location/1"; // warehouse, fulfils online orders
const SHOP1 = "gid://shopify/Location/2"; // POS store, not online
const CLOSED = "gid://shopify/Location/3"; // a store that was closed (inactive)
const OFFICE = "gid://shopify/Location/4"; // role other
const A = "gid://shopify/ProductVariant/1";
const C = "gid://shopify/ProductVariant/3"; // not carried at the store

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let x = from; x <= to; x = addDays(x, 1)) out.push(x);
  return out;
}

function seed() {
  db.reset();
  db.tables.shop = [{ domain: S, timezone: "Europe/Madrid", currency: "EUR", settings: {}, uninstalledAt: null }];
  db.tables.location = [
    { id: WH, shop: S, name: "Warehouse", active: true, online: true, role: "warehouse", onlinePool: null },
    { id: SHOP1, shop: S, name: "Barcelona", active: true, online: false, role: "store", onlinePool: null },
    { id: CLOSED, shop: S, name: "Old shop", active: false, online: false, role: "store", onlinePool: null },
    { id: OFFICE, shop: S, name: "Office", active: true, online: false, role: "other", onlinePool: null },
  ];
  const v = (id: string, productId: string, handle: string) => ({
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
    collections: [],
  });
  db.tables.variant = [v(A, "PA", "tee"), v(C, "PC", "cap")];
  db.tables.salesDaily = [];
  db.tables.stockDaily = [];
  const all = daysBetween("2026-07-18", "2026-10-15");
  for (const day of all) {
    const storeOut = day >= "2026-10-06"; // the store sold out for the last 10 days
    // Location view: 2/day online, 7/day at the store while it had stock.
    db.tables.salesDaily.push({ shop: S, day: d(day), variantId: A, locationKey: "online", channel: "all", sold: 2, returned: 0, gross: 0 });
    if (!storeOut) db.tables.salesDaily.push({ shop: S, day: d(day), variantId: A, locationKey: SHOP1, channel: "all", sold: 7, returned: 0, gross: 0 });
    // Channel view of the same sales: must never be added to the location view.
    db.tables.salesDaily.push({ shop: S, day: d(day), variantId: A, locationKey: "all", channel: "Online Store", sold: 2, returned: 0, gross: 50 });
    if (!storeOut) db.tables.salesDaily.push({ shop: S, day: d(day), variantId: A, locationKey: "all", channel: "Point of Sale", sold: 7, returned: 0, gross: 175 });
    db.tables.stockDaily.push({ shop: S, day: d(day), variantId: A, locationId: WH, endUnits: 300, outOfStock: false });
    db.tables.stockDaily.push({ shop: S, day: d(day), variantId: A, locationId: SHOP1, endUnits: storeOut ? 0 : 20, outOfStock: storeOut });
    db.tables.stockDaily.push({ shop: S, day: d(day), variantId: C, locationId: WH, endUnits: 30, outOfStock: false });
  }
  db.tables.stockNow = [
    { shop: S, variantId: A, locationId: WH, onHand: 300, incoming: 0 },
    { shop: S, variantId: A, locationId: SHOP1, onHand: 0, incoming: 0 },
    { shop: S, variantId: C, locationId: WH, onHand: 30, incoming: 0 },
  ];
  db.tables.sessionsDaily = [];
  db.tables.shopDaily = [];
  db.tables.moneyAtStake = [];
  db.tables.variantMetric = [
    // Stale: an inactive store, a deleted location, a variant no longer carried at the store.
    { shop: S, variantId: A, scope: CLOSED, computedAt: new Date("2026-10-01T00:00:00Z") },
    { shop: S, variantId: A, scope: "gid://shopify/Location/99", computedAt: new Date("2026-10-01T00:00:00Z") },
    { shop: S, variantId: C, scope: SHOP1, computedAt: new Date("2026-10-01T00:00:00Z") },
  ];
}

const metric = (id: string, scope: string) => db.tables.variantMetric.find((m) => m.variantId === id && m.scope === scope);

beforeEach(seed);

describe("per-location metrics (Pro)", () => {
  it("writes a store metric from the store's own sales view and stock, with sold-out days left out", async () => {
    const r = await computeShop(S, { now: () => NOW });
    expect(r.status).toBe("computed");
    const m = metric(A, SHOP1)!;
    expect(m).toBeDefined();
    // 7 a day on the days it had stock — not 9 (online + store), not 14 (both views added).
    expect(m.rate).toBeCloseTo(7, 10);
    expect(m.status).toBe("out");
    expect(m.daysLeft).toBe(0);
    expect((m.inputs as { location: string; onHand: number; outOfStockDays: number }).location).toBe(SHOP1);
    expect((m.inputs as { onHand: number }).onHand).toBe(0);
    expect((m.inputs as { outOfStockDays: number }).outOfStockDays).toBe(10);
    expect(m.orderQty).toBeGreaterThan(0);
  });

  it("the online pool is unchanged by the store (its POS sales and stock stay out)", async () => {
    await computeShop(S, { now: () => NOW });
    const online = metric(A, "online")!;
    expect(online.rate).toBeCloseTo(2, 10);
    expect((online.inputs as { onHand: number }).onHand).toBe(300);
  });

  it("writes a warehouse metric from the warehouse's own (POS) sales: none here", async () => {
    await computeShop(S, { now: () => NOW });
    const w = metric(A, WH)!;
    expect(w.rate).toBe(0);
    expect(w.neverRunsOut).toBe(true);
    expect((w.inputs as { onHand: number }).onHand).toBe(300);
    expect(metric(C, WH)).toBeDefined();
  });

  it("reuses the online pool's seasonal × trend and ABC role", async () => {
    await computeShop(S, { now: () => NOW });
    const online = metric(A, "online")!;
    const store = metric(A, SHOP1)!;
    expect(store.role).toBe(online.role);
    expect((store.inputs as { seasonal: number; trend: number }).seasonal).toBe((online.inputs as { seasonal: number }).seasonal);
    expect((store.inputs as { trend: number }).trend).toBe((online.inputs as { trend: number }).trend);
  });

  it("skips variants a location doesn't carry, and other / inactive locations", async () => {
    await computeShop(S, { now: () => NOW });
    expect(metric(C, SHOP1)).toBeUndefined(); // stale row removed, none written
    expect(db.tables.variantMetric.some((m) => m.scope === OFFICE)).toBe(false);
    expect(db.tables.variantMetric.some((m) => m.scope === CLOSED)).toBe(false);
    expect(db.tables.variantMetric.some((m) => m.scope === "gid://shopify/Location/99")).toBe(false);
    expect([...new Set(db.tables.variantMetric.map((m) => m.scope))].sort()).toEqual([WH, SHOP1, "online"].sort());
  });

  it("a location whose role goes back to other loses its rows on the next run", async () => {
    await computeShop(S, { now: () => NOW });
    expect(metric(A, SHOP1)).toBeDefined();
    db.tables.location.find((l) => l.id === SHOP1)!.role = "other";
    await computeShop(S, { now: () => NOW + 3_600_000 });
    expect(db.tables.variantMetric.some((m) => m.scope === SHOP1)).toBe(false);
  });

  it("Growth: no location rows, and earlier ones are removed (the switcher ignores them below Pro)", async () => {
    await computeShop(S, { now: () => NOW });
    expect(db.tables.variantMetric.some((m) => m.scope === SHOP1)).toBe(true);
    const r = await computeShop(S, { now: () => NOW, plan: async () => "growth" });
    expect(r.locationMetrics).toBe(0);
    expect(db.tables.variantMetric.every((m) => m.scope === "online")).toBe(true);
  });

  it("a failed plan check fails open: locations are computed", async () => {
    const r = await computeShop(S, { now: () => NOW, plan: async () => Promise.reject(new Error("down")) });
    expect(r.locationMetrics).toBeGreaterThan(0);
  });
});

describe("online pool: counts for online sales", () => {
  it("a store set to count joins the pool (its stock and its POS sales)", async () => {
    db.tables.location.find((l) => l.id === SHOP1)!.onlinePool = true;
    await computeShop(S, { now: () => NOW, plan: async () => "growth" });
    const a = metric(A, "online")!;
    // Pooled stock 300 + 0 > 0 every day; sales 2 online + 7 at the store while it sold.
    expect((a.inputs as { onHand: number }).onHand).toBe(300);
    expect(a.rate).toBeGreaterThan(2);
  });

  it("a warehouse set to No leaves the pool (follow Shopify is the default)", async () => {
    db.tables.location.find((l) => l.id === WH)!.onlinePool = false;
    db.tables.location.find((l) => l.id === SHOP1)!.onlinePool = true;
    await computeShop(S, { now: () => NOW, plan: async () => "growth" });
    const a = metric(A, "online")!;
    expect((a.inputs as { onHand: number }).onHand).toBe(0); // only the store's stock now
  });

  it("the override applies on every plan (a downgrade keeps the earlier choice)", async () => {
    db.tables.location.find((l) => l.id === WH)!.onlinePool = false;
    db.tables.location.find((l) => l.id === SHOP1)!.onlinePool = true;
    await computeShop(S, { now: () => NOW, plan: async () => "free" });
    expect((metric(A, "online")!.inputs as { onHand: number }).onHand).toBe(0);
  });
});
