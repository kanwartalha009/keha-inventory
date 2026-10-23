/**
 * "How we plan" — one line per page with the store's own rules (clarity pass 2026-10-23). The
 * method used to be repeated on every row and product ("Stock included in purchase orders: every
 * active location unless…", the forecast formula); research (Vance 2018: identical repeated text
 * is tuned out; Shopify content guidelines: don't say the same thing twice) says to state it once,
 * with only what differs per product. Pure.
 */
import type { SafetyLevel } from "./settings-shared";

export type PlanBasis = {
  leadTimeDays: number;
  cycleDays: number;
  safetyLevel: SafetyLevel;
  /** Suppliers set up (each can have its own lead time and order days). */
  suppliers: number;
  /** Locations left out of purchase orders (Settings → Locations). */
  locationsLeftOut: number;
};

type T = (s: string) => string;
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k]! : m));

export function bufferWord(level: SafetyLevel, t: T): string {
  return level === "lean" ? t("low safety stock") : level === "safe" ? t("high safety stock") : t("standard safety stock");
}

/** The parts of the line, in order (the component joins them with " · "). */
export function planBasisParts(b: PlanBasis, t: T, locale: string): string[] {
  const n = (v: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(v);
  return [
    t("Sales counted only on days in stock"),
    b.suppliers > 0
      ? fill(t("{n}-day lead time unless a supplier has its own"), { n: n(b.leadTimeDays) })
      : fill(t("{n}-day lead time"), { n: n(b.leadTimeDays) }),
    fill(t("stock for {n} days after each delivery"), { n: n(b.cycleDays) }),
    bufferWord(b.safetyLevel, t),
    ...(b.locationsLeftOut > 0
      ? [b.locationsLeftOut === 1 ? t("1 location left out of orders") : fill(t("{n} locations left out of orders"), { n: n(b.locationsLeftOut) })]
      : []),
  ];
}
