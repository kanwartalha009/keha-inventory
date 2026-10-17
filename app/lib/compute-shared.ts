/**
 * Compute — pure part (spec §7, task 1.5): stored daily facts → engine inputs, and engine
 * results → stored rows. No I/O.
 *
 * Online pool rule (spec §3: one stock pool on Free / Growth; per-location planning is Pro;
 * spec §7.1 "Online pool" = the sum over active, fulfillsOnlineOrders locations; §5.5 the
 * merchant may override which locations count, Pro):
 * scope "online" =
 *   pool:  the ACTIVE locations that count for online sales: the merchant's override
 *          (Location.onlinePool) when set, else Shopify's fulfillsOnlineOrders. The override
 *          applies on every plan (a downgrade keeps the merchant's earlier choice; changing it
 *          is Pro). Online orders are keyed "online" in the sales view whichever location
 *          fulfils them, so the override moves STOCK in or out of the pool, plus the POS
 *          sales of a store the merchant adds;
 *   sales: the SalesDaily LOCATION view (channel "all") for locationKey "online" (sales with
 *          no POS location) plus the pool location ids — never the channel view, which
 *          includes POS stores outside the pool;
 *   stock: Σ StockDaily over the pool; a day is SOLD OUT when the pooled ending units are ≤ 0
 *          OR every pooled location that reported that day reported out of stock — AND
 *          nothing sold that day (a day that still sold is a backorder / continue-selling day:
 *          in stock, audit H1);
 *   data:  a day counts only when the variant has a pool StockDaily row that day; sales on a
 *          day without one are MISSING data, never "in stock";
 *   onHand / incoming: Σ StockNow over the pool.
 * The channel view (locationKey "all") is used only for revenue (ABC) and the unit price.
 */
import type { DailyRow, EngineSettings, VariantResult } from "./engine/index-shared";
import type { ProductTraffic, StoreConversion } from "./engine/money-shared";
import type { Coverage } from "./engine/season-shared";
import { zForSafetyLevel } from "./engine/safety-shared";
import { addDays } from "./engine/dates-shared";
import type { ActionDraft } from "./actions-shared";
import { DONE_REOPEN_DAYS, dedupeKey } from "./actions-shared";
import type { BackfillState } from "./sync/backfill-shared";
import type { ShopSettings } from "./settings-shared";
import { poArrival } from "./supplier-shared";

export const SCOPE_ONLINE = "online";

/** Rows of facts the server reads (already grouped by variant × day in SQL). */
export type SalesDay = { variantId: string; day: string; sold: number; gross: number };
export type PooledStockDay = {
  variantId: string;
  day: string;
  /** Σ endUnits over the pooled locations that reported this day. */
  endUnits: number;
  /** Pooled locations with a row that day. */
  reported: number;
  /** …of which reported out of stock. */
  outReported: number;
};

/** A Location as the pool rule reads it. `onlinePool` null / absent = follow Shopify (`online`). */
export type PoolLocation = { id: string; active: boolean; online: boolean; onlinePool?: boolean | null };

/** The Location columns every pool reader selects (keep the override in every select). */
export const POOL_LOCATION_SELECT = { id: true, active: true, online: true, onlinePool: true } as const;

/** Does this location count for online sales? Active, and the override when set, else Shopify's flag. */
export function countsForOnline(l: Omit<PoolLocation, "id">): boolean {
  return l.active && (l.onlinePool ?? l.online);
}

export function poolLocationIds(locations: PoolLocation[]): string[] {
  return locations.filter(countsForOnline).map((l) => l.id);
}

export function pooledOutOfStock(s: Pick<PooledStockDay, "endUnits" | "reported" | "outReported">): boolean {
  return s.endUnits <= 0 || (s.reported > 0 && s.outReported === s.reported);
}

/** SalesDaily location-view keys that belong to the online pool. */
export function poolSalesKeys(pool: string[]): string[] {
  return ["online", ...pool];
}

/**
 * Per-variant daily series. A day exists only when the variant has a pool stock row that
 * day (no row = missing data, never a zero-sale or in-stock day). `poolSales` (location view,
 * pool keys) gives units sold; `priceSales` (channel view) gives the day's unit price as
 * gross ÷ units.
 */
export function buildSeries(poolSales: SalesDay[], stock: PooledStockDay[], priceSales: SalesDay[] = []): Map<string, DailyRow[]> {
  const byVariant = new Map<string, Map<string, DailyRow>>();
  for (const s of stock) {
    let days = byVariant.get(s.variantId);
    if (!days) byVariant.set(s.variantId, (days = new Map()));
    days.set(s.day, { day: s.day, sold: 0, endStock: s.endUnits, outOfStock: pooledOutOfStock(s), price: null });
  }
  for (const s of poolSales) {
    const r = byVariant.get(s.variantId)?.get(s.day);
    if (r) r.sold += s.sold; // a sale on a day without pool stock data stays missing
  }
  // H1 (audit 2026-10-17): a day that ended at ≤ 0 units but still sold (backorders, continue
  // selling) is NOT a sold-out day — its sales are real demand (engine rate-shared soldOutDay).
  for (const days of byVariant.values()) for (const r of days.values()) if (r.outOfStock && r.sold > 0) r.outOfStock = false;
  const price = new Map<string, { sold: number; gross: number }>();
  for (const s of priceSales) {
    const k = `${s.variantId}|${s.day}`;
    const p = price.get(k) ?? { sold: 0, gross: 0 };
    p.sold += s.sold;
    p.gross += s.gross;
    price.set(k, p);
  }
  const out = new Map<string, DailyRow[]>();
  for (const [variantId, days] of byVariant) {
    const list = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    for (const r of list) {
      const p = price.get(`${variantId}|${r.day}`);
      r.price = p && p.sold > 0 && p.gross > 0 ? p.gross / p.sold : null;
    }
    out.set(variantId, list);
  }
  return out;
}

/** Σ gross over the series (90-day revenue for ABC). */
export function revenueOf(sales: SalesDay[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sales) m.set(s.variantId, (m.get(s.variantId) ?? 0) + s.gross);
  return m;
}

/** Shop settings → engine overrides; the safety level picks z per ABC role (safety-shared). */
export function engineSettingsFrom(s: ShopSettings): Partial<EngineSettings> {
  return {
    leadTimeDays: s.leadTimeDays,
    cycleDays: s.cycleDays,
    tooMuchDays: s.tooMuchDays,
    deadDays: s.deadDays,
    z: zForSafetyLevel(s.safetyLevel),
  };
}

// ---------------------------------------------------------------------------
// Seasonality inputs
// ---------------------------------------------------------------------------

/**
 * The days the SALES history covers (seasonality, trend and accuracy use it to tell a real
 * zero-sale day from a missing day): from the oldest month the backfill stored
 * (`datasets.sales.doneThrough`) to the newest day stored (`datasets.sales.syncedThrough`, else
 * the shop-wide syncedThrough), minus months the backfill had to skip. No backfill state → no
 * coverage (every seasonal figure falls back to 1.0, "No seasonal data yet").
 */
export function salesCoverage(state: BackfillState): Coverage {
  const sales = state.datasets?.sales;
  const from = sales?.doneThrough ?? null;
  const to = sales?.syncedThrough ?? state.syncedThrough ?? null;
  if (!from || !to || from > to) return { from: null, to: null };
  return { from, to, skippedMonths: (sales?.skippedMonths ?? []).map((m) => m.slice(0, 7)) };
}

// ---------------------------------------------------------------------------
// Actions → rows
// ---------------------------------------------------------------------------

export type ExistingAction = { dedupeKey: string; state: string; doneAt?: Date | null; productId?: string };

/** States whose row is removed once its trigger stops firing (review fix: snoozed too). */
export const RETIRE_WHEN_GONE_STATES = ["open", "snoozed"] as const;

/**
 * What one compute run writes to Action (spec §7.7):
 *  - every draft is upserted by (shop, dedupeKey); a recompute updates amount / reason /
 *    variantIds / currency in place and never touches state, stateAmount, snoozeUntil or doneAt;
 *  - OPEN and SNOOZED rows whose trigger no longer fires are deleted (`deleteKeys`): a snooze
 *    must not bring a solved problem back when its date passes;
 *  - DISMISSED rows are kept (they come back only when the € figure doubles) and DONE rows are
 *    kept (DONE_REOPEN_DAYS rule); their € figure is refreshed only while they still trigger;
 *  - when `liveProductIds` is given (the products compute considered: active, tracked,
 *    non-bundle), rows of every state for any OTHER product are purged (`purgeKeys`): an
 *    archived, untracked or bundle product never comes back from an old dismiss / done row.
 * Duplicate drafts for one key keep the first (generateActions never emits duplicates).
 *  - DONE rows that still trigger DONE_REOPEN_DAYS after doneAt open again (`reopenKeys`).
 */
export function planActionWrites(
  existing: readonly ExistingAction[],
  drafts: readonly ActionDraft[],
  now?: Date,
  liveProductIds?: ReadonlySet<string>,
) {
  const upserts: (ActionDraft & { dedupeKey: string })[] = [];
  const keys = new Set<string>();
  for (const d of drafts) {
    const key = dedupeKey(d.kind, d.productId);
    if (keys.has(key)) continue;
    keys.add(key);
    upserts.push({ ...d, dedupeKey: key });
  }
  const gone = (a: ExistingAction) => liveProductIds != null && a.productId != null && !liveProductIds.has(a.productId);
  const purgeKeys = existing.filter((a) => gone(a) && !keys.has(a.dedupeKey)).map((a) => a.dedupeKey);
  const retire = new Set<string>(RETIRE_WHEN_GONE_STATES);
  const deleteKeys = existing.filter((a) => retire.has(a.state) && !keys.has(a.dedupeKey) && !gone(a)).map((a) => a.dedupeKey);
  const cutoff = now ? now.getTime() - DONE_REOPEN_DAYS * 86_400_000 : null;
  const reopenKeys =
    cutoff == null
      ? []
      : existing
          .filter((a) => a.state === "done" && keys.has(a.dedupeKey) && (a.doneAt == null || a.doneAt.getTime() <= cutoff))
          .map((a) => a.dedupeKey);
  return { upserts, deleteKeys, purgeKeys, reopenKeys };
}

/** Units sold over the last `days` days that have data in the series; null when none has. */
export function soldOver(rows: readonly DailyRow[] | undefined, today: string, days: number): number | null {
  if (!rows?.length) return null;
  const from = addDays(today, -days);
  let any = false;
  let sum = 0;
  for (const r of rows) {
    if (r.day < from || r.day >= today) continue;
    any = true;
    sum += r.sold;
  }
  return any ? sum : null;
}

/**
 * Units still to arrive per variant on Keha's own sent / confirmed orders (ordered − received).
 * Keha orders never reach Shopify (no purchase-order write API), so Shopify's `incoming` never
 * includes them: compute adds these units to incoming, and records the figure in
 * VariantMetric.inputs.kehaOnOrder so the Reorder screen subtracts only what came after.
 */
export function kehaOpenUnits(pos: readonly { lines: { variantId: string; qty: number; received?: number }[] }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const po of pos)
    for (const l of po.lines) {
      const open = Math.max(0, l.qty - (l.received ?? 0));
      if (open > 0) out.set(l.variantId, (out.get(l.variantId) ?? 0) + open);
    }
  return out;
}

/**
 * Expected arrival DAY of an open purchase order (H2): the confirmed ship date + the supplier's
 * transit days, else the lead-time estimate (supplier-shared poArrival). Both columns hold
 * calendar days stored at UTC midnight (the supplier picks a date; expectedDate is @db.Date), so
 * the UTC date part IS the store-local day (L1) — never shift it by the store's time zone.
 */
export function arrivalDay(
  po: { confirmedShipDate: Date | null; expectedDate: Date | null },
  transitDays: number | null | undefined,
): string | null {
  const a = poArrival(po, transitDays);
  return a ? a.toISOString().slice(0, 10) : null;
}

/** An open purchase order line as the landed estimate reads it. */
export type OpenPoLine = { variantId: string; qty: number; received?: number; baseOnHand?: number };
export type OpenPo = { source: string; arrival: string | null; sentDay: string | null; lines: OpenPoLine[] };

/** What the landed estimate needs from the database (online pool, same as auto-receive). */
export type LandedFacts = {
  /** Pool on-hand now per variant (absent = unknown: no estimate). */
  onHand: ReadonlyMap<string, number>;
  /** Pool ending units the day before `sentDay` (lines sent before baseOnHand was recorded). */
  baseline: (variantId: string, sentDay: string) => number | undefined;
  /** Pool units sold from `sentDay` through yesterday. */
  soldSince: (variantId: string, sentDay: string) => number;
};

/**
 * Review fix (Keha units counted twice when stock lands early or in part): `received` is filled
 * only when an order closes (auto-receive waits for the arrival date and ≥ 90 %), so units that
 * already landed sit in on-hand AND in "qty − received". This returns copies of the orders with
 * each sent / confirmed Keha line's `received` raised by the units estimated to have landed,
 * the way auto-receive measures it (lib/purchase-order-shared autoReceiveDecision):
 *   landed since send = on-hand now − on-hand at send (baseOnHand, else the pool's ending units
 *   the day before) + units sold since the send day, capped at 0…open units.
 * Several open lines of one variant share one rise in stock: the rise measured from the OLDEST
 * line's send is shared out oldest first, each line also capped by the rise since its own send
 * (so one delivery is never subtracted twice). Lines without a baseline (or a send day, or a
 * known on-hand now) are left as they were (counted as still to arrive). Shopify orders are
 * untouched (their units are Shopify's own `incoming`).
 */
export function withLandedEstimate<P extends OpenPo>(pos: readonly P[], facts: LandedFacts): P[] {
  const out = pos.map((po) => ({ ...po, lines: po.lines.map((l) => ({ ...l })) }));
  type Slot = { line: OpenPoLine; sentDay: string; order: number; rise: number; open: number };
  const byVariant = new Map<string, Slot[]>();
  out.forEach((po, order) => {
    if (po.source !== "keha" || !po.sentDay) return;
    for (const line of po.lines) {
      const open = Math.max(0, line.qty - (line.received ?? 0));
      const now = facts.onHand.get(line.variantId);
      const base = line.baseOnHand ?? facts.baseline(line.variantId, po.sentDay);
      if (open <= 0 || now === undefined || base === undefined) continue;
      const rise = now - base + Math.max(0, facts.soldSince(line.variantId, po.sentDay));
      const list = byVariant.get(line.variantId) ?? [];
      list.push({ line, sentDay: po.sentDay, order, rise, open });
      byVariant.set(line.variantId, list);
    }
  });
  for (const slots of byVariant.values()) {
    slots.sort((a, b) => (a.sentDay < b.sentDay ? -1 : a.sentDay > b.sentDay ? 1 : a.order - b.order));
    let remaining = Math.max(0, slots[0]!.rise);
    for (const s of slots) {
      const landed = Math.max(0, Math.min(s.open, Math.floor(Math.max(0, s.rise)), remaining));
      if (landed > 0) s.line.received = (s.line.received ?? 0) + landed;
      remaining -= landed;
    }
  }
  return out as P[];
}

/**
 * Dated units still to arrive per variant: one entry per order arrival (open units of lines on
 * orders with a date). Undated orders are left out (their units are assumed to arrive within
 * any window, as Shopify's undated `incoming`).
 */
export function datedIncoming(
  pos: readonly { lines: { variantId: string; qty: number; received?: number }[]; arrival: string | null }[],
): Map<string, { arrival: string; units: number }[]> {
  const out = new Map<string, { arrival: string; units: number }[]>();
  for (const po of pos) {
    if (!po.arrival) continue;
    for (const l of po.lines) {
      const open = Math.max(0, l.qty - (l.received ?? 0));
      if (open <= 0) continue;
      const list = out.get(l.variantId) ?? [];
      list.push({ arrival: po.arrival, units: open });
      out.set(l.variantId, list);
    }
  }
  return out;
}

/** Earliest expected arrival and dated units per variant from open purchase orders. */
export function poArrivals(
  pos: readonly { lines: { variantId: string; qty: number; received?: number }[]; arrival: string | null }[],
): Map<string, { arrival: string; units: number }> {
  const out = new Map<string, { arrival: string; units: number }>();
  for (const po of pos) {
    if (!po.arrival) continue;
    for (const l of po.lines) {
      const open = Math.max(0, l.qty - (l.received ?? 0));
      if (open <= 0) continue;
      const cur = out.get(l.variantId);
      if (!cur) out.set(l.variantId, { arrival: po.arrival, units: open });
      else {
        cur.units += open;
        if (po.arrival < cur.arrival) cur.arrival = po.arrival;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sold-out page traffic
// ---------------------------------------------------------------------------

const PRODUCT_PATH_RE = /^\/(?:[a-z]{2}(?:-[a-z0-9]{2,4})?\/)?(?:collections\/[^/]+\/)?products\/([^/?#]+)\/?$/i;

/**
 * Product handle in a landing path: `/products/<handle>`, locale-prefixed `/es/products/<h>`
 * or `/en-us/products/<h>`, and the collection-scoped `/collections/<c>/products/<h>`. Query
 * and fragment are ignored; the handle is lower-cased and URL-decoded. Null otherwise.
 */
export function productHandleFromPath(path: string): string | null {
  const clean = path.trim().split(/[?#]/)[0];
  const m = PRODUCT_PATH_RE.exec(clean);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return m[1].toLowerCase();
  }
}

export type TrafficProduct = { productId: string; handle: string; variantIds: string[] };

/**
 * One entry per product per day in [from, to] on which EVERY variant has data; fully out of
 * stock when every variant was out that day. Sessions = landings on the product's URL.
 */
export function productTraffic(
  products: TrafficProduct[],
  series: Map<string, DailyRow[]>,
  sessionsByHandleDay: Map<string, Map<string, number>>,
  from: string,
  to: string,
): ProductTraffic[] {
  const outByVariant = new Map<string, Map<string, boolean>>();
  for (const [v, rows] of series) {
    const m = new Map<string, boolean>();
    for (const r of rows) if (r.day >= from && r.day <= to) m.set(r.day, r.outOfStock);
    outByVariant.set(v, m);
  }
  const out: ProductTraffic[] = [];
  for (const p of products) {
    if (!p.variantIds.length) continue;
    const first = outByVariant.get(p.variantIds[0]);
    if (!first) continue;
    const sessions = sessionsByHandleDay.get(p.handle.toLowerCase());
    const days: ProductTraffic["days"][number][] = [];
    for (const day of [...first.keys()].sort()) {
      let allOut = true;
      let complete = true;
      for (const v of p.variantIds) {
        const o = outByVariant.get(v)?.get(day);
        if (o === undefined) {
          complete = false;
          break;
        }
        if (!o) allOut = false;
      }
      if (!complete) continue;
      days.push({ day, fullyOutOfStock: allOut, sessions: sessions?.get(day) ?? 0 });
    }
    out.push({ productId: p.productId, handle: p.handle, days });
  }
  return out;
}

/** Landing sessions per product handle per day. */
export function sessionsByHandle(rows: { landingPath: string; day: string; sessions: number }[]): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const h = productHandleFromPath(r.landingPath);
    if (!h) continue;
    let days = m.get(h);
    if (!days) m.set(h, (days = new Map()));
    days.set(r.day, (days.get(r.day) ?? 0) + r.sessions);
  }
  return m;
}

/** Store conversion = Σ checkouts ÷ Σ sessions; AOV = Σ gross ÷ Σ orders. Null when unknown. */
export function storeConversion(t: { sessions: number; checkouts: number; orders: number; gross: number }): StoreConversion {
  return {
    conversionRate: t.sessions > 0 ? t.checkouts / t.sessions : null,
    aov: t.orders > 0 && t.gross > 0 ? t.gross / t.orders : null,
  };
}

// ---------------------------------------------------------------------------
// Results → rows
// ---------------------------------------------------------------------------

export type MetricRow = {
  rate: number | null;
  sigma: number | null;
  daysLeft: number | null;
  neverRunsOut: boolean;
  status: string;
  role: string;
  orderQty: number | null;
  orderBy: string | null;
  inputs: unknown;
};

/** JSON-safe copy: non-finite numbers become null (Postgres JSON has no Infinity / NaN). */
export function jsonSafe<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? null : x)));
}

/**
 * daysLeft Infinity (rate 0 with stock) → null + neverRunsOut, never a huge number.
 * `extra` is merged into `inputs` (seasonality source, safety level …) for the popover.
 */
export function metricRow(r: VariantResult, extra?: Record<string, unknown>): MetricRow {
  const infinite = r.daysLeft === Infinity;
  return {
    rate: r.rate,
    sigma: r.sigma,
    daysLeft: infinite || r.daysLeft === null || !Number.isFinite(r.daysLeft) ? null : r.daysLeft,
    neverRunsOut: infinite,
    status: r.status,
    role: r.role,
    orderQty: r.orderQty,
    orderBy: r.orderBy,
    inputs: jsonSafe(extra ? { ...r.inputs, ...extra } : r.inputs),
  };
}

/** Free plan: money is recomputed only when the last row is from an earlier calendar month. */
export function moneyDue(refresh: "monthly" | "daily", lastDay: string | null, today: string): boolean {
  if (refresh === "daily" || !lastDay) return true;
  return lastDay.slice(0, 7) < today.slice(0, 7);
}
