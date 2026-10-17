/**
 * Order plan (Kanwar 2026-10-17): the forward order plan (engine/forward-plan-shared) shaped for
 * the screens — Dashboard "Order this week", Order plan · Next 90 days, the Free preview and the
 * 90-day CSV. Pure, client-safe; the database part is models/order-plan.server.ts.
 */
import { addDays, type DayKey } from "./engine/dates-shared";
import {
  PLAN_WEEKS,
  bySupplier,
  byWeek,
  cashTotals,
  dueWithin,
  type CashTotals,
  type PlanEvent,
  type PlanSupplierWeek,
  type PlanWeek,
} from "./engine/forward-plan-shared";
import { toCsv, variantName } from "./products-shared";

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
};

export type PlanSupplierInfo = { key: string; kind: "supplier" | "vendor"; supplierId: string | null; name: string };

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
});

/** Supplier name, or the vendor ("No vendor" when blank). */
export function supplierName(data: Pick<OrderPlanData, "suppliers">, key: string, t: T): string {
  const s = data.suppliers[key];
  if (!s) return t("No vendor");
  return s.kind === "supplier" ? s.name : s.name || t("No vendor");
}

/**
 * Order now with these lines selected at the planned quantities, filtered to the supplier
 * (`?variants=id:qty,…&supplier=key`). Several orders of one variant add up. Creating the
 * purchase order still needs the merchant's confirm there.
 */
export function orderLink(events: readonly Pick<PlanEvent, "variantId" | "qty" | "supplierKey">[], supplierKey?: string): string {
  const qty = new Map<string, number>();
  for (const e of events) {
    const id = /(\d+)$/.exec(e.variantId)?.[1];
    if (id && e.qty > 0) qty.set(id, (qty.get(id) ?? 0) + e.qty);
  }
  const parts = [...qty].slice(0, 250).map(([id, q]) => `${id}:${q}`);
  const params = new URLSearchParams();
  if (parts.length) params.set("variants", parts.join(","));
  if (supplierKey) params.set("supplier", supplierKey);
  const qs = params.toString().replace(/%3A/g, ":").replace(/%2C/g, ",");
  return qs ? `/app/reorder?${qs}` : "/app/reorder";
}

export type ThisWeekView = {
  suppliers: PlanSupplierWeek[];
  totals: CashTotals;
  /** The first order after this week (empty-state line). */
  next: { supplierKey: string; orderBy: DayKey } | null;
};

/** "Order this week": orders placed in the next 7 days (overdue ones included), by supplier. */
export function thisWeek(data: Pick<OrderPlanData, "events" | "today">): ThisWeekView {
  const due = dueWithin(data.events, data.today, 7);
  const later = data.events.filter((e) => e.orderBy > addDays(data.today, 6)).sort((a, b) => a.orderBy.localeCompare(b.orderBy) || (a.supplierKey < b.supplierKey ? -1 : 1));
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

export type PreviewRow = {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  daysLeft: number | null;
  neverRunsOut: boolean;
  orderBy: DayKey;
  overdue: boolean;
  qty: number;
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
    const when = e.overdue && e.deadline ? e.deadline : e.orderBy;
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
      },
      value: v?.valuePerDay ?? -1,
    };
  });
  rows.sort(
    (a, b) =>
      a.row.orderBy.localeCompare(b.row.orderBy) ||
      b.value - a.value ||
      a.row.productTitle.localeCompare(b.row.productTitle) ||
      (a.row.variantId < b.row.variantId ? -1 : 1),
  );
  return rows.slice(0, limit).map((r) => r.row);
}

/** The 90-day plan as CSV (headers in the admin language; unknown costs left empty, never 0). */
export function planCsv(data: OrderPlanData, t: T): string {
  const header = [t("Week of"), t("Order by"), t("Arrives"), t("Supplier"), t("Product"), t("Variant"), t("SKU"), t("Quantity"), t("Unit cost"), t("Line total"), t("Currency")];
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
