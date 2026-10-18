/**
 * Order plan (Kanwar 2026-10-17; ordering audit 2026-10-17): the forward order plan
 * (engine/forward-plan-shared) shaped for the screens — Dashboard "Due this week", Order now,
 * Order plan · Next 13 weeks, the Free preview and the 13-week CSV. Pure, client-safe; the
 * database part is models/order-plan.server.ts.
 */
import { addDays, type DayKey } from "./engine/dates-shared";
import {
  ORDER_NOW_DAYS,
  PLAN_WEEKS,
  bySupplier,
  byWeek,
  cashTotals,
  dueDay,
  dueNote,
  dueState,
  dueWithin,
  type DueNote,
  planEnd,
  type BelowMinimum,
  type CashTotals,
  type OrderWhy,
  type PlanBatch,
  type PlanEvent,
  type PlanSupplierWeek,
  type PlanWeek,
} from "./engine/forward-plan-shared";
import { toCsv, variantName } from "./products-shared";
import { fill } from "./i18n";
import type { TrendMode } from "./settings-shared";
import { cashMonths, cashSummary, cashWeeks, fitToBudget, paymentsOf, type CashMonth, type CashSummary, type CashWeek, type CommittedPayment, type FitMonth, type PaymentTerms } from "./cash-shared";
import type { LeadStats } from "./lead-time-shared";
import type { HoldBatch } from "./deferral-shared";

type T = (s: string) => string;

export type PlanVariantInfo = {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  image: string | null;
  /** Days of stock left (VariantMetric); null unknown. */
  daysLeft: number | null;
  neverRunsOut: boolean;
  /** Order-by date of the forward plan (overdue → in the past). */
  deadline: DayKey | null;
  /** Forecast sales per day × price: the money at stake per day, for ranking. */
  valuePerDay: number | null;
  /** Sales per day while in stock (VariantMetric.rate). */
  rate?: number | null;
  /** Unit cost in the supplier's currency (only with an exchange rate, or the same currency). */
  unitCostSupplier?: number | null;
  /** Case pack and per-variant minimum used for the line. */
  pack?: number | null;
  moq?: number | null;
};

export type PlanSupplierInfo = {
  key: string;
  kind: "supplier" | "vendor";
  supplierId: string | null;
  name: string;
  /** The supplier's currency (upper case; the store's when not set). */
  currency?: string;
  /** 1 unit of the supplier's currency in the store's currency; null = unknown. */
  exchangeRate?: number | null;
  minOrderTotal?: number | null;
  /** Minimum order value in the supplier's currency, and in the store's (null: unknown rate). */
  minOrderValue?: number | null;
  minOrderValueStore?: number | null;
  minOrder?: number | null;
  minOrderScope?: "variant" | "product";
  leadTimeDays?: number;
  leadTimeSource?: "supplier" | "default";
  hasEmail?: boolean;
  /**
   * The order cycle (days) — the "Can join this order" window and the supplier order builder's:
   * the supplier's own "Order every … days", else the longest cycle of its products.
   */
  cycleDays?: number | null;
  /** The supplier's own "Order every … days" (Settings → Suppliers); null = the store's order cycle. */
  orderCycleDays?: number | null;
  /** Payment terms (lib/cash-shared); null / absent = everything paid when ordering. */
  terms?: PaymentTerms | null;
  /** Freight + duty, % of the goods (null = none). */
  landedPct?: number | null;
  /** Days from ship date to arrival (the "at shipment" balance day). */
  transitDays?: number | null;
  /** Measured lead time (lib/lead-time-shared); null = nothing measured yet. */
  leadStats?: LeadStats | null;
};

export type OrderPlanData = {
  today: DayKey;
  currency: string;
  timezone: string;
  /** Every planned order from today through the end of the 13th week. */
  events: PlanEvent[];
  variants: Record<string, PlanVariantInfo>;
  suppliers: Record<string, PlanSupplierInfo>;
  /** At least one supplier exists in Settings → Suppliers. */
  suppliersSetUp: boolean;
  /** Products that can't be planned: no / too little sales history, dead stock. */
  cantPlan: { noData: number; dead: number };
  /** The supplier orders the plan assumes (batch 0 = the next 7 days) and their top-ups. */
  batches?: PlanBatch[];
  /** Keha drafts older than 14 days: no longer counted as ordered. */
  staleDrafts?: number;
  /** Products marked "Don't reorder" (left out of every order). */
  notReordered?: number;
  /** Growth assumption: the trend is in the forecast only with "store" (absent = "off"). */
  trendMode?: TrendMode;
  /** Still to pay on orders already sent / confirmed (lib/cash-shared openOrderPayments). */
  committed?: CommittedPayment[];
  /** Monthly budget for stock (Settings → Defaults); null / absent = none. */
  budget?: number | null;
  /** A2: styles held back below their supplier's minimum per style (forward-plan BelowMinimum). */
  belowMinimum?: (BelowMinimum & { productTitle: string })[];
  /** Fit to budget → Apply: orders moved to next month, per Apply (lib/deferral-shared); absent / [] = none. */
  holds?: HoldBatch[];
};

export const EMPTY_ORDER_PLAN = (today: DayKey, currency = "USD", timezone = "UTC"): OrderPlanData => ({
  today,
  currency,
  timezone,
  events: [],
  variants: {},
  suppliers: {},
  suppliersSetUp: false,
  cantPlan: { noData: 0, dead: 0 },
  batches: [],
  staleDrafts: 0,
  notReordered: 0,
});

/** Weekday-aligned "same weeks last year": 52 weeks back. */
export const LAST_YEAR_OFFSET_DAYS = 364;
/** A suggestion above this × last year's sales in the same weeks gets a warning. */
export const LAST_YEAR_WARN_RATIO = 1.5;

/** The suggestion is more than 1.5× what sold in the same weeks last year (unknown → no warning). */
export function aboveLastYear(qty: number, lastYear: number | null | undefined): boolean {
  return typeof lastYear === "number" && Number.isFinite(lastYear) && qty > LAST_YEAR_WARN_RATIO * lastYear;
}

/**
 * A line's unit cost in the store's currency and in the supplier's. Shopify stores cost per
 * item in the store's currency; a cost in another currency is converted only with the
 * supplier's exchange rate (1 supplier unit = rate store units). Unknown stays null.
 */
export function lineCosts(
  cost: number | null,
  costCurrency: string | null,
  storeCurrency: string,
  supplierCurrency: string | null,
  exchangeRate: number | null,
): { store: number | null; supplier: number | null } {
  if (cost === null || !Number.isFinite(cost) || cost < 0) return { store: null, supplier: null };
  const store = storeCurrency.toUpperCase();
  const from = (costCurrency || store).toUpperCase();
  const sup = (supplierCurrency || store).toUpperCase();
  const rate = exchangeRate && exchangeRate > 0 ? exchangeRate : null;
  if (from === store) return { store: cost, supplier: sup === store ? cost : rate ? cost / rate : null };
  if (from === sup) return { store: rate ? cost * rate : null, supplier: cost };
  return { store: null, supplier: null };
}

/** Supplier name, or the vendor ("No vendor" when blank). */
export function supplierName(data: Pick<OrderPlanData, "suppliers">, key: string, t: T): string {
  const s = data.suppliers[key];
  if (!s) return t("No vendor");
  return s.kind === "supplier" ? s.name : s.name || t("No vendor");
}

/**
 * Order now with these orders selected (`?supplier=key&from=day&to=day`): the Order now loader
 * re-reads the same plan and takes that supplier's orders with an order-by date in the range,
 * at the planned quantities — any number of lines, nothing is truncated (audit: the old
 * `?variants=id:qty` link kept 250 and dropped the rest). Creating the purchase order still
 * needs the merchant's confirm there.
 */
export function orderLink(events: readonly Pick<PlanEvent, "orderBy" | "supplierKey">[], supplierKey?: string): string {
  const params = new URLSearchParams();
  const key = supplierKey ?? (new Set(events.map((e) => e.supplierKey)).size === 1 ? events[0]?.supplierKey : undefined);
  if (key) params.set("supplier", key);
  const days = events.map((e) => e.orderBy).sort();
  if (days.length) {
    params.set("from", days[0]!);
    params.set("to", days[days.length - 1]!);
  }
  const qs = params.toString().replace(/%3A/g, ":");
  return qs ? `/app/reorder?${qs}` : "/app/reorder";
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `?supplier=&from=&to=` → the orders an orderLink selected (null when the link has no range). */
export function readOrderLink(params: URLSearchParams): { supplierKey: string | null; from: DayKey; to: DayKey } | null {
  const from = params.get("from");
  const to = params.get("to");
  if (!from || !to || !DAY.test(from) || !DAY.test(to) || from > to) return null;
  const key = params.get("supplier");
  return { supplierKey: key && key.length <= 300 ? key : null, from, to };
}

/** The plan's orders an orderLink selected. */
export function linkedEvents(events: readonly PlanEvent[], link: { supplierKey: string | null; from: DayKey; to: DayKey }): PlanEvent[] {
  return events.filter((e) => (!link.supplierKey || e.supplierKey === link.supplierKey) && e.orderBy >= link.from && e.orderBy <= link.to);
}

export type ThisWeekView = {
  suppliers: PlanSupplierWeek[];
  totals: CashTotals;
  /** The first order after this week (empty-state line). */
  next: { supplierKey: string; orderBy: DayKey } | null;
};

/** "Due this week" = Order now: orders due in the next 7 days (overdue ones included), by supplier. */
export function thisWeek(data: Pick<OrderPlanData, "events" | "today">): ThisWeekView {
  const due = dueWithin(data.events, data.today, ORDER_NOW_DAYS);
  const later = data.events.filter((e) => e.orderBy > addDays(data.today, ORDER_NOW_DAYS - 1)).sort((a, b) => a.orderBy.localeCompare(b.orderBy) || (a.supplierKey < b.supplierKey ? -1 : 1));
  return {
    suppliers: bySupplier(due),
    totals: cashTotals(due),
    next: later[0] ? { supplierKey: later[0].supplierKey, orderBy: later[0].orderBy } : null,
  };
}

/** The calendar weeks (13 by default; the Dashboard strip uses 12). */
export function planWeeks(data: Pick<OrderPlanData, "events" | "today">, weeks: number = PLAN_WEEKS): PlanWeek[] {
  return byWeek(data.events, data.today, weeks);
}

// ── Cash paid per week and per month (supplier module, lib/cash-shared) ─────────

/** The cash paid in each of the next `weeks` weeks: the plan's orders on the days they are paid, plus what is still due on open orders. */
export function paidWeeks(data: Pick<OrderPlanData, "events" | "today" | "committed">, weeks: number = PLAN_WEEKS): CashWeek[] {
  return cashWeeks(data.events, data.committed ?? [], data.today, weeks);
}

/** The totals of paidWeeks, and what is paid after them. */
export function paidSummary(data: Pick<OrderPlanData, "events" | "today" | "committed">, weeks: number = PLAN_WEEKS): CashSummary {
  return cashSummary(data.events, data.committed ?? [], data.today, weeks);
}

/** The cash paid in the next `days` days (today included; "Due this week"'s window): orders to place + still due on open orders. */
export function paidWithin(data: Pick<OrderPlanData, "events" | "today" | "committed">, days: number = ORDER_NOW_DAYS): { total: number; committed: number } {
  const last = addDays(data.today, days - 1);
  const inWindow = (d: DayKey) => (d < data.today ? data.today : d) <= last;
  let total = 0;
  let committed = 0;
  for (const e of data.events) for (const p of paymentsOf(e)) if (inWindow(p.day)) total += p.amount;
  for (const p of data.committed ?? []) {
    if (!inWindow(p.day)) continue;
    total += p.amount;
    committed += p.amount;
  }
  return { total: Math.round(total * 100) / 100, committed: Math.round(committed * 100) / 100 };
}

/** The calendar months of the next 13 weeks with the cash paid in each. */
export function planMonths(data: Pick<OrderPlanData, "events" | "today" | "committed">): CashMonth[] {
  return cashMonths(data.events, data.committed ?? [], data.today, planEnd(data.today));
}

/** The months over the monthly budget, with the "Fit to budget" suggestion (empty without a budget). */
export function planFit(data: Pick<OrderPlanData, "events" | "today" | "committed" | "budget" | "variants" | "batches" | "suppliers">): FitMonth[] {
  if (!data.budget || !(data.budget > 0)) return [];
  const rules: Record<string, { minTotal: number | null; minValue: number | null; styleMin: number | null }> = {};
  for (const [key, s] of Object.entries(data.suppliers)) {
    rules[key] = { minTotal: s.minOrderTotal ?? null, minValue: s.minOrderValueStore ?? null, styleMin: s.minOrderScope === "product" ? (s.minOrder ?? null) : null };
  }
  return fitToBudget({
    today: data.today,
    end: planEnd(data.today),
    budget: data.budget,
    events: data.events,
    committed: data.committed ?? [],
    variants: data.variants,
    batches: data.batches ?? [],
    rules,
  });
}

export type PreviewRow = {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  daysLeft: number | null;
  neverRunsOut: boolean;
  /** dueDay: null = overdue, already out, run-out day unknown. */
  orderBy: DayKey | null;
  overdue: boolean;
  qty: number;
  /** A1: the season's first order, or why an overdue order has no date. */
  dueNote?: DueNote | null;
};

/**
 * Free plan preview: each variant's next order, most urgent first (order-by date, overdue
 * first), then the money at stake per day; the top `limit` (10).
 */
export function previewRows(data: Pick<OrderPlanData, "events" | "variants">, limit = 10): PreviewRow[] {
  const first = new Map<string, PlanEvent>();
  for (const e of data.events) {
    const cur = first.get(e.variantId);
    if (!cur || e.orderBy < cur.orderBy) first.set(e.variantId, e);
  }
  const rows = [...first.values()].map((e) => {
    const v = data.variants[e.variantId];
    const when = dueDay(e);
    return {
      row: {
        variantId: e.variantId,
        productTitle: v?.productTitle ?? "",
        variantTitle: v?.variantTitle ?? "",
        daysLeft: v?.daysLeft ?? null,
        neverRunsOut: !!v?.neverRunsOut,
        orderBy: when,
        overdue: e.overdue,
        qty: e.qty,
        dueNote: dueNote([e]),
      },
      value: v?.valuePerDay ?? -1,
    };
  });
  rows.sort(
    (a, b) =>
      // Overdue first (an overdue order with no date before the dated ones), then by date.
      Number(b.row.overdue) - Number(a.row.overdue) ||
      (a.row.orderBy ?? "").localeCompare(b.row.orderBy ?? "") ||
      b.value - a.value ||
      a.row.productTitle.localeCompare(b.row.productTitle) ||
      (a.row.variantId < b.row.variantId ? -1 : 1),
  );
  return rows.slice(0, limit).map((r) => r.row);
}

/** The 90-day plan as CSV (headers in the admin language; unknown costs left empty, never 0). */
export function planCsv(data: OrderPlanData, t: T): string {
  const header = [t("Week of"), t("Order by"), t("Expected arrival"), t("Supplier"), t("Product"), t("Variant"), t("SKU"), t("Quantity"), t("Unit cost"), t("Line total"), t("Currency")];
  const rows = planWeeks(data).flatMap((w) =>
    w.suppliers.flatMap((s) =>
      s.events.map((e) => {
        const v = data.variants[e.variantId];
        return [
          w.weekStart,
          e.orderBy,
          e.arrives,
          supplierName(data, s.supplierKey, t),
          v?.productTitle ?? "",
          variantName(v?.variantTitle ?? "") ?? "",
          v?.sku ?? "",
          e.qty,
          e.unitCost,
          e.cost,
          data.currency,
        ];
      }),
    ),
  );
  return toCsv(header, rows);
}

/** "19–25 Oct" (Monday – Sunday of the ISO week), in the admin language. */
export function formatWeekRange(weekStartDay: DayKey, locale: string): string {
  const from = new Date(`${weekStartDay}T12:00:00Z`);
  const to = new Date(`${addDays(weekStartDay, 6)}T12:00:00Z`);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };
  try {
    const f = new Intl.DateTimeFormat(locale, opts) as Intl.DateTimeFormat & { formatRange?: (a: Date, b: Date) => string };
    if (typeof f.formatRange === "function") return f.formatRange(from, to);
    return `${f.format(from)} – ${f.format(to)}`;
  } catch {
    return `${weekStartDay} – ${addDays(weekStartDay, 6)}`;
  }
}

/** "12 Nov" or "12–14 Nov" for an order-by range. */
export function formatDayRange(from: DayKey | null, to: DayKey | null, locale: string): string {
  if (!from) return "—";
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };
  const a = new Date(`${from}T12:00:00Z`);
  try {
    const f = new Intl.DateTimeFormat(locale, opts) as Intl.DateTimeFormat & { formatRange?: (a: Date, b: Date) => string };
    if (!to || to === from) return f.format(a);
    const b = new Date(`${to}T12:00:00Z`);
    return typeof f.formatRange === "function" ? f.formatRange(a, b) : `${f.format(a)} – ${f.format(b)}`;
  } catch {
    return to && to !== from ? `${from} – ${to}` : from;
  }
}

// ---------------------------------------------------------------------------
// Ordering texts shared by Order now, Next 13 weeks and Products (ordering audit 2026-10-17)
// ---------------------------------------------------------------------------

/** "27 Oct" (no year), in the admin language. */
export function shortDay(day: DayKey, locale: string): string {
  return formatDayRange(day, null, locale);
}

/**
 * A line's real deadline: "Due today", "Due 27 Oct", "Overdue since 12 Oct"; "Overdue" when it is
 * late with no date (already out, run-out day unknown — M3); "—" unknown.
 */
export function dueText(deadline: DayKey | null | undefined, today: DayKey, t: T, locale: string, overdue = false, note?: DueNote | null): string {
  const state = dueState(deadline, today, overdue);
  if (state === null) return "—";
  if (!deadline) {
    // A1: long overdue — the day it sold out, or will, instead of a date months back.
    if (note?.soldOutSince) return fill(t("Overdue · out of stock since {date}"), { date: shortDay(note.soldOutSince, locale) });
    if (note?.runsOut) return fill(t("Overdue · runs out {date}"), { date: shortDay(note.runsOut, locale) });
    return t("Overdue");
  }
  // A1: off season now — the next order is the season's.
  if (note?.nextSeason && state !== "overdue") return fill(t("Next season: order by {date}"), { date: shortDay(deadline, locale) });
  if (state === "overdue") return fill(t("Overdue since {date}"), { date: shortDay(deadline, locale) });
  if (state === "today") return t("Due today");
  return fill(t("Due {date}"), { date: shortDay(deadline, locale) });
}

function nf(v: number, locale: string, digits = 1): string {
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v);
  } catch {
    return String(Math.round(v * 10 ** digits) / 10 ** digits);
  }
}

/** "July 2026" in the admin language (a store-local day key). */
export function monthYear(day: DayKey, locale: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  try {
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
  } catch {
    return day.slice(0, 7);
  }
}

/**
 * "Why this quantity": the terms the plan used for one order (never recomputed): the forecast,
 * safety stock, stock and stock on order, the need, then the rounding and any top-up.
 */
export function whyLines(why: OrderWhy, t: T, locale: string): string[] {
  const first = why.day === 0;
  const qty = why.rounded + why.topUp;
  const vars = {
    n: nf(why.days, locale, 0),
    demand: nf(why.demand, locale),
    rate: nf(why.rate, locale, 2),
    season: nf(why.season, locale, 2),
    safety: nf(why.safety, locale),
    onHand: nf(why.onHand, locale),
    onOrder: nf(why.onOrder, locale),
    missed: nf(why.missed ?? 0, locale),
    need: nf(Math.max(0, why.need), locale),
  };
  // Data audit #1: sales missed while sold out before the order lands are lost, not ordered back.
  // Merchant audit 2026-10-18: worded as what they are — future sales this order can't serve —
  // not "missed while sold out" (read as sales already lost).
  const missed = (why.missed ?? 0) > 1e-6;
  const out = [
    fill(
      missed
        ? first
          ? t("Forecast for the next {n} days: {demand} (sales per day {rate}, season ×{season}) + safety {safety} − on hand {onHand} − on order {onOrder} − sales it can't cover (out of stock before it arrives) {missed} = {need}")
          : t("Forecast for the {n} days from this order: {demand} (sales per day {rate}, season ×{season}) + safety {safety} − stock expected then {onHand} − on order {onOrder} − sales it can't cover (out of stock before it arrives) {missed} = {need}")
        : first
          ? t("Forecast for the next {n} days: {demand} (sales per day {rate}, season ×{season}) + safety {safety} − on hand {onHand} − on order {onOrder} = {need}")
          : t("Forecast for the {n} days from this order: {demand} (sales per day {rate}, season ×{season}) + safety {safety} − stock expected then {onHand} − on order {onOrder} = {need}"),
      vars,
    ),
  ];
  // B4: what the safety stock covers.
  if (why.safetyBasis && why.safety > 0)
    out.push(
      fill(t("Safety {safety}: the forecast's own error over {n} days (± {error}) for a {pct} % in-stock target."), {
        safety: nf(why.safety, locale, 0),
        n: nf(why.safetyBasis.days, locale, 0),
        error: nf(why.safetyBasis.error, locale, 0),
        pct: nf(why.safetyBasis.fill * 100, locale, 0),
      }),
    );
  if (why.sellsWhenOut) out.push(t("Sells when out of stock: what it sells while out of stock is owed, so it is ordered back."));
  // Data audit #2: out of stock most of the last 90 days — the pace comes from older in-stock days.
  if (why.paceFrom) out.push(fill(t("Sales per day based on in-stock days since {month}."), { month: monthYear(why.paceFrom, locale) }));
  // R4: one-off spikes capped in the pace; a new style planned like another product.
  if (why.spikes && why.spikes.count > 0) {
    const v = { n: nf(why.spikes.count, locale, 0), date: shortDay(why.spikes.day, locale), units: nf(why.spikes.sold, locale, 0), cap: nf(why.spikes.cap, locale, 0) };
    out.push(fill(why.spikes.count === 1 ? t("1 unusual day capped ({date}: {units} units, counted as {cap})") : t("{n} unusual days capped (largest {date}: {units} units, counted as {cap})"), v));
  }
  if (why.recurringSpikes) out.push(fill(t("High days that come back (promotions, repeat orders) count as {units} a day over the year."), { units: nf(why.recurringSpikes, locale, 1) }));
  if (why.planLike) {
    const v = { name: why.planLike.name, pct: nf(why.planLike.pct, locale, 0), days: nf(why.planLike.days, locale, 0) };
    out.push(
      fill(
        why.planLike.kind === "product"
          ? t("Based on {name} at {pct} % until this product has 28 days in stock (now {days}).")
          : t("Based on the median {name} product at {pct} % until this product has 28 days in stock (now {days})."),
        v,
      ),
    );
  }
  // B5: a sustained level change — the pace is the level since then.
  // Accuracy audit 2026-10-18: an open order past its expected day.
  if (why.latePo)
    out.push(
      fill(why.latePo.days === 1 ? t("An open order is 1 day late: counted as arriving now, with {units} more safety while it is late.") : t("An open order is {n} days late: counted as arriving now, with {units} more safety while it is late."), {
        n: nf(why.latePo.days, locale, 0),
        units: nf(why.latePo.extra, locale, 0),
      }),
    );
  if (why.levelShift) out.push(fill(why.levelShift.ratio >= 1 ? t("Sales stepped up on {date}; using the recent level.") : t("Sales dropped on {date}; using the recent level."), { date: shortDay(why.levelShift.day, locale) }));
  if (Math.abs(why.growth - 1) > 1e-9) out.push(fill(t("Growth assumption ×{growth} included in the forecast."), { growth: nf(why.growth, locale, 2) }));
  const r = { qty: nf(why.rounded, locale, 0), pack: nf(why.pack ?? 0, locale, 0), moq: nf(why.moq ?? 0, locale, 0) };
  out.push(
    fill(
      why.pack && why.pack > 1 && why.moq
        ? t("→ rounded to {qty} (case pack {pack} / minimum {moq})")
        : why.pack && why.pack > 1
          ? t("→ rounded to {qty} (case pack {pack})")
          : why.moq
            ? t("→ rounded to {qty} (minimum {moq})")
            : t("→ rounded to {qty}"),
      r,
    ),
  );
  if (why.topUp > 0) out.push(fill(t("+ {n} to reach the supplier's minimum order = {qty}"), { n: nf(why.topUp, locale, 0), qty: nf(qty, locale, 0) }));
  return out;
}

/**
 * M4: a line that adds up several orders (Order now: every order of the variant due in the next 7
 * days) says so — "Orders due in the next 7 days (2), added together: 30 + 43 = 73" — and each
 * order's terms get its date ("Order due 16 Oct:"). One order: nothing extra.
 */
export function whySum(
  whys: readonly OrderWhy[],
  today: DayKey,
  t: T,
  locale: string,
  /** The window the orders were added over (the supplier order builder: up to the end of the cycle). */
  days: number = ORDER_NOW_DAYS,
): { summary: string | null; headings: (string | null)[] } {
  if (whys.length < 2) return { summary: null, headings: whys.map(() => null) };
  const parts = whys.map((w) => w.rounded + w.topUp);
  return {
    summary: fill(days === ORDER_NOW_DAYS ? t("Orders due in the next 7 days ({n}), added together: {parts} = {total}") : t("Orders due in the next {days} days ({n}), added together: {parts} = {total}"), {
      days: nf(days, locale, 0),
      n: nf(whys.length, locale, 0),
      parts: parts.map((p) => nf(p, locale, 0)).join(" + "),
      total: nf(parts.reduce((a, b) => a + b, 0), locale, 0),
    }),
    headings: whys.map((w) => fill(t("Order due {date}:"), { date: shortDay(addDays(today, w.day), locale) })),
  };
}

/** The same weeks last year, for the popover. */
export function lastYearLine(lastYear: number | null | undefined, t: T, locale: string): string {
  return typeof lastYear === "number" && Number.isFinite(lastYear)
    ? fill(t("Sold in the same weeks last year: {n}"), { n: nf(lastYear, locale, 0) })
    : t("Sold in the same weeks last year: — (no history yet)");
}

export type LockTeaser = { more: number; suppliers: number; cash: number | null; missingCost: number };

/**
 * The teaching lock with the merchant's own numbers (Free): how many more products than the
 * preview shows have orders, from how many suppliers, and the 13-week cash. null = nothing more.
 */
export function lockTeaser(data: Pick<OrderPlanData, "events" | "variants">, limit = 10): LockTeaser | null {
  if (!data.events.length) return null;
  const products = new Set(data.events.map((e) => e.productId));
  const shown = new Set(previewRows(data, limit).map((r) => data.variants[r.variantId]?.productId ?? r.variantId));
  const more = [...products].filter((p) => !shown.has(p)).length;
  if (more <= 0) return null;
  const totals = cashTotals(data.events);
  return { more, suppliers: new Set(data.events.map((e) => e.supplierKey)).size, cash: totals.cash, missingCost: totals.missingCost };
}

/**
 * Next 13 weeks' footnote: what an order-by date is and what it is based on. The trend is named
 * only when the growth assumption is on (Settings → Defaults, trendMode "store"): with it off the
 * forecast doesn't use it (2026-10-17 click-through).
 */
export function orderByFootnote(trendMode: TrendMode | undefined, t: T): string {
  return trendMode === "store"
    ? t("Order-by date: the last day to order so the delivery arrives before your stock drops below its safety stock. Based on sales per day while in stock, last year's season, the trend, stock on hand and stock on order with its dates.")
    : t("Order-by date: the last day to order so the delivery arrives before your stock drops below its safety stock. Based on sales per day while in stock, last year's season, stock on hand and stock on order with its dates.");
}
