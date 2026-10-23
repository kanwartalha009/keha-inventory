/**
 * Order plan · Order now (spec §5.3, J3; ordering audit 2026-10-17): the forward plan's orders
 * due in the next 7 days (overdue included) grouped by supplier — the very orders and
 * quantities of the Dashboard's "Due this week" (one function: models/order-plan.server). Pure,
 * client-safe.
 *
 * Minimums (Kanwar 2026-10-16; audit 2026-10-17) are applied in the forward plan itself
 * (engine/forward-plan-shared planStore), so every screen shows the same quantities and cash:
 *  - per line: round up to the case pack (variant caseQty wins, else the supplier's casePack),
 *    then raise to the per-variant minimum (MOQ), itself rounded up to the pack — or, with
 *    "minimum per style", raise each product's total to the minimum, split across its
 *    variants by share of sales;
 *  - per order: the order minimum in units, then in money (store currency), topped up in
 *    proportion to forecast demand (sales per day), each line staying a whole number of packs.
 * The merchant may edit below them: a warning, never a block.
 */
import { casePackFor, supplierFor, type SupplierLite } from "./supplier-shared";
import { lineQuantity, netNeed } from "./engine/order-shared";
import { ORDER_NOW_DAYS, dueNote, ordersDue, topUpToMinimum, type DueNote, type OrderWhy, type PlanEvent, type StockOutlook, type TopUpLine } from "./engine/forward-plan-shared";
import { addDays, type DayKey } from "./engine/dates-shared";
import type { OrderPlanData } from "./order-plan-shared";

type T = (s: string) => string;

// lineQuantity (case pack, then MOQ) and netNeed live in the engine; topUpToMinimum in the
// forward plan — Order now, the forward plan and the planner use the very same functions.
export { lineQuantity, netNeed, topUpToMinimum, casePackFor, supplierFor };
export type { TopUpLine };

// ── Groups ─────────────────────────────────────────────────────────────────

export type ReorderVariantIn = {
  id: string;
  productId?: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  vendor: string | null;
  image: string | null;
  supplierId: string | null;
  caseQty: number | null;
  cost: number | null;
  costCurrency: string | null;
  noReorder?: boolean;
};

export type ReorderSupplierIn = SupplierLite & { currency: string | null; hasEmail: boolean };

export type ReorderLine = {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  image: string | null;
  onHand: number | null;
  incoming: number | null;
  /** Units on open Keha orders that still count (sent, confirmed, drafts up to 14 days old). */
  onOrder: number;
  daysLeft: number | null;
  neverRunsOut: boolean;
  /** The line's real order-by date (overdue: in the past). */
  orderBy: string | null;
  /** Its order-by date has passed. */
  overdue: boolean;
  /** A1: the season's first order, or why an overdue line has no date (forward-plan dueNote). */
  dueNote?: DueNote | null;
  /** Today's stock outlook (the variant's first planned order): the line's status words (lib/outcome-shared). */
  outlook?: StockOutlook | null;
  /** Planned quantity after the case pack, the minimums and the order's top-ups. */
  suggested: number;
  pack: number | null;
  moq: number | null;
  /** Unit cost in the order (supplier) currency, for the purchase order; null when unknown. */
  unitCost: number | null;
  /** Unit cost in the store's currency (Shopify cost per item); null when unknown. */
  unitCostStore: number | null;
  /** Forecast sales per day (top-up weight). */
  rate: number | null;
  /** The terms of each planned order behind the quantity (Why this quantity). */
  why: OrderWhy[];
  /** Units sold in the same weeks last year; null unknown. */
  lastYear: number | null;
  /** Asked for through ?variants= (an action's "Add to purchase order"). */
  selected: boolean;
  /** Asked for by the Season plan's "Add to purchase order" with its planned quantity. */
  fromPlanner: boolean;
  /** The planner's quantity for this line; null when not from the planner. */
  planned: number | null;
  /** The merchant marked the variant "Don't reorder" (only when asked for explicitly). */
  noReorder: boolean;
};

export type ReorderGroup = {
  key: string;
  kind: "supplier" | "vendor";
  supplierId: string | null;
  /** Supplier name, or the vendor ("" = products without a vendor). */
  name: string;
  leadTimeDays: number;
  leadTimeSource: "supplier" | "default";
  /** Earliest order-by date of its lines. */
  orderBy: string | null;
  overdue: boolean;
  /** Really late (forward-plan isLate): the red "Order now" badge; lines only below their buffer don't count. */
  late: boolean;
  /** The order (supplier) currency. */
  currency: string;
  /** The store's currency (every amount is valued in it). */
  storeCurrency: string;
  /** 1 supplier unit in store units; null = unknown (supplier amounts not shown). */
  exchangeRate: number | null;
  minOrderTotal: number | null;
  /** Minimum order value: supplier currency, and store currency (null when the rate is unknown). */
  minOrderValue: number | null;
  minOrderValueStore: number | null;
  /** "product": `minOrder` applies per style. */
  minOrderScope: "variant" | "product";
  minOrder: number | null;
  toppedUp: boolean;
  valueToppedUp: boolean;
  /** Products raised to the minimum per style. */
  styleToppedUp: string[];
  hasEmail: boolean;
  selected: boolean;
  lines: ReorderLine[];
  /** Lines of this supplier due later, before its next order: they can join this one. */
  joinable: ReorderLine[];
  /** Days of stock after arrival the plan orders for (the supplier's / store's order cycle); null unknown. */
  planCoverDays: number | null;
  /** "Order enough for N days" chosen for this order (?cover=key~N); null = the plan's. */
  coverDays: number | null;
};

export const supplierGroupKey = (id: string) => `supplier:${id}`;
export const vendorGroupKey = (vendor: string | null) => `vendor:${(vendor ?? "").trim().toLowerCase()}`;

/** Unit cost in `currency`: known only when the cost is in that currency (no FX guessing). */
export function unitCostIn(
  cost: number | null,
  costCurrency: string | null,
  currency: string,
  storeCurrency: string,
): number | null {
  if (cost === null || !Number.isFinite(cost) || cost < 0) return null;
  const from = (costCurrency || storeCurrency).toUpperCase();
  return from === currency.toUpperCase() ? cost : null;
}

export type OrderNowInput = {
  plan: Pick<OrderPlanData, "today" | "events" | "suppliers" | "variants" | "batches" | "currency">;
  /** Variants asked for that have no planned order (titles, supplier, costs). */
  extraVariants?: readonly ReorderVariantIn[];
  /** Suppliers (for the asked-for variants without a planned order). */
  suppliers?: readonly ReorderSupplierIn[];
  defaultLeadTimeDays?: number;
  stock: ReadonlyMap<string, { onHand: number | null; incoming: number | null }>;
  /** Open Keha units that still count, per variant. */
  onOrder: ReadonlyMap<string, number>;
  selected?: ReadonlySet<string>;
  /** Planned quantities from the Season plan: the line starts at max(planned, the plan's quantity). */
  planned?: ReadonlyMap<string, number>;
  /** An orderLink range: that supplier's orders in the range instead of the next 7 days. */
  link?: { supplierKey: string | null; from: DayKey; to: DayKey } | null;
  /** "Order enough for N days" per supplier key (the plan was computed with it). */
  coverDays?: ReadonlyMap<string, number>;
};

type Acc = { events: PlanEvent[] };

/** Group key → info, with a fallback for asked-for variants of suppliers without orders. */
function groupInfo(input: OrderNowInput, key: string, v: ReorderVariantIn | null) {
  const s = input.plan.suppliers[key];
  const store = input.plan.currency.toUpperCase();
  if (s) {
    return {
      key,
      kind: s.kind,
      supplierId: s.supplierId,
      name: s.name,
      leadTimeDays: s.leadTimeDays ?? input.defaultLeadTimeDays ?? 0,
      leadTimeSource: s.leadTimeSource ?? (s.kind === "supplier" ? "supplier" : "default"),
      currency: (s.currency ?? store).toUpperCase(),
      exchangeRate: s.exchangeRate ?? null,
      minOrderTotal: s.minOrderTotal ?? null,
      minOrderValue: s.minOrderValue ?? null,
      minOrderValueStore: s.minOrderValueStore ?? null,
      minOrderScope: s.minOrderScope ?? "variant",
      minOrder: s.minOrder ?? null,
      hasEmail: !!s.hasEmail,
    } as const;
  }
  const sup = v ? supplierFor(v, input.suppliers ?? []) : null;
  return {
    key,
    kind: sup ? ("supplier" as const) : ("vendor" as const),
    supplierId: sup?.id ?? null,
    name: sup ? sup.name : (v?.vendor ?? "").trim(),
    leadTimeDays: sup ? sup.leadTimeDays : (input.defaultLeadTimeDays ?? 0),
    leadTimeSource: sup ? ("supplier" as const) : ("default" as const),
    currency: (sup?.currency || store).toUpperCase(),
    exchangeRate: sup?.exchangeRate ?? null,
    minOrderTotal: sup?.minOrderTotal ?? null,
    minOrderValue: sup?.minOrderValue ?? null,
    minOrderValueStore: null,
    minOrderScope: sup?.minOrderScope ?? "variant",
    minOrder: sup?.minOrder ?? null,
    hasEmail: !!sup?.hasEmail,
  };
}

/**
 * Order now's groups: per supplier, the plan's orders due in the next 7 days (or the orders an
 * orderLink selected), one line per variant at the planned quantity, plus any variant asked
 * for. Lines are sorted by product then variant (sizes stay together); a product with an
 * overdue line comes first. Groups with an asked-for line first, then overdue, then by date.
 */
export function buildOrderNow(input: OrderNowInput): ReorderGroup[] {
  const { plan } = input;
  const today = plan.today;
  const selected = input.selected ?? new Set<string>();
  const planned = input.planned ?? new Map<string, number>();
  const lastNow = addDays(today, ORDER_NOW_DAYS - 1);
  const inLink = (e: PlanEvent) => !!input.link && (!input.link.supplierKey || e.supplierKey === input.link.supplierKey) && e.orderBy >= input.link.from && e.orderBy <= input.link.to;
  const linkCovers = (key: string) => !!input.link && (!input.link.supplierKey || input.link.supplierKey === key);
  const base = plan.events.filter((e) => (linkCovers(e.supplierKey) ? inLink(e) : e.orderBy <= lastNow));
  const byKey = new Map<string, Map<string, Acc>>();
  const add = (key: string, id: string, e: PlanEvent | null) => {
    const g = byKey.get(key) ?? byKey.set(key, new Map()).get(key)!;
    const a = g.get(id) ?? g.set(id, { events: [] }).get(id)!;
    if (e) a.events.push(e);
  };
  for (const e of base) add(e.supplierKey, e.variantId, e);
  const firstEvent = new Map<string, PlanEvent>();
  for (const e of plan.events) if (!firstEvent.has(e.variantId)) firstEvent.set(e.variantId, e);
  const extra = new Map((input.extraVariants ?? []).map((v) => [v.id, v]));
  // Asked-for variants (an action's "Add to purchase order", the Season plan's quantities).
  const asked = new Set([...selected, ...planned.keys()]);
  const keyOfExtra = (v: ReorderVariantIn) => {
    const s = supplierFor(v, input.suppliers ?? []);
    return s ? supplierGroupKey(s.id) : vendorGroupKey(v.vendor);
  };
  for (const id of asked) {
    const inBase = base.some((e) => e.variantId === id);
    if (inBase) continue;
    const fe = firstEvent.get(id);
    if (fe) add(fe.supplierKey, id, fe);
    else if (extra.has(id)) add(keyOfExtra(extra.get(id)!), id, null);
  }
  const lineOf = (id: string, events: PlanEvent[], info: ReturnType<typeof groupInfo>, join = false): ReorderLine | null => {
    const v = plan.variants[id];
    const x = extra.get(id);
    if (!v && !x) return null;
    const stock = input.stock.get(id);
    // A line that joins this order leaves its own later order: that order's top-up doesn't apply.
    // The orders due in the 7 days added together (variantLine's sum, the same as Products' To
    // order); a line that joins this order leaves its own later order: no top-up then.
    const qty = events.reduce((a, e) => a + (join && e.why ? e.why.rounded : e.qty), 0);
    const first = events[0] ?? null;
    // One date per line, the same rule as the Dashboard, Sidekick and the email (M2): with several
    // orders of this variant in the 7 days, the earliest (overdue: the one that passed).
    const due = ordersDue(events);
    const pack = v ? (v.pack ?? null) : x ? casePackFor(x.caseQty, supplierFor(x, input.suppliers ?? [])) : null;
    const moq = v ? (v.moq ?? null) : info.minOrderScope === "product" ? null : info.minOrder;
    const plannedQty = planned.get(id);
    const store = first?.unitCost ?? (x && x.cost !== null && (!x.costCurrency || x.costCurrency.toUpperCase() === plan.currency.toUpperCase()) ? x.cost : null);
    const sameCur = info.currency === plan.currency.toUpperCase();
    const supplierUnit = sameCur ? store : (v?.unitCostSupplier ?? (store !== null && info.exchangeRate ? store / info.exchangeRate : null));
    return {
      variantId: id,
      productId: v?.productId ?? x?.productId ?? id,
      productTitle: v?.productTitle ?? x!.productTitle,
      variantTitle: v?.variantTitle ?? x!.variantTitle,
      sku: v?.sku ?? x?.sku ?? null,
      image: v?.image ?? x?.image ?? null,
      onHand: stock?.onHand ?? null,
      incoming: stock?.incoming ?? null,
      onOrder: Math.max(0, input.onOrder.get(id) ?? 0),
      daysLeft: v?.daysLeft ?? null,
      neverRunsOut: !!v?.neverRunsOut,
      orderBy: events.length ? due.orderBy : (v?.deadline ?? null),
      overdue: due.overdue,
      dueNote: dueNote(events),
      outlook: events.find((e) => e.outlook)?.outlook ?? null,
      suggested: Math.max(qty, plannedQty !== undefined ? lineQuantity(plannedQty, pack, moq) : 0),
      pack,
      moq,
      unitCost: supplierUnit,
      unitCostStore: store,
      rate: v?.rate ?? null,
      why: events.map((e) => e.why).filter((w): w is OrderWhy => !!w),
      lastYear: first?.lastYear ?? null,
      selected: asked.has(id),
      fromPlanner: plannedQty !== undefined,
      planned: plannedQty ?? null,
      noReorder: !!x?.noReorder,
    };
  };
  const out: ReorderGroup[] = [];
  for (const [key, accs] of byKey) {
    const anyId = [...accs.keys()][0]!;
    const info = groupInfo(input, key, extra.get(anyId) ?? null);
    const lines = [...accs].map(([id, a]) => lineOf(id, a.events, info)).filter((l): l is ReorderLine => !!l);
    if (!lines.length) continue;
    sortLines(lines);
    // Top-ups of the plan's batches behind these lines.
    const days = new Set(lines.flatMap((l) => (accs.get(l.variantId)?.events ?? []).map((e) => e.orderBy)));
    const batches = (plan.batches ?? []).filter((b) => b.supplierKey === key && [...days].some((d) => d >= b.from && d <= b.to));
    // Can join: this supplier's later orders, due before its next order (one cycle).
    // With "Order enough for N days" chosen for this order, its next order is N days away (audit 2026-10-18).
    const cycle = Math.max(ORDER_NOW_DAYS, Math.floor(input.coverDays?.get(key) ?? plan.suppliers[key]?.cycleDays ?? 0));
    const joinEnd = addDays(today, cycle - 1);
    const inGroup = new Set(lines.map((l) => l.variantId));
    const seen = new Set<string>();
    const joinable: ReorderLine[] = [];
    for (const e of plan.events) {
      if (e.supplierKey !== key || inGroup.has(e.variantId) || seen.has(e.variantId)) continue;
      if (e.orderBy <= lastNow || e.orderBy > joinEnd) continue;
      if (input.link && linkCovers(key) && inLink(e)) continue;
      seen.add(e.variantId);
      const l = lineOf(e.variantId, [e], info, true);
      if (l) joinable.push({ ...l, selected: false });
    }
    sortLines(joinable);
    // The supplier's order-by date (M2): ordersDue over every order behind its lines; asked-for
    // lines without a planned order only when nothing else gives a date.
    const due = ordersDue(lines.flatMap((l) => accs.get(l.variantId)?.events ?? []));
    const orderBy = due.orderBy ?? (due.overdue ? null : (lines.map((l) => l.orderBy).filter((d): d is string => !!d).sort()[0] ?? null));
    out.push({
      key,
      kind: info.kind,
      supplierId: info.supplierId,
      name: info.name,
      leadTimeDays: info.leadTimeDays,
      leadTimeSource: info.leadTimeSource,
      orderBy,
      overdue: due.overdue || lines.some((l) => l.overdue),
      late: lines.some((l) => (l.outlook ? l.outlook.outNow || l.outlook.beforeArrival : l.overdue && !l.dueNote?.belowSafety)),
      currency: info.currency,
      storeCurrency: plan.currency.toUpperCase(),
      exchangeRate: info.exchangeRate,
      minOrderTotal: info.minOrderTotal,
      minOrderValue: info.minOrderValue,
      minOrderValueStore: info.minOrderValueStore,
      minOrderScope: info.minOrderScope,
      minOrder: info.minOrder,
      toppedUp: batches.some((b) => b.toppedUp),
      valueToppedUp: batches.some((b) => b.valueToppedUp),
      styleToppedUp: [...new Set(batches.flatMap((b) => b.styleToppedUp))],
      hasEmail: info.hasEmail,
      selected: lines.some((l) => l.selected),
      lines,
      joinable,
      planCoverDays: planCoverDays(plan.suppliers[key]),
      coverDays: input.coverDays?.get(key) ?? null,
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.selected) - Number(a.selected) ||
      Number(b.overdue) - Number(a.overdue) ||
      (a.orderBy ?? "9999").localeCompare(b.orderBy ?? "9999") ||
      Number(a.kind === "vendor") - Number(b.kind === "vendor") ||
      a.name.localeCompare(b.name),
  );
}

/** By product then variant (sizes adjacent); a product with an overdue line first. */
export function sortLines(lines: ReorderLine[]): ReorderLine[] {
  const overdue = new Set(lines.filter((l) => l.overdue).map((l) => l.productId));
  return lines.sort(
    (a, b) =>
      Number(overdue.has(b.productId)) - Number(overdue.has(a.productId)) ||
      a.productTitle.localeCompare(b.productTitle) ||
      (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0) ||
      a.variantTitle.localeCompare(b.variantTitle) ||
      (a.variantId < b.variantId ? -1 : 1),
  );
}

/** Consecutive lines of one product (style), for the product subtotal rows. */
export function productRuns(lines: readonly ReorderLine[]): { productId: string; title: string; lines: ReorderLine[] }[] {
  const out: { productId: string; title: string; lines: ReorderLine[] }[] = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.productId === l.productId) last.lines.push(l);
    else out.push({ productId: l.productId, title: l.productTitle, lines: [l] });
  }
  return out;
}

export type OrderTotals = {
  units: number;
  /** Store currency; null when no ordered line has a cost. */
  cost: number | null;
  /** Supplier currency, only with an exchange rate (or the same currency); null otherwise. */
  supplierCost: number | null;
  /** Ordered lines without a cost price (not in the totals). */
  missingCost: number;
};

/**
 * Units and cost of an order at the given quantities. Valued in the store's currency; a line
 * without a cost is "—" and counted, it never blanks the whole order.
 */
export function orderTotals(
  group: Pick<ReorderGroup, "currency" | "storeCurrency" | "exchangeRate">,
  lines: readonly Pick<ReorderLine, "variantId" | "unitCostStore">[],
  qty: (variantId: string) => number,
): OrderTotals {
  let units = 0;
  let cost = 0;
  let known = 0;
  let missing = 0;
  for (const l of lines) {
    const q = qty(l.variantId);
    if (!(q > 0)) continue;
    units += q;
    if (l.unitCostStore === null) missing++;
    else {
      cost += l.unitCostStore * q;
      known++;
    }
  }
  const store = known ? Math.round(cost * 100) / 100 : null;
  const same = group.currency.toUpperCase() === group.storeCurrency.toUpperCase();
  const supplierCost = store === null ? null : same ? store : group.exchangeRate && group.exchangeRate > 0 ? Math.round((store / group.exchangeRate) * 100) / 100 : null;
  return { units, cost: store, supplierCost, missingCost: missing };
}

/** Units and cost (order currency) of a group at the given quantities; cost null when any ordered line has no unit cost. */
export function groupTotals(
  lines: readonly Pick<ReorderLine, "variantId" | "unitCost">[],
  qty: (variantId: string) => number,
): { units: number; cost: number | null } {
  let units = 0;
  let cost: number | null = 0;
  for (const l of lines) {
    const q = qty(l.variantId);
    if (!(q > 0)) continue;
    units += q;
    if (cost !== null) cost = l.unitCost === null ? null : cost + l.unitCost * q;
  }
  return { units, cost: cost === null ? null : Math.round(cost * 100) / 100 };
}

export type MinimumWarnings = {
  /** The order total is below the supplier's order minimum. */
  belowTotal: boolean;
  /** The order value (store currency) is below the supplier's minimum order value. */
  belowValue: boolean;
  /** Lines below the per-variant minimum. */
  belowLine: string[];
  /** Products (styles) below the minimum per style. */
  belowStyle: string[];
  /** Lines that aren't a whole number of case packs. */
  notPack: string[];
};

/** Warnings for edited quantities (never a block). Lines at 0 are left out of the order and not warned. */
export function minimumWarnings(
  group: Pick<ReorderGroup, "minOrderTotal" | "lines"> & Partial<Pick<ReorderGroup, "minOrderValueStore" | "minOrderScope" | "minOrder">>,
  qty: (variantId: string) => number,
): MinimumWarnings {
  const belowLine: string[] = [];
  const notPack: string[] = [];
  const style = new Map<string, number>();
  let total = 0;
  let value = 0;
  let valued = false;
  for (const l of group.lines) {
    const q = qty(l.variantId);
    if (!(q > 0)) continue;
    total += q;
    if (l.unitCostStore !== null && l.unitCostStore !== undefined) {
      value += l.unitCostStore * q;
      valued = true;
    }
    if (group.minOrderScope === "product") style.set(l.productId, (style.get(l.productId) ?? 0) + q);
    else if (l.moq && q < l.moq) belowLine.push(l.variantId);
    if (l.pack && l.pack > 1 && q % l.pack !== 0) notPack.push(l.variantId);
  }
  const belowStyle = group.minOrderScope === "product" && group.minOrder ? [...style].filter(([, q]) => q < group.minOrder!).map(([p]) => p) : [];
  return {
    belowTotal: !!group.minOrderTotal && total > 0 && total < group.minOrderTotal,
    belowValue: !!group.minOrderValueStore && valued && total > 0 && value < group.minOrderValueStore - 1e-9,
    belowLine,
    belowStyle,
    notPack,
  };
}

/** Quantity typed by the merchant → whole units 0…1,000,000 (anything else 0). */
export function readQty(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : 0;
}

const VARIANT_ENTRY = /^(?:gid:\/\/shopify\/ProductVariant\/)?(\d{1,20})(?::(\d{1,7}))?$/;

/**
 * `?variants=` → variant gids (at most 250) and planned quantities. Entries are a gid or a
 * numeric id (an action's "Add to purchase order"), optionally `:qty` (whole units 1…1,000,000); anything
 * else is ignored. Large orders don't travel in the URL: orderLink (a supplier + date range) and
 * the Season plan's `?scenario=` are resolved on the server.
 */
export function parseVariantsWithQty(raw: string | null): { ids: string[]; planned: Map<string, number> } {
  const ids = new Set<string>();
  const planned = new Map<string, number>();
  if (!raw) return { ids: [], planned };
  for (const part of raw.split(",")) {
    if (ids.size >= 250) break;
    const m = VARIANT_ENTRY.exec(part.trim());
    if (!m) continue;
    const id = `gid://shopify/ProductVariant/${m[1]}`;
    ids.add(id);
    if (m[2] !== undefined) {
      const q = readQty(m[2]);
      if (q > 0) planned.set(id, Math.max(planned.get(id) ?? 0, q));
    }
  }
  return { ids: [...ids], planned };
}

/** `?variants=gid,gid` (or numeric ids, optionally `id:qty`) → variant gids, at most 250. */
export function parseVariantsParam(raw: string | null): string[] {
  return parseVariantsWithQty(raw).ids;
}

/** The group's heading: the supplier, or "No supplier — grouped by vendor". */
export function groupTitle(g: Pick<ReorderGroup, "kind" | "name">, t: T): string {
  if (g.kind === "supplier") return g.name;
  return g.name || t("No vendor");
}

/** The days of stock after arrival an order covers by plan: the supplier's own cycle, else the computed one. */
export function planCoverDays(s: { orderCycleDays?: number | null; cycleDays?: number | null } | undefined): number | null {
  const v = s?.orderCycleDays ?? s?.cycleDays ?? null;
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.round(v) : null;
}

/**
 * `?cover=supplier:abc~180&cover=vendor:acme~90` → supplier key → days (Due now, one choice per
 * supplier). Invalid entries are ignored; the last one for a key wins.
 */
export function parseCoverParams(values: readonly string[], read: (v: unknown) => number | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of values) {
    const i = raw.lastIndexOf("~");
    if (i <= 0) continue;
    const days = read(raw.slice(i + 1));
    if (days !== null) out.set(raw.slice(0, i), days);
  }
  return out;
}

/** The search params with one supplier's choice set (null = back to the plan's). */
export function withCoverParam(params: URLSearchParams, key: string, days: number | null): URLSearchParams {
  const next = new URLSearchParams(params);
  const keep = next.getAll("cover").filter((v) => v.slice(0, v.lastIndexOf("~")) !== key);
  next.delete("cover");
  for (const v of keep) next.append("cover", v);
  if (days !== null) next.append("cover", `${key}~${days}`);
  return next;
}
