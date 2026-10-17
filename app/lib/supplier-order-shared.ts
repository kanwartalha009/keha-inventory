/**
 * Supplier order builder (consolidated supplier purchase order, Kanwar 2026-10-17). Pure,
 * client-safe; the database part is models/supplier-order.server.ts.
 *
 * A merchant sends ONE purchase order per supplier per cycle. The forward plan
 * (engine/forward-plan-shared) places each product's order on its own order-by date, so a
 * 75-day supplier gets three or four small orders a month. The builder gathers, for one
 * supplier, from the same plan:
 *  - "Due now": its orders due in the next 7 days (overdue included) — Order now's lines — or,
 *    from Next 13 weeks, its orders of that week (`range`);
 *  - "Due before your next order": its later orders up to the end of the supplier's order cycle
 *    (Settings → Suppliers "Order every … days", else the store's cycle), each with its own
 *    order-by date;
 *  - products the merchant adds by hand (any of the supplier's products, any quantity).
 * Each line starts at the plan's quantity before top-ups (case pack and minimum per item
 * applied: OrderWhy.rounded; several orders of one product in the window added together); the
 * supplier's minimums (per style, units, money) are then applied ONCE to the whole order with
 * the forward plan's own top-up functions (splitByShare, topUpToMinimum, topUpToValue), so the
 * order starts complete. Edits below a minimum show what is missing and a one-click top-up.
 */
import { addDays, type DayKey } from "./engine/dates-shared";
import { lineQuantity } from "./engine/order-shared";
import { ORDER_NOW_DAYS, ordersDue, splitByShare, topUpToMinimum, topUpToValue, type OrderWhy, type PlanEvent } from "./engine/forward-plan-shared";
import type { OrderPlanData, PlanSupplierInfo } from "./order-plan-shared";
import { orderTotals, type OrderTotals } from "./reorder-shared";
import type { PoLine } from "./supplier-shared";
import { landedOf, orderPayments, type Payment, type PaymentTerms } from "./cash-shared";
import type { LeadStats } from "./lead-time-shared";

/** Where a line comes from: due now (or in the week opened from Next 13 weeks), due within the cycle, added by hand. */
export type BuilderSection = "due" | "cycle" | "added";

export type BuilderLine = {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  image: string | null;
  section: BuilderSection;
  /** The line's order-by date (several orders: ordersDue's — the earliest, or the one that passed). */
  orderBy: DayKey | null;
  overdue: boolean;
  /** The plan's quantity before top-ups (case pack and minimum per item applied). */
  base: number;
  /** Starting quantity: base + this order's top-up. */
  suggested: number;
  /** Units added to reach the supplier's minimums for this order. */
  topUp: number;
  pack: number | null;
  moq: number | null;
  /** Unit cost in the store's currency (Shopify cost per item); null unknown. */
  unitCostStore: number | null;
  /** Share of sales for top-ups (sales per day). */
  weight: number;
  /** The terms of each planned order behind the line ("Why this quantity"). */
  why: OrderWhy[];
  lastYear: number | null;
  /** The merchant marked the product "Don't reorder" (only on lines added by hand). */
  noReorder?: boolean;
};

export type BuilderDraft = {
  id: string;
  number: string;
  units: number;
  createdAt: string;
  /** Optimistic check when lines are added. */
  updatedAt: string | null;
};

export type SupplierOrderView = {
  key: string;
  kind: "supplier" | "vendor";
  supplierId: string | null;
  name: string;
  /** The supplier's currency (upper case). */
  currency: string;
  storeCurrency: string;
  /** 1 supplier unit in store units; null unknown. */
  exchangeRate: number | null;
  leadTimeDays: number;
  leadTimeSource: "supplier" | "default";
  /** The order cycle the window uses, and where it comes from. */
  cycleDays: number;
  cycleSource: "supplier" | "store";
  /** First day of the window (today, or the week opened from Next 13 weeks). */
  from: DayKey;
  /** Opened from Next 13 weeks: that supplier-week's order-by range ("Due" then names it); null = due now. */
  range: { from: DayKey; to: DayKey } | null;
  /** First order-by day of "Due" (the range's start, else today). */
  dueFrom: DayKey;
  /** Last day of "Due now" (today + 6, or the week's last order-by date). */
  dueTo: DayKey;
  /** Last day of the order cycle (the next order to this supplier would be the day after). */
  cycleTo: DayKey;
  minOrderTotal: number | null;
  /** Minimum order value in the supplier's currency, and in the store's (null: unknown rate). */
  minOrderValue: number | null;
  minOrderValueStore: number | null;
  minOrderScope: "variant" | "product";
  /** With scope "product": the minimum per style. */
  minOrder: number | null;
  hasEmail: boolean;
  lines: BuilderLine[];
  /** A fresh draft for this supplier (counts as ordered): lines can be added to it. */
  draft: BuilderDraft | null;
  /** Payment terms (lib/cash-shared); null = everything paid when ordering. */
  terms?: PaymentTerms | null;
  /** Freight + duty, % of the goods; null = none. */
  landedPct?: number | null;
  /** Days from ship date to arrival (the "at shipment" day). */
  transitDays?: number | null;
  /** The supplier's measured lead time; null = none measured. */
  leadStats?: LeadStats | null;
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The cycle the builder uses: the supplier's own, else the cycle its products were planned with, else the store's (at least 7 days). */
export function builderCycle(info: Pick<PlanSupplierInfo, "orderCycleDays" | "cycleDays"> | null | undefined, storeCycleDays: number): { days: number; source: "supplier" | "store" } {
  const own = info?.orderCycleDays;
  if (finite(own) && own >= 1) return { days: Math.max(ORDER_NOW_DAYS, Math.floor(own)), source: "supplier" };
  const planned = finite(info?.cycleDays) && info!.cycleDays! >= 1 ? info!.cycleDays! : storeCycleDays;
  return { days: Math.max(ORDER_NOW_DAYS, Math.floor(planned)), source: "store" };
}

/** The builder's window: due now (or the week asked for), then up to the end of the cycle. */
export function builderWindow(today: DayKey, cycleDays: number, range?: { from: DayKey; to: DayKey } | null): { from: DayKey; dueTo: DayKey; cycleTo: DayKey } {
  const from = range && range.from > today ? range.from : today;
  const dueTo = range ? (range.to < from ? from : range.to) : addDays(today, ORDER_NOW_DAYS - 1);
  const end = addDays(from, Math.max(ORDER_NOW_DAYS, cycleDays) - 1);
  return { from, dueTo, cycleTo: end > dueTo ? end : dueTo };
}

export type BuildSupplierOrderInput = {
  plan: Pick<OrderPlanData, "today" | "events" | "variants" | "currency">;
  supplierKey: string;
  /** The supplier as the plan knows it (plan.suppliers[key]), or built from Settings when it has no planned order. */
  info: PlanSupplierInfo;
  storeCycleDays: number;
  /** Next 13 weeks: the supplier-week's order-by range. */
  range?: { from: DayKey; to: DayKey } | null;
  draft?: BuilderDraft | null;
};

/** The builder's lines and the supplier's terms (see the module header). */
export function buildSupplierOrder(input: BuildSupplierOrderInput): SupplierOrderView {
  const { plan, info } = input;
  const store = plan.currency.toUpperCase();
  const cycle = builderCycle(info, input.storeCycleDays);
  const win = builderWindow(plan.today, cycle.days, input.range ?? null);
  const mine = plan.events.filter((e) => e.supplierKey === input.supplierKey && e.orderBy >= win.from && e.orderBy <= win.cycleTo);
  const byVariant = new Map<string, PlanEvent[]>();
  for (const e of mine) (byVariant.get(e.variantId) ?? byVariant.set(e.variantId, []).get(e.variantId)!).push(e);
  const lines: BuilderLine[] = [];
  for (const [id, events] of byVariant) {
    const v = plan.variants[id];
    if (!v) continue;
    events.sort((a, b) => a.orderBy.localeCompare(b.orderBy));
    // Before top-ups: the batch top-ups of each order's own week don't apply to one order for the whole cycle.
    const base = events.reduce((a, e) => a + (e.why ? e.why.rounded : e.qty), 0);
    const due = ordersDue(events);
    lines.push({
      variantId: id,
      productId: v.productId,
      productTitle: v.productTitle,
      variantTitle: v.variantTitle,
      sku: v.sku,
      image: v.image,
      section: events.some((e) => e.orderBy <= win.dueTo) ? "due" : "cycle",
      orderBy: due.orderBy,
      overdue: due.overdue,
      base,
      suggested: base,
      topUp: 0,
      pack: v.pack ?? null,
      moq: v.moq ?? null,
      unitCostStore: events[0]!.unitCost,
      weight: finite(v.rate) && v.rate > 0 ? v.rate : 0,
      why: events.map((e) => e.why).filter((w): w is OrderWhy => !!w).map((w) => ({ ...w, topUp: 0 })),
      lastYear: events[0]!.lastYear ?? null,
    });
  }
  const view: SupplierOrderView = {
    key: input.supplierKey,
    kind: info.kind,
    supplierId: info.supplierId,
    name: info.name,
    currency: (info.currency ?? store).toUpperCase(),
    storeCurrency: store,
    exchangeRate: info.exchangeRate ?? null,
    leadTimeDays: info.leadTimeDays ?? 0,
    leadTimeSource: info.leadTimeSource ?? (info.kind === "supplier" ? "supplier" : "default"),
    cycleDays: cycle.days,
    cycleSource: cycle.source,
    from: win.from,
    range: input.range ?? null,
    dueFrom: win.from,
    dueTo: win.dueTo,
    cycleTo: win.cycleTo,
    minOrderTotal: info.minOrderTotal ?? null,
    minOrderValue: info.minOrderValue ?? null,
    minOrderValueStore: info.minOrderValueStore ?? null,
    minOrderScope: info.minOrderScope ?? "variant",
    minOrder: info.minOrder ?? null,
    hasEmail: !!info.hasEmail,
    lines: [],
    draft: input.draft ?? null,
    terms: info.terms ?? null,
    landedPct: info.landedPct ?? null,
    transitDays: info.transitDays ?? null,
    leadStats: info.leadStats ?? null,
  };
  // The order starts complete: the minimums applied once to the whole order.
  const qtys = topUpOrder(view, lines.map((l) => ({ ...l, qty: l.base })));
  lines.forEach((l, i) => {
    const q = qtys[i]!;
    l.suggested = q;
    l.topUp = Math.max(0, q - l.base);
    if (l.topUp > 0 && l.why.length) l.why[l.why.length - 1] = { ...l.why[l.why.length - 1]!, topUp: l.topUp };
  });
  view.lines = sortBuilderLines(lines.filter((l) => l.suggested > 0));
  return view;
}

/** Due now first, then due within the cycle, then added; inside each: by product then size, a product with an overdue line first (Order now's order). */
export function sortBuilderLines(lines: BuilderLine[]): BuilderLine[] {
  const rank: Record<BuilderSection, number> = { due: 0, cycle: 1, added: 2 };
  const overdue = new Set(lines.filter((l) => l.overdue).map((l) => `${l.section}|${l.productId}`));
  const late = (l: BuilderLine) => Number(overdue.has(`${l.section}|${l.productId}`));
  return lines.sort(
    (a, b) =>
      rank[a.section] - rank[b.section] ||
      late(b) - late(a) ||
      a.productTitle.localeCompare(b.productTitle) ||
      (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0) ||
      a.variantTitle.localeCompare(b.variantTitle) ||
      (a.variantId < b.variantId ? -1 : 1),
  );
}

/** A line the merchant adds by hand from the supplier's products. */
export type AddableProduct = {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  image: string | null;
  unitCostStore: number | null;
  pack: number | null;
  moq: number | null;
  weight: number;
  noReorder?: boolean;
};

/** An added product as a builder line: one case (or the minimum per item), the merchant types the rest. */
export function addedLine(p: AddableProduct): BuilderLine {
  const q = lineQuantity(1, p.pack, p.moq);
  return { ...p, section: "added", orderBy: null, overdue: false, base: q, suggested: q, topUp: 0, why: [], lastYear: null, noReorder: !!p.noReorder };
}

// ── Minimums ────────────────────────────────────────────────────────────────

export type QtyLine = Pick<BuilderLine, "variantId" | "productId" | "productTitle" | "pack" | "weight" | "unitCostStore"> & { qty: number };

/**
 * The supplier's minimums applied to an order at these quantities, in the forward plan's order:
 * per style (minOrderScope "product": each product's total raised to the minimum, split across
 * its lines in the order by share of sales, whole case packs), then the order minimum in units,
 * then in money (store currency). Lines at 0 are left out and stay 0.
 */
export function topUpOrder(
  view: Pick<SupplierOrderView, "minOrderScope" | "minOrder" | "minOrderTotal" | "minOrderValueStore">,
  lines: readonly QtyLine[],
): number[] {
  const qtys = lines.map((l) => Math.max(0, Math.floor(l.qty)));
  if (view.minOrderScope === "product" && view.minOrder && view.minOrder > 0) {
    const products = [...new Set(lines.filter((_, i) => qtys[i]! > 0).map((l) => l.productId))].sort();
    for (const pid of products) {
      const idx = lines.map((l, i) => (l.productId === pid && qtys[i]! > 0 ? i : -1)).filter((i) => i >= 0);
      const total = idx.reduce((a, i) => a + qtys[i]!, 0);
      if (total >= view.minOrder) continue;
      const withWeight = idx.filter((i) => lines[i]!.weight > 0);
      const takers = withWeight.length ? withWeight : idx;
      const split = splitByShare(view.minOrder - total, takers.map((i) => ({ weight: lines[i]!.weight, pack: lines[i]!.pack })));
      takers.forEach((i, k) => (qtys[i]! += split[k]!));
    }
  }
  const lineOf = (i: number) => ({ qty: qtys[i]!, pack: lines[i]!.pack, weight: lines[i]!.weight, unitCost: lines[i]!.unitCostStore });
  const units = topUpToMinimum(lines.map((_, i) => lineOf(i)), view.minOrderTotal);
  units.qtys.forEach((q, i) => (qtys[i] = q));
  const value = topUpToValue(lines.map((_, i) => lineOf(i)), view.minOrderValueStore);
  value.qtys.forEach((q, i) => (qtys[i] = q));
  return qtys;
}

export type MinimumStatus = {
  /** null: no order minimum in units. */
  units: { min: number; total: number; missing: number } | null;
  /** null: no order minimum in money (or its rate is unknown — `valueUnknown`). Store currency. */
  value: { min: number; total: number; missing: number } | null;
  /** The supplier has a money minimum but no exchange rate: it can't be checked. */
  valueUnknown: boolean;
  /** Styles below the minimum per style. */
  styles: { productId: string; title: string; total: number; missing: number }[];
  /** Every minimum that can be checked is met. */
  met: boolean;
  /** At least one minimum applies (there is something to say). */
  any: boolean;
};

/** Where the order stands against the supplier's minimums at these quantities (lines at 0 are not in the order). */
export function minimumStatus(
  view: Pick<SupplierOrderView, "minOrderScope" | "minOrder" | "minOrderTotal" | "minOrderValue" | "minOrderValueStore">,
  lines: readonly QtyLine[],
): MinimumStatus {
  const ordered = lines.filter((l) => l.qty > 0);
  const total = ordered.reduce((a, l) => a + l.qty, 0);
  const units = view.minOrderTotal && view.minOrderTotal > 0 ? { min: view.minOrderTotal, total, missing: Math.max(0, view.minOrderTotal - total) } : null;
  let value: MinimumStatus["value"] = null;
  if (view.minOrderValueStore && view.minOrderValueStore > 0) {
    const sum = Math.round(ordered.reduce((a, l) => a + (l.unitCostStore !== null && l.unitCostStore > 0 ? l.unitCostStore * l.qty : 0), 0) * 100) / 100;
    value = { min: view.minOrderValueStore, total: sum, missing: Math.max(0, Math.round((view.minOrderValueStore - sum) * 100) / 100) };
  }
  const styles: MinimumStatus["styles"] = [];
  if (view.minOrderScope === "product" && view.minOrder && view.minOrder > 0) {
    const per = new Map<string, { title: string; total: number }>();
    for (const l of ordered) {
      const cur = per.get(l.productId) ?? { title: l.productTitle, total: 0 };
      cur.total += l.qty;
      per.set(l.productId, cur);
    }
    for (const [productId, p] of per) if (p.total < view.minOrder) styles.push({ productId, title: p.title, total: p.total, missing: view.minOrder - p.total });
    styles.sort((a, b) => a.title.localeCompare(b.title) || (a.productId < b.productId ? -1 : 1));
  }
  const valueUnknown = !!view.minOrderValue && !view.minOrderValueStore;
  const met = (!units || units.missing === 0 || total === 0) && (!value || value.missing === 0 || total === 0) && styles.length === 0;
  return { units, value, valueUnknown, styles, met, any: !!units || !!value || valueUnknown || (view.minOrderScope === "product" && !!view.minOrder) };
}

/** Units and cost of the order (store currency, and the supplier's with a rate); lines without a cost are counted. */
export function builderTotals(view: Pick<SupplierOrderView, "currency" | "storeCurrency" | "exchangeRate">, lines: readonly QtyLine[]): OrderTotals {
  const q = new Map(lines.map((l) => [l.variantId, l.qty]));
  return orderTotals(view, lines, (id) => q.get(id) ?? 0);
}

/**
 * The order's freight + duty and its payments if it is placed today: arrival after the lead time,
 * the balance at the supplier's moment (lib/cash-shared). Store currency; null cost → no goods
 * payment (unknown, never 0).
 */
export function builderPayments(
  view: Pick<SupplierOrderView, "terms" | "landedPct" | "transitDays" | "leadTimeDays">,
  cost: number | null,
  today: DayKey,
): { landed: number | null; payments: Payment[] } {
  const landed = landedOf(cost, view.landedPct ?? null);
  const arrives = addDays(today, Math.max(0, Math.round(view.leadTimeDays || 0)));
  return { landed, payments: orderPayments({ orderDay: today, arrives, transitDays: view.transitDays ?? null }, cost, landed, view.terms ?? null) };
}

// ── Free plan: the teaching lock with the store's own numbers ─────────────────

export type BuilderTeaser = { name: string; kind: "supplier" | "vendor"; products: number; units: number; cash: number | null; cycleDays: number; currency: string };

/** What the builder would put in this supplier's order (Free sees the numbers, not the lines). */
export function builderTeaser(view: SupplierOrderView): BuilderTeaser {
  const totals = builderTotals(view, view.lines.map((l) => ({ ...l, qty: l.suggested })));
  return {
    name: view.name,
    kind: view.kind,
    products: new Set(view.lines.map((l) => l.productId)).size,
    units: totals.units,
    cash: totals.cost,
    cycleDays: view.cycleDays,
    currency: view.storeCurrency,
  };
}

// ── Links ───────────────────────────────────────────────────────────────────

/** The builder for one supplier (`range`: a Next 13 weeks supplier-week's order-by dates). */
export function builderLink(supplierKey: string, range?: { from: DayKey; to: DayKey } | null): string {
  const params = new URLSearchParams({ supplier: supplierKey });
  if (range) {
    params.set("from", range.from);
    params.set("to", range.to);
  }
  return `/app/reorder/build?${params.toString().replace(/%3A/g, ":")}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `?supplier=&from=&to=` → the builder's supplier and optional range (null without a valid supplier key). */
export function readBuilderLink(params: URLSearchParams): { supplierKey: string; range: { from: DayKey; to: DayKey } | null } | null {
  const key = params.get("supplier");
  if (!key || key.length > 300 || !/^(supplier|vendor):/.test(key)) return null;
  const from = params.get("from");
  const to = params.get("to");
  const range = from && to && DAY.test(from) && DAY.test(to) && from <= to ? { from, to } : null;
  return { supplierKey: key, range };
}

/** Quantities sent by the browser → whole units per variant gid (anything else dropped; at most 5,000 lines). */
export function readBuilderQuantities(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 5000)) {
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(k)) continue;
    const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
    if (Number.isInteger(n) && n > 0 && n <= 1_000_000) out[k] = n;
  }
  return out;
}

// ── Adding lines to an existing draft ───────────────────────────────────────

/**
 * A draft's lines with more lines added: a variant already on the draft gets the units added to
 * its line (one line per variant, so nothing is counted twice); a new variant is appended with its
 * snapshot (titles, SKU, store-currency cost). Received units and the other fields stay.
 */
export function mergeDraftLines(lines: readonly PoLine[], add: readonly PoLine[]): PoLine[] {
  const out = lines.map((l) => ({ ...l }));
  for (const a of add) {
    if (!(a.qty > 0)) continue;
    const cur = out.find((l) => l.variantId === a.variantId);
    if (cur) cur.qty += a.qty;
    else out.push({ ...a });
  }
  return out;
}
