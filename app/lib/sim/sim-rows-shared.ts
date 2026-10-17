/**
 * A simulated store (lib/sim/store-sim-shared) as rows (pure):
 *  - what Shopify would return: ShopifyQL rows per dataset and date range (the sync's input), and a
 *    ShopifyQL client over them (`simShopifyql`) that the real sync writers read from — so sample
 *    data and the simulation tests go through the same code as a real store;
 *  - the catalogue as the sync writes it (VariantRow, LocationRow, CollectionRow, StockLevelRow),
 *    suppliers and purchase orders as the app stores them;
 *  - the fact rows directly (facts-shared builders), for tests and the sim report.
 *
 * Sales channels: "Online Store" and "Wholesale" sell from the online warehouses (ShopifyQL's
 * pos_location_name is empty → "online"), "Point of Sale" at the shop (its location name). The
 * location view and the channel view therefore cover the same units (never counted twice).
 */
import { addDays, dayIndex, type DayKey } from "../engine/dates-shared";
import type { DayRange, ParseResult, SalesRow, SalesTotalRow, SessionsRow, ShopDayRow, StockRow } from "../sync/shopifyql-shared";
import { salesByChannelFacts, salesByLocationFacts, sessionsFacts, shopDayFacts, stockFacts, locationNameIndex, type SalesFact, type StockFact } from "../sync/facts-shared";
import type { VariantRow, LocationRow, CollectionRow, StockLevelRow } from "../sync/catalog-shared";
import type { PoLine } from "../supplier-shared";
import { CHANNELS, POS, simDay, simPrice, simSupplierOf, VARIANTS_PER_PRODUCT, type SimPurchaseOrder, type SimStore, type SimVariant } from "./store-sim-shared";

/** Output day indexes of a range, clamped to the history. */
function dayIdx(store: SimStore, range: DayRange): [number, number] {
  const base = dayIndex(store.meta.from);
  const a = Math.max(0, dayIndex(range.since) - base);
  const b = Math.min(store.meta.days - 1, dayIndex(range.until) - base);
  return [a, b];
}

const ok = <T>(rows: T[]): ParseResult<T> => ({ rows, skipped: 0, missingColumns: [] });
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Net units (sold − returned) and gross sales of one variant, channel and day. */
function cell(store: SimStore, v: SimVariant, ch: number, d: number) {
  const i = v.idx * store.meta.days + d;
  const sold = store.sold[ch]![i]!;
  const ret = store.returned[ch]![i]!;
  return { net: sold - ret, returned: ret, gross: round2(sold * simPrice(v)) };
}

export type SalesView = "location" | "channel" | "both";

/**
 * Sales rows as ShopifyQL returns them for the range (one row per variant × day × group with any
 * sale or return): "location" groups by pos_location_name, "channel" by sales_channel, "both" by
 * the two together (the 3-dimension query).
 */
export function simSalesRows(store: SimStore, range: DayRange, view: SalesView): SalesRow[] {
  const [a, b] = dayIdx(store, range);
  const out: SalesRow[] = [];
  const posName = store.locations[POS]!.name;
  for (let d = a; d <= b; d++) {
    const day = simDay(store, d);
    for (const v of store.variants) {
      const cells = CHANNELS.map((_, ch) => cell(store, v, ch, d));
      if (view === "channel" || view === "both") {
        cells.forEach((c, ch) => {
          if (!c.net && !c.returned && !c.gross) return;
          out.push({ day, variantId: v.id, locationKey: view === "both" ? (ch === 1 ? posName : "online") : "unknown", channel: CHANNELS[ch]!, sold: c.net, gross: c.gross, returned: c.returned });
        });
      } else {
        const online = cells[0]!.net + cells[2]!.net;
        const pos = cells[1]!.net;
        const any = (ch: number[]) => ch.some((k) => cells[k]!.net || cells[k]!.returned);
        if (any([0, 2])) out.push({ day, variantId: v.id, locationKey: "online", channel: "unknown", sold: online, gross: 0, returned: 0 });
        if (any([1])) out.push({ day, variantId: v.id, locationKey: posName, channel: "unknown", sold: pos, gross: 0, returned: 0 });
      }
    }
  }
  return out;
}

/** Store units per day (net), the reconciliation total. */
export function simSalesTotals(store: SimStore, range: DayRange): SalesTotalRow[] {
  const [a, b] = dayIdx(store, range);
  const out: SalesTotalRow[] = [];
  for (let d = a; d <= b; d++) {
    let units = 0;
    for (const v of store.variants) for (let ch = 0; ch < CHANNELS.length; ch++) units += cell(store, v, ch, d).net;
    out.push({ day: simDay(store, d), sold: units } as SalesTotalRow);
  }
  return out;
}

/** Ending stock per variant × location × day, from the variant's first stock day, carried locations only. */
export function simStockRows(store: SimStore, range: DayRange): StockRow[] {
  const [a, b] = dayIdx(store, range);
  const out: StockRow[] = [];
  const D = store.meta.days;
  for (let d = a; d <= b; d++) {
    const day = simDay(store, d);
    for (const v of store.variants) {
      if (d < v.firstStock) continue;
      for (let loc = 0; loc < 3; loc++) {
        if (!v.at[loc]) continue;
        const end = store.stock[loc]![v.idx * D + d]!;
        out.push({ day, variantId: v.id, locationName: store.locations[loc]!.name, endUnits: end, outOfStock: end <= 0 });
      }
    }
  }
  return out;
}

/** Product page sessions (two traffic types) plus the home page. */
export function simSessionsRows(store: SimStore, range: DayRange): SessionsRow[] {
  const [a, b] = dayIdx(store, range);
  const out: SessionsRow[] = [];
  const D = store.meta.days;
  for (let d = a; d <= b; d++) {
    const day = simDay(store, d);
    let home = 0;
    for (const p of store.products) {
      const i = p.idx * D + d;
      const search = store.sessions.search[i]!;
      const direct = store.sessions.direct[i]!;
      const checkouts = store.sessions.checkouts[i]!;
      if (!search && !direct) continue;
      const path = `/products/${p.handle}`;
      const cSearch = Math.round(checkouts * 0.55);
      if (search) out.push({ day, landingPath: path, trafficType: "search", sessions: search, checkouts: cSearch });
      if (direct) out.push({ day, landingPath: path, trafficType: "direct", sessions: direct, checkouts: checkouts - cSearch });
      home += Math.round((search + direct) * 0.4);
    }
    if (home) out.push({ day, landingPath: "/", trafficType: "direct", sessions: home, checkouts: Math.round(home * 0.01) });
  }
  return out;
}

/** Orders and gross sales per day (all channels). */
export function simShopDays(store: SimStore, range: DayRange): ShopDayRow[] {
  const [a, b] = dayIdx(store, range);
  const out: ShopDayRow[] = [];
  const D = store.meta.days;
  for (let d = a; d <= b; d++) {
    let gross = 0;
    for (const v of store.variants) {
      const i = v.idx * D + d;
      gross += (store.sold[0]![i]! + store.sold[1]![i]! + store.sold[2]![i]!) * simPrice(v);
    }
    out.push({ day: simDay(store, d), orders: store.orders[d]!, gross: round2(gross) });
  }
  return out;
}

/** The ShopifyQL client the sync reads, answering from the simulated store (no network). */
export type SimShopifyql = {
  run: (query: string) => Promise<never>;
  salesDaily: (range: DayRange, today: string) => Promise<ParseResult<SalesRow>>;
  salesDailyByLocation: (range: DayRange, today: string) => Promise<ParseResult<SalesRow>>;
  salesDailyByChannel: (range: DayRange, today: string) => Promise<ParseResult<SalesRow>>;
  stockDaily: (range: DayRange, today: string) => Promise<ParseResult<StockRow>>;
  sessionsDaily: (range: DayRange, today: string) => Promise<ParseResult<SessionsRow>>;
  shopDaily: (range: DayRange, today: string) => Promise<ParseResult<ShopDayRow>>;
  salesTotalsDaily: (range: DayRange, today: string) => Promise<ParseResult<SalesTotalRow>>;
};

/** Never past yesterday (the real builders refuse `until >= today`; the sim does the same). */
function past(range: DayRange, today: string): DayRange {
  if (range.until >= today) throw new RangeError(`sim: ${range.until} is not a past day (today ${today})`);
  return range;
}

export function simShopifyql(store: SimStore): SimShopifyql {
  return {
    run: async () => {
      throw new Error("sim: raw ShopifyQL is not simulated");
    },
    salesDaily: async (r, today) => ok(simSalesRows(store, past(r, today), "both")),
    salesDailyByLocation: async (r, today) => ok(simSalesRows(store, past(r, today), "location")),
    salesDailyByChannel: async (r, today) => ok(simSalesRows(store, past(r, today), "channel")),
    stockDaily: async (r, today) => ok(simStockRows(store, past(r, today))),
    sessionsDaily: async (r, today) => ok(simSessionsRows(store, past(r, today))),
    shopDaily: async (r, today) => ok(simShopDays(store, past(r, today))),
    salesTotalsDaily: async (r, today) => ok(simSalesTotals(store, past(r, today))),
  };
}

// ── Catalogue, suppliers and orders as the app stores them ───────────────────────────────────

export function simLocationRows(store: SimStore): (LocationRow & { role: string })[] {
  return store.locations.map((l) => ({ id: l.id, name: l.name, active: l.active, online: l.online, role: l.role }));
}

export function simCollectionRows(store: SimStore): CollectionRow[] {
  return store.collections.map((c) => ({ ...c }));
}

/** Variant rows as the catalog sync writes them (Shopify's fields; supplier and case pack are ours). */
export function simVariantRows(store: SimStore): VariantRow[] {
  return store.variants.map((v) => ({
    id: v.id,
    productId: v.product.id,
    productTitle: v.product.title,
    variantTitle: v.variantTitle,
    handle: v.product.handle,
    sku: v.sku,
    vendor: v.product.vendor,
    productType: v.product.productType,
    collections: [...v.product.collections],
    image: null,
    tracked: v.product.tracked,
    isBundle: v.product.isBundle,
    status: v.product.status,
    productCreatedAt: new Date(`${v.product.createdDay}T09:00:00.000Z`),
    cost: v.cost === null ? null : v.cost.toFixed(2),
    costCurrency: v.cost === null ? null : store.meta.currency,
    price: simPrice(v).toFixed(2),
    inventoryPolicy: v.inventoryPolicy,
  }));
}

/** Keha's own variant fields (Settings → Suppliers by product, "Don't reorder", case size). */
export function simVariantOwnFields(store: SimStore): { id: string; supplierId: string | null; noReorder: boolean; caseQty: number | null }[] {
  return store.variants.map((v) => ({ id: v.id, supplierId: v.supplierId, noReorder: v.product.noReorder, caseQty: v.product.caseQty }));
}

export function simStockNowRows(store: SimStore): StockLevelRow[] {
  return store.stockNow.map((s) => ({
    variantId: store.variants[s.variantIdx]!.id,
    locationId: store.locations[s.location]!.id,
    available: s.available,
    incoming: s.incoming,
    committed: s.committed,
    onHand: s.onHand,
  }));
}

export type SimSupplierRow = {
  id: string;
  name: string;
  leadTimeDays: number;
  minOrder: number | null;
  minOrderTotal: number | null;
  casePack: number | null;
  transitDays: number | null;
  orderCycleDays: number | null;
  minOrderValue: number | null;
  minOrderScope: string;
  exchangeRate: number | null;
  currency: string | null;
  vendorMatch: string[];
  hidePrices: boolean;
};

export function simSupplierRows(store: SimStore): SimSupplierRow[] {
  return store.suppliers.map((s) => ({
    id: s.id,
    name: s.name,
    leadTimeDays: s.leadTimeDays,
    minOrder: s.minOrder,
    minOrderTotal: s.minOrderTotal,
    casePack: s.casePack,
    transitDays: s.transitDays,
    orderCycleDays: s.orderCycleDays,
    minOrderValue: s.minOrderValue,
    minOrderScope: s.minOrderScope,
    exchangeRate: s.exchangeRate,
    currency: s.currency,
    vendorMatch: [...s.vendorMatch],
    hidePrices: false,
  }));
}

export type SimPoRow = {
  id: string;
  number: string;
  source: "keha" | "shopify";
  shopifyPoId: string | null;
  supplierId: string | null;
  supplierName: string;
  status: SimPurchaseOrder["status"];
  currency: string;
  lines: PoLine[];
  createdAt: Date;
  sentAt: Date | null;
  expectedDate: Date | null;
  confirmedShipDate: Date | null;
  receivedAt: Date | null;
  cancelledAt: Date | null;
};

const at = (day: DayKey | null, hour = 10) => (day ? new Date(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`) : null);
const date = (day: DayKey | null) => (day ? new Date(`${day}T00:00:00.000Z`) : null);

/** Purchase orders as the app stores them (Keha: PO-0001…; Shopify: #PO-…, units in Shopify's incoming). */
export function simPurchaseOrderRows(store: SimStore): SimPoRow[] {
  const supplier = new Map(store.suppliers.map((s) => [s.key, s]));
  let keha = 0;
  return store.purchaseOrders.map((o) => {
    const s = supplier.get(o.supplierKey)!;
    const rate = s.exchangeRate && s.currency !== store.meta.currency ? s.exchangeRate : null;
    const lines: PoLine[] = o.lines.map((l) => {
      const v = store.variants[l.variantIdx]!;
      const unitCost = v.cost === null ? null : round2(rate ? v.cost / rate : v.cost);
      return {
        variantId: v.id,
        qty: l.qty,
        unitCost,
        productTitle: v.product.title,
        variantTitle: v.variantTitle,
        sku: v.sku,
        ...(o.status === "received" ? { received: l.qty } : {}),
      };
    });
    const shopify = o.source === "shopify";
    const number = shopify ? `#PO${1000 + o.n}` : `PO-${String(++keha).padStart(4, "0")}`;
    return {
      id: `sample-${store.meta.idPrefix}-po${o.n}`,
      number,
      source: o.source,
      shopifyPoId: shopify ? `gid://shopify/InventoryPurchaseOrder/${store.meta.idPrefix}${String(o.n).padStart(7, "0")}` : null,
      supplierId: shopify ? null : s.id,
      supplierName: s.name,
      status: o.status,
      currency: s.currency,
      lines,
      createdAt: at(o.createdDay, 9)!,
      sentAt: at(o.sentDay, 11),
      expectedDate: shopify ? null : date(o.expectedDay),
      confirmedShipDate: date(o.confirmedShipDay),
      receivedAt: at(o.receivedDay, 15),
      cancelledAt: at(o.cancelledDay, 12),
    };
  });
}

// ── Facts (what the sync writes), for tests and the report ───────────────────────────────────

export function simSalesFacts(store: SimStore, range: DayRange): SalesFact[] {
  const index = locationNameIndex(store.locations);
  return [...salesByLocationFacts(simSalesRows(store, range, "location"), range, index).facts, ...salesByChannelFacts(simSalesRows(store, range, "channel"), range)];
}

export function simStockFacts(store: SimStore, range: DayRange): StockFact[] {
  return stockFacts(simStockRows(store, range), range, locationNameIndex(store.locations)).facts;
}

export function simSessionsFacts(store: SimStore, range: DayRange) {
  return sessionsFacts(simSessionsRows(store, range), range);
}

export function simShopFacts(store: SimStore, range: DayRange) {
  return shopDayFacts(simShopDays(store, range), range);
}

/** Calendar months of the history, oldest first (the backfill's units of work). */
export function simMonths(store: SimStore): DayRange[] {
  const out: DayRange[] = [];
  let since = store.meta.from;
  while (since <= store.meta.yesterday) {
    const [y, m] = since.split("-").map(Number) as [number, number];
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const until = addDays(next, -1) < store.meta.yesterday ? addDays(next, -1) : store.meta.yesterday;
    out.push({ since, until });
    since = next;
  }
  return out;
}

/** Variants of a product (contiguous). */
export function simVariantsOf(store: SimStore, productIdx: number): SimVariant[] {
  return store.variants.slice(productIdx * VARIANTS_PER_PRODUCT, (productIdx + 1) * VARIANTS_PER_PRODUCT);
}

export { simSupplierOf };
