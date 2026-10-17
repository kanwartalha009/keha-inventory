/**
 * A deterministic store for the compute equality tests (DB scale work, 2026-10-17): the output of
 * computeShop on this store was recorded BEFORE compute was split into variant chunks and before
 * it read the stored first / last days (tests/fixtures/scale-compute-golden.json), and every later
 * version must write exactly the same VariantMetric, MoneyAtStake and Action rows.
 *
 * It covers the cases the refactor could change:
 *  - steady sellers on two pool warehouses and a POS store (Pro per-location metrics);
 *  - a long-out best seller (few in-stock days in the 90, sales before them → older series);
 *  - never-sold variants whose first stock row is at an INACTIVE location (pool first day ≠ any
 *    location's first day), and one stocked only recently;
 *  - variants that sold only before the 90-day window, and one that sold in the window on a day
 *    without a pool stock row (pre-window last sale ≠ last sale);
 *  - a variant sold only at the POS store (a pool warehouse's share series has no sale);
 *  - returns, sold-out days, an open Keha order (landed estimate), sessions and store totals,
 *    last-year sales (season / off-season / last-year revenue), draft / untracked / bundle rows.
 * Facts are written straight into the fake tables (no createMany: its duplicate check is O(n²)).
 */
import type { FakeDb } from "../helpers/fake-prisma";

export const FX_SHOP = "scale.myshopify.com";
export const FX_NOW = Date.parse("2026-10-16T08:00:00Z"); // 10:00 Madrid → today 2026-10-16
export const W1 = "gid://shopify/Location/11"; // warehouse, online
export const W2 = "gid://shopify/Location/12"; // warehouse
export const ST = "gid://shopify/Location/13"; // POS store
export const OLD = "gid://shopify/Location/14"; // closed (inactive) location with old stock rows

const FIRST_DAY = "2025-05-01";
const LAST_DAY = "2026-10-15"; // yesterday

function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
const d = (day: string) => new Date(`${day}T00:00:00.000Z`);

/** mulberry32: a small seeded PRNG so the fixture is identical on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Profile =
  | "steady"
  | "slow"
  | "longOut"
  | "neverSoldOld"
  | "neverSoldNew"
  | "soldBeforeOnly"
  | "soldOffStockDay"
  | "storeOnly"
  | "returns"
  | "seasonal";

export type FixtureOptions = {
  /** The POS store left out of supplier orders: pool demand from the location view (demandWhere). */
  excludeStore?: boolean;
  /** Variants per product cycle (default 30 variants). */
  variants?: number;
};

const PROFILES: Profile[] = ["steady", "steady", "slow", "longOut", "neverSoldOld", "neverSoldNew", "soldBeforeOnly", "soldOffStockDay", "storeOnly", "returns", "seasonal", "steady", "slow"];

export function seedScaleFixture(db: FakeDb, opts: FixtureOptions = {}): { variantIds: string[] } {
  db.reset();
  const rand = rng(20261017);
  const S = FX_SHOP;
  db.tables.shop = [
    {
      id: "shop1",
      domain: S,
      timezone: "Europe/Madrid",
      currency: "EUR",
      locale: "en",
      settings: { trendMode: "store" },
      uninstalledAt: null,
      backfillState: {
        finishedAt: "2026-10-01T00:00:00Z",
        syncedThrough: LAST_DAY,
        datasets: { sales: { done: 18, total: 18, doneThrough: FIRST_DAY, syncedThrough: LAST_DAY } },
      },
    },
  ];
  db.tables.location = [
    { id: W1, shop: S, name: "Main warehouse", active: true, online: true, role: "warehouse", onlinePool: null },
    { id: W2, shop: S, name: "Second warehouse", active: true, online: false, role: "warehouse", onlinePool: null },
    { id: ST, shop: S, name: "Madrid store", active: true, online: false, role: "store", onlinePool: opts.excludeStore ? false : null },
    { id: OLD, shop: S, name: "Closed store", active: false, online: false, role: "other", onlinePool: null },
  ];
  db.tables.supplier = [
    { id: "sup1", shop: S, name: "Acme Textiles", leadTimeDays: 30, minOrder: 10, minOrderTotal: null, casePack: 6, vendorMatch: ["Acme"], transitDays: 10 },
    { id: "sup2", shop: S, name: "Brava Mugs", leadTimeDays: 14, minOrder: null, minOrderTotal: null, casePack: null, vendorMatch: ["Brava"], transitDays: null },
  ];
  const n = opts.variants ?? 30;
  const variants: Record<string, unknown>[] = [];
  const profileOf = new Map<string, Profile>();
  for (let i = 1; i <= n; i++) {
    const id = `gid://shopify/ProductVariant/${1000 + i}`;
    const productNo = Math.ceil(i / 3);
    const profile = PROFILES[(i - 1) % PROFILES.length];
    profileOf.set(id, profile);
    variants.push({
      id,
      shop: S,
      productId: `gid://shopify/Product/${500 + productNo}`,
      productTitle: `Product ${productNo}`,
      variantTitle: `Size ${i}`,
      handle: `product-${productNo}`,
      sku: `SKU-${i}`,
      vendor: i % 2 ? "Acme" : "Brava",
      productType: null,
      collections: [i % 4 === 0 ? "gid://shopify/Collection/2" : "gid://shopify/Collection/1"],
      image: null,
      tracked: true,
      isBundle: false,
      status: "ACTIVE",
      productCreatedAt: new Date(i % 5 === 0 ? "2026-09-20T00:00:00Z" : "2025-01-15T00:00:00Z"),
      cost: 8 + (i % 7),
      costCurrency: "EUR",
      price: 20 + (i % 9) * 3,
      supplierId: null,
      caseQty: i % 6 === 0 ? 4 : null,
      noReorder: i === 7,
      inventoryPolicy: i % 8 === 0 ? "CONTINUE" : "DENY",
    });
  }
  // Rows compute must skip.
  const extra = (id: string, x: Record<string, unknown>) => ({ ...variants[0], id, productId: `gid://shopify/Product/${id.slice(-3)}`, handle: `x-${id.slice(-3)}`, ...x });
  variants.push(extra("gid://shopify/ProductVariant/9001", { status: "DRAFT" }));
  variants.push(extra("gid://shopify/ProductVariant/9002", { tracked: false }));
  variants.push(extra("gid://shopify/ProductVariant/9003", { isBundle: true }));
  db.tables.variant = variants;

  const stock: Record<string, unknown>[] = [];
  const sales: Record<string, unknown>[] = [];
  const now: Record<string, unknown>[] = [];
  const window90 = addDays(LAST_DAY, -89);
  for (const v of variants.slice(0, n)) {
    const id = v.id as string;
    const profile = profileOf.get(id)!;
    const base = profile === "steady" ? 4 : profile === "slow" ? 0.4 : profile === "seasonal" ? 2 : profile === "returns" ? 3 : 1.5;
    let level = { [W1]: 120, [W2]: 40, [ST]: 15 } as Record<string, number>;
    const stockFrom =
      profile === "neverSoldNew" ? addDays(LAST_DAY, -40) : profile === "neverSoldOld" ? addDays(FIRST_DAY, 200) : FIRST_DAY;
    for (let day = FIRST_DAY; day <= LAST_DAY; day = addDays(day, 1)) {
      const inWindow = day >= window90;
      // Old stock rows at the closed location (any-location first day < pool first day).
      if (profile === "neverSoldOld" && day < stockFrom && day >= addDays(FIRST_DAY, 30)) {
        stock.push({ shop: S, day: d(day), variantId: id, locationId: OLD, endUnits: 5, outOfStock: false });
      }
      if (day < stockFrom) continue;
      const month = Number(day.slice(5, 7));
      const season = profile === "seasonal" ? (month >= 11 || month <= 1 ? 3 : 0.5) : 1;
      let soldOnline = 0;
      let soldStore = 0;
      const sells =
        profile !== "neverSoldOld" &&
        profile !== "neverSoldNew" &&
        !(profile === "soldBeforeOnly" && inWindow) &&
        !(profile === "soldOffStockDay" && inWindow && day !== addDays(LAST_DAY, -20));
      if (sells) {
        const lam = base * season;
        soldOnline = profile === "storeOnly" ? 0 : Math.round(lam * (0.5 + rand()));
        soldStore = Math.round(lam * 0.3 * rand() * (profile === "storeOnly" ? 3 : 1));
        if (profile === "soldOffStockDay" && inWindow) soldOnline = 2;
      }
      // Long-out best seller: sold out for most of the 90 days.
      const longOut = profile === "longOut" && inWindow && day < addDays(LAST_DAY, -6);
      for (const loc of [W1, W2, ST]) {
        // The day the off-stock seller sold has no pool stock row.
        if (profile === "soldOffStockDay" && day === addDays(LAST_DAY, -20)) continue;
        const take = loc === ST ? soldStore : loc === W1 ? Math.ceil(soldOnline * 0.7) : Math.floor(soldOnline * 0.3);
        level[loc] = longOut ? 0 : Math.max(0, level[loc] - take);
        if (level[loc] <= 0 && !longOut && rand() < 0.3) level[loc] = loc === ST ? 15 : 90; // restock
        stock.push({ shop: S, day: d(day), variantId: id, locationId: loc, endUnits: level[loc], outOfStock: level[loc] <= 0 });
      }
      if (longOut) {
        soldOnline = 0;
        soldStore = 0;
      }
      const total = soldOnline + soldStore;
      const price = Number(v.price);
      const returned = profile === "returns" && total > 0 && rand() < 0.4 ? -1 : 0;
      if (total > 0 || returned !== 0) {
        // Channel view (locationKey "all"): one row per channel.
        if (soldOnline > 0) sales.push({ shop: S, day: d(day), variantId: id, locationKey: "all", channel: "Online Store", sold: soldOnline, returned, gross: soldOnline * price });
        if (soldStore > 0) sales.push({ shop: S, day: d(day), variantId: id, locationKey: "all", channel: "Point of Sale", sold: soldStore, returned: 0, gross: soldStore * price });
        // Location view (channel "all").
        if (soldOnline > 0) sales.push({ shop: S, day: d(day), variantId: id, locationKey: "online", channel: "all", sold: soldOnline, returned, gross: 0 });
        if (soldStore > 0) sales.push({ shop: S, day: d(day), variantId: id, locationKey: ST, channel: "all", sold: soldStore, returned: 0, gross: 0 });
      }
    }
    for (const loc of [W1, W2, ST]) {
      if (profile === "neverSoldOld" && loc === ST) continue;
      const onHand = level[loc] ?? 0;
      now.push({ shop: S, variantId: id, locationId: loc, available: onHand - (loc === W1 ? 1 : 0), incoming: loc === W1 && profile === "steady" ? 24 : 0, committed: 0, onHand });
    }
  }
  db.tables.stockDaily = stock;
  db.tables.salesDaily = sales;
  db.tables.stockNow = now;

  const v1 = variants[0].id as string;
  const v2 = variants[1].id as string;
  db.tables.purchaseOrder = [
    {
      id: "po1",
      shop: S,
      supplierId: "sup1",
      status: "sent",
      number: "PO-1",
      source: "keha",
      createdAt: new Date("2026-09-25T09:00:00Z"),
      sentAt: new Date("2026-09-26T09:00:00Z"),
      confirmedShipDate: null,
      expectedDate: d("2026-10-26"),
      lines: [
        { variantId: v1, qty: 60, unitCost: 9 },
        { variantId: v2, qty: 30, unitCost: 9, received: 6 },
      ],
    },
  ];
  const sessions: Record<string, unknown>[] = [];
  const shopDays: Record<string, unknown>[] = [];
  for (let day = addDays(LAST_DAY, -40); day <= LAST_DAY; day = addDays(day, 1)) {
    for (let p = 1; p <= Math.ceil(n / 3); p++) {
      sessions.push({ shop: S, day: d(day), landingPath: `/products/product-${p}`, trafficType: "direct", sessions: 5 + (p % 4), checkouts: p % 3 === 0 ? 1 : 0 });
    }
    shopDays.push({ shop: S, day: d(day), orders: 20, gross: 900 });
  }
  db.tables.sessionsDaily = sessions;
  db.tables.shopDaily = shopDays;
  db.tables.action = [];
  db.tables.variantMetric = [];
  db.tables.moneyAtStake = [];
  return { variantIds: variants.map((v) => v.id as string) };
}

/** Everything computeShop writes, in a stable order and without generated ids / clocks. */
export function computeOutput(db: FakeDb): unknown {
  const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
  const metrics = (db.tables.variantMetric ?? [])
    .map((m) => plain(m) as Record<string, unknown>)
    .sort((a, b) => `${a.scope}|${a.variantId}`.localeCompare(`${b.scope}|${b.variantId}`));
  const money = (db.tables.moneyAtStake ?? []).map((m) => plain(m));
  const actions = (db.tables.action ?? [])
    .map((a) => {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = plain(a) as Record<string, unknown>;
      return rest;
    })
    .sort((a, b) => String(a.dedupeKey).localeCompare(String(b.dedupeKey)));
  return { metrics, money, actions };
}
