/**
 * The store simulator (lib/sim): deterministic, the sizes the owner asked for, a realistic mix
 * (seasons, suppliers with their terms, lifecycles, CONTINUE / DENY, returns, wholesale, POS-only,
 * bundles, gift card, missing costs, open orders), stock that follows sales, returns, deliveries
 * and transfers day by day, and rows in the shapes the sync reads and writes — the location view
 * and the channel view of sales hold the same units (never counted twice).
 */
import { describe, expect, it } from "vitest";
import { CHANNELS, POS, SIM_PRODUCTS, W1, W2, blackFriday, seasonFactor, simulateStore, splitByShares, type SimStore } from "../app/lib/sim/store-sim-shared";
import { simMonths, simPurchaseOrderRows, simSalesFacts, simSalesRows, simSalesTotals, simShopifyql, simStockFacts, simStockNowRows, simStockRows, simVariantRows } from "../app/lib/sim/sim-rows-shared";
import { ALL } from "../app/lib/sync/facts-shared";
import { normaliseVariantId } from "../app/lib/sync/shopifyql-shared";
import { variantGid, variantNumericId } from "../app/lib/products-shared";

const TODAY = "2026-10-19";
const s = simulateStore({ size: "S", today: TODAY });

describe("simulateStore", () => {
  it("is deterministic: the same options give the same store", () => {
    const again = simulateStore({ size: "S", today: TODAY });
    expect(again.variants.map((v) => [v.id, v.product.title, v.variantTitle, v.cost, v.inventoryPolicy])).toEqual(s.variants.map((v) => [v.id, v.product.title, v.variantTitle, v.cost, v.inventoryPolicy]));
    for (let loc = 0; loc < 3; loc++) expect(Buffer.from(again.stock[loc]!.buffer).equals(Buffer.from(s.stock[loc]!.buffer))).toBe(true);
    for (let ch = 0; ch < 3; ch++) expect(Buffer.from(again.sold[ch]!.buffer).equals(Buffer.from(s.sold[ch]!.buffer))).toBe(true);
    expect(again.purchaseOrders).toEqual(s.purchaseOrders);
    const other = simulateStore({ size: "S", today: TODAY, seed: 7 });
    expect(Buffer.from(other.sold[0]!.buffer).equals(Buffer.from(s.sold[0]!.buffer))).toBe(false);
  }, 60_000);

  it("S = 60 products / 300 variants over 14 calendar months ending yesterday; M = 600 / 3,000", () => {
    expect(SIM_PRODUCTS).toMatchObject({ S: 60, M: 600 });
    expect(s.products).toHaveLength(60);
    expect(s.variants).toHaveLength(300);
    expect(s.meta.yesterday).toBe("2026-10-18");
    expect(s.meta.from).toBe("2025-09-01");
    expect(simMonths(s)).toHaveLength(14);
    expect(simMonths(s).at(-1)).toEqual({ since: "2026-10-01", until: "2026-10-18" });
    const m = simulateStore({ size: "M", today: TODAY });
    expect([m.products.length, m.variants.length, m.suppliers.length]).toEqual([600, 3000, 6]);
    const custom = simulateStore({ products: 25, today: TODAY });
    expect([custom.products.length, custom.meta.size]).toEqual([25, "custom"]);
  }, 60_000);

  it("ids are numeric Shopify gids in a reserved range the screens can read back", () => {
    for (const v of s.variants) {
      expect(normaliseVariantId(v.id)).toBe(v.id);
      expect(variantGid(variantNumericId(v.id))).toBe(v.id);
      expect(variantNumericId(v.id)).toMatch(/^99\d{15}$/);
    }
    const prefixed = simulateStore({ size: "S", today: TODAY, idPrefix: "9912345678" });
    expect(prefixed.variants[0]!.id).toBe("gid://shopify/ProductVariant/99123456780000001");
    expect(prefixed.locations[0]!.id).toBe("gid://shopify/Location/99123456780000001");
  }, 60_000);

  it("an apparel store's mix: seasons, suppliers and their terms, three locations, every lifecycle", () => {
    expect(s.locations.map((l) => [l.name, l.online, l.role])).toEqual([
      ["Main warehouse", true, "warehouse"],
      ["Second warehouse", true, "warehouse"],
      ["Madrid shop", false, "store"],
    ]);
    const sup = new Map(s.suppliers.map((x) => [x.key, x]));
    expect([...sup.keys()]).toEqual(["ningbo", "guangzhou", "istanbul", "porto", "lisbon"]);
    expect(sup.get("ningbo")).toMatchObject({ country: "CN", leadTimeDays: 75, transitDays: 35, minOrder: 60, minOrderScope: "product", casePack: 10, currency: "USD", exchangeRate: 0.92 });
    expect(sup.get("porto")).toMatchObject({ minOrderScope: "variant", minOrderTotal: 120 });
    expect(sup.get("lisbon")).toMatchObject({ viaShopify: true, minOrderValue: 500, orderCycleDays: 14 });
    for (const x of s.suppliers) expect(x.leadTimeDays).toBeGreaterThanOrEqual(10);
    expect(new Set(s.products.map((p) => p.season))).toEqual(new Set(["winter", "summer", "all"]));
    const life = new Set(s.products.map((p) => p.lifecycle));
    for (const l of ["normal", "new", "brandNew", "discontinued", "archived", "draft", "flop", "overstock", "oversold"]) expect(life.has(l as never), l).toBe(true);
    expect(s.products.some((p) => p.noReorder)).toBe(true);
    expect(s.products.some((p) => p.isBundle)).toBe(true);
    expect(s.products.some((p) => !p.tracked)).toBe(true); // the gift card
    expect(s.products.some((p) => p.posOnly)).toBe(true);
    expect(s.products.some((p) => p.supplierKey === null && p.tracked && !p.isBundle)).toBe(true); // grouped by vendor
    expect(s.variants.some((v) => v.cost === null && v.product.tracked)).toBe(true); // missing cost prices
    expect(s.variants.some((v) => v.supplierId !== null)).toBe(true); // assigned by product, not vendor
    expect(s.variants.filter((v) => v.inventoryPolicy === "CONTINUE").length).toBeGreaterThan(5);
    expect(s.collections[0]).toMatchObject({ title: "All products" });
    for (const p of s.products) expect(p.collections[0]).toBe(s.collections[0]!.id);
  });

  it("demand has a season, Black Friday and a weekly shape; sales include POS, wholesale and returns", () => {
    expect(blackFriday(2025)).toBe("2025-11-28");
    expect(blackFriday(2026)).toBe("2026-11-27");
    expect(seasonFactor("winter", "2025-12-20")).toBeGreaterThan(2);
    expect(seasonFactor("winter", "2026-07-01")).toBeLessThan(0.5);
    expect(seasonFactor("summer", "2026-06-30")).toBeGreaterThan(2);
    const D = s.meta.days;
    const day = (d: string) => (Date.parse(d) - Date.parse(s.meta.from)) / 86_400_000;
    const total = (d: number) => s.variants.reduce((a, v) => a + s.sold[0]![v.idx * D + d]! + s.sold[1]![v.idx * D + d]! + s.sold[2]![v.idx * D + d]!, 0);
    const bf = day("2025-11-28");
    expect(total(bf)).toBeGreaterThan(2.5 * total(bf - 14));
    const sum = (arr: Int32Array) => arr.reduce((a, b) => a + b, 0);
    expect(sum(s.sold[1]!)).toBeGreaterThan(0.1 * sum(s.sold[0]!)); // POS
    expect(sum(s.sold[2]!)).toBeGreaterThan(0); // wholesale
    expect(sum(s.returned[0]!)).toBeGreaterThan(0.03 * sum(s.sold[0]!));
    // Winter items sell more in December than in July.
    const winter = s.variants.filter((v) => v.product.season === "winter");
    const month = (from: string, days: number) => winter.reduce((a, v) => { let n = 0; for (let d = day(from); d < day(from) + days; d++) n += s.sold[0]![v.idx * D + d]!; return a + n; }, 0);
    expect(month("2025-12-01", 31)).toBeGreaterThan(3 * month("2026-07-01", 31));
  }, 60_000);

  it("stock follows sales, returns, deliveries and transfers every day; DENY never goes below zero", () => {
    const D = s.meta.days;
    // Stock moves per location (deliveries and transfers), dense like the stock arrays.
    const moves = [new Int32Array(s.variants.length * D), new Int32Array(s.variants.length * D), new Int32Array(s.variants.length * D)];
    for (const e of s.ledger) moves[e.location]![e.variantIdx * D + e.day] += e.units;
    const broken: string[] = [];
    let checked = 0;
    for (const v of s.variants) {
      if (!v.product.tracked || v.product.isBundle) continue;
      const restockAt = v.at[W1] ? W1 : POS;
      const pool = (i: number) => (v.at[W1] ? s.stock[W1]![i]! : 0) + (v.at[W2] ? s.stock[W2]![i]! : 0) + (v.at[POS] ? s.stock[POS]![i]! : 0);
      for (let d = Math.max(1, v.firstStock + 1); d < D; d++) {
        const i = v.idx * D + d;
        const sold = s.sold[0]![i]! + s.sold[1]![i]! + s.sold[2]![i]!;
        const deliveries = moves[W1]![i]! + moves[W2]![i]! + moves[POS]![i]!;
        // Transfers move stock between the locations: the pool only changes by sales, returns and deliveries.
        if (pool(i) - pool(i - 1) !== -sold + s.returned[0]![i]! + deliveries) broken.push(`${v.id} day ${d}`);
        // The POS shop: its own sales, transfers in, deliveries (POS-only items) and their returns.
        if (v.at[POS]) {
          const posReturns = restockAt === POS ? s.returned[0]![i]! : 0;
          if (s.stock[POS]![i]! - s.stock[POS]![i - 1]! !== -s.sold[1]![i]! + moves[POS]![i]! + posReturns) broken.push(`${v.id} POS day ${d}`);
        }
        checked++;
      }
      if (v.inventoryPolicy === "DENY") for (let loc = 0; loc < 3; loc++) if (v.at[loc]) for (let d = v.firstStock; d < D; d++) if (s.stock[loc]![v.idx * D + d]! < 0) broken.push(`${v.id} DENY below 0`);
    }
    expect(broken).toEqual([]);
    expect(checked).toBeGreaterThan(50_000);
    // CONTINUE variants oversell: negative stock, backorders owed.
    expect(s.stockNow.some((x) => x.available < 0 && s.variants[x.variantIdx]!.inventoryPolicy === "CONTINUE")).toBe(true);
    for (const x of s.stockNow) expect(x.available).toBe(x.onHand - x.committed);
    // DENY variants run out: demand they couldn't serve is lost.
    expect(s.variants.filter((v) => v.inventoryPolicy === "DENY" && s.truth.lost[v.idx]! > 0).length).toBeGreaterThan(10);
  }, 60_000);

  it("the location view and the channel view of sales hold the same units every day (never twice), as the totals", () => {
    for (const m of simMonths(s).slice(-3)) {
      const byDay = (rows: { day: string; sold: number }[]) => {
        const out = new Map<string, number>();
        for (const r of rows) out.set(r.day, (out.get(r.day) ?? 0) + r.sold);
        return out;
      };
      const loc = byDay(simSalesRows(s, m, "location"));
      const ch = byDay(simSalesRows(s, m, "channel"));
      const both = byDay(simSalesRows(s, m, "both"));
      const totals = byDay(simSalesTotals(s, m));
      expect(loc).toEqual(totals);
      expect(ch).toEqual(totals);
      expect(both).toEqual(totals);
      // As the sync stores them: two views told apart by the "all" sentinel.
      const facts = simSalesFacts(s, m);
      const locSum = facts.filter((f) => f.channel === ALL).reduce((a, f) => a + f.sold, 0);
      const chSum = facts.filter((f) => f.locationKey === ALL).reduce((a, f) => a + f.sold, 0);
      expect(locSum).toBe(chSum);
      expect(new Set(simSalesRows(s, m, "channel").map((r) => r.channel))).toEqual(new Set(CHANNELS));
    }
  }, 60_000);

  it("rows have the sync's shapes: stock rows per carried location from the first stock day, facts by location id", async () => {
    const m = simMonths(s).at(-1)!;
    const rows = simStockRows(s, m);
    const days = (Date.parse(m.until) - Date.parse(m.since)) / 86_400_000 + 1;
    const carried = s.variants.filter((v) => v.firstStock <= s.meta.days - days).reduce((a, v) => a + v.at.filter(Boolean).length, 0);
    expect(rows.length).toBeGreaterThanOrEqual(carried * days);
    const facts = simStockFacts(s, m);
    expect(facts).toHaveLength(rows.length);
    expect(new Set(facts.map((f) => f.locationId))).toEqual(new Set(s.locations.map((l) => l.id)));
    for (const f of facts) expect(f.outOfStock).toBe(f.endUnits <= 0);
    // The ShopifyQL client answers past days only, like the real builders.
    const ql = simShopifyql(s);
    await expect(ql.stockDaily({ since: m.since, until: TODAY }, TODAY)).rejects.toThrow(/not a past day/);
    expect((await ql.salesDailyByChannel(m, TODAY)).rows.length).toBeGreaterThan(0);
    // Catalogue rows: Shopify's fields, decimals as strings, missing cost = null (never 0).
    const vr = simVariantRows(s);
    expect(vr.find((v) => v.cost === null && v.tracked)).toBeTruthy();
    expect(vr.every((v) => v.cost === null || /^\d+\.\d{2}$/.test(v.cost))).toBe(true);
    expect(simStockNowRows(s).every((r) => Number.isInteger(r.available))).toBe(true);
  }, 60_000);

  it("open purchase orders: Keha (sent, confirmed with a ship date, a fresh and a stale draft) and Shopify (in Shopify's incoming)", () => {
    const pos = simPurchaseOrderRows(s);
    const status = (src: string, st: string) => pos.filter((p) => p.source === src && p.status === st).length;
    expect(status("keha", "confirmed")).toBeGreaterThan(0);
    expect(status("keha", "draft")).toBe(2);
    expect(status("keha", "received")).toBeGreaterThan(0);
    expect(status("keha", "cancelled")).toBe(1);
    expect(pos.some((p) => p.source === "shopify" && (p.status === "sent" || p.status === "received"))).toBe(true);
    for (const p of pos.filter((x) => x.status === "confirmed")) expect(p.confirmedShipDate).toBeInstanceOf(Date);
    for (const p of pos) {
      expect(p.lines.length).toBeGreaterThan(0);
      for (const l of p.lines) expect(Number.isInteger(l.qty) && l.qty > 0).toBe(true);
    }
    expect(new Set(pos.map((p) => p.number)).size).toBe(pos.length);
    // Shopify orders on their way are in Shopify's incoming at the receiving location.
    const openShopify = s.purchaseOrders.filter((o) => o.source === "shopify" && o.status === "sent");
    const incoming = s.stockNow.reduce((a, x) => a + x.incoming, 0);
    expect(incoming).toBe(openShopify.reduce((a, o) => a + o.lines.reduce((b, l) => b + l.qty, 0), 0));
  });

  it("splitByShares keeps the total and follows the shares", () => {
    expect(splitByShares(10, [0.5, 0.3, 0.2])).toEqual([5, 3, 2]);
    expect(splitByShares(7, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(7);
  });
});

export type { SimStore };
