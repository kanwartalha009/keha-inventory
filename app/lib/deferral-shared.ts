/**
 * Fit to budget → "Apply" (merchant audit 2026-10-18). The suggestion (lib/cash-shared fitToBudget)
 * moves the lowest-priority orders of a month over budget to the supplier's next order next month.
 * Applying it stores one hold per deferred line (PlanDeferral: "don't order this variant before
 * day D"), in one batch the merchant can undo. The order plan (models/order-plan.server) moves
 * every planned order of a held variant due before D (never an overdue one) to D — with its arrival and payments — so
 * Order now, Next 13 weeks, the Dashboard and the cash all follow. Nothing is written to Shopify
 * and nothing is sent to a supplier; a hold ends by itself on its day. Pure, client-safe.
 */
import { addDays, daysBetween, type DayKey } from "./engine/dates-shared";
import type { FitMonth } from "./cash-shared";

/** One stored hold (PlanDeferral). */
export type PlanHold = {
  batch: string;
  /** The month it was applied for ("2026-11"). */
  month: string;
  variantId: string;
  supplierKey: string;
  /** The planned order day it was moved from, and the day it waits for. */
  fromDay: DayKey;
  until: DayKey;
  qty: number;
  /** Cash moved out of the month. */
  amount: number;
};

/** One "Apply" as the Next 13 weeks banner shows it. */
export type HoldBatch = { batch: string; month: string; lines: number; amount: number; until: DayKey; suppliers: string[] };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The holds still in force today (their day hasn't come). */
export function activeHolds<H extends Pick<PlanHold, "until">>(holds: readonly H[], today: DayKey): H[] {
  return holds.filter((h) => h.until > today);
}

/** The holds to store for one month's suggestion, in one batch (one per deferred line). */
export function holdsFromFit(fit: FitMonth, batch: string): PlanHold[] {
  return fit.deferrals.map((d) => ({
    batch,
    month: fit.month,
    variantId: d.variantId,
    supplierKey: d.supplierKey,
    fromDay: d.from,
    until: d.to,
    qty: d.qty,
    amount: round2(d.amount),
  }));
}

/**
 * Moves the plan's orders of held variants: an order of the variant due before the hold's day is
 * placed on that day instead, its arrival moved by the same days. An overdue order is never held
 * (Fit to budget never suggests one): when a held order's own deadline passes, the plan says it is
 * overdue and it shows again where it is due — the hold can't hide a stock-out. The latest hold of
 * a variant wins. In place; returns how many orders moved.
 */
export function applyHolds<E extends { variantId: string; orderBy: DayKey; arrives: DayKey; overdue?: boolean }>(
  events: E[],
  holds: readonly Pick<PlanHold, "variantId" | "until">[],
  today: DayKey,
): number {
  const until = new Map<string, DayKey>();
  for (const h of activeHolds(holds, today)) if (!until.has(h.variantId) || h.until > until.get(h.variantId)!) until.set(h.variantId, h.until);
  let moved = 0;
  for (const e of events) {
    const u = until.get(e.variantId);
    if (!u || e.orderBy >= u || e.overdue) continue;
    const shift = daysBetween(e.orderBy, u);
    e.orderBy = u;
    e.arrives = addDays(e.arrives, shift);
    moved++;
  }
  return moved;
}

/** The active holds per batch, newest first (the banner with Undo). */
export function holdBatches(holds: readonly PlanHold[], today: DayKey, supplierName: (key: string) => string): HoldBatch[] {
  const by = new Map<string, HoldBatch>();
  for (const h of activeHolds(holds, today)) {
    const b = by.get(h.batch) ?? by.set(h.batch, { batch: h.batch, month: h.month, lines: 0, amount: 0, until: h.until, suppliers: [] }).get(h.batch)!;
    b.lines++;
    b.amount = round2(b.amount + h.amount);
    if (h.until > b.until) b.until = h.until;
    const name = supplierName(h.supplierKey);
    if (!b.suppliers.includes(name)) b.suppliers.push(name);
  }
  return [...by.values()].sort((a, b) => (a.batch < b.batch ? 1 : -1));
}
