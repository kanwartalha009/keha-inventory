/**
 * Engine input/output types and defaults (spec §7.1, §7.4, §7.5, §5.5;
 * KEHA-INVENTORY-INTELLIGENCE-SPEC-v1-2026-10-16). Pure, shared by server and UI.
 */
import type { DayKey } from "./dates-shared";

/**
 * One day of facts for one variant in one scope (online pool or one location),
 * spec §7.1. The caller aggregates locations. A day with no row is MISSING
 * data, which is different from a row with `sold: 0`.
 */
export interface DailyRow {
  day: DayKey;
  /** Net items sold (can be negative on a return-heavy day). */
  sold: number;
  /** Ending units on hand. Not used by the rate maths; kept for the caller. */
  endStock: number;
  /** True when the scope was out of stock that day. */
  outOfStock: boolean;
  returned?: number;
  /** Gross sales ÷ units for that day. */
  price?: number | null;
  cost?: number | null;
}

export const VARIANT_STATUSES = [
  "out",
  "not_enough_data",
  "dead",
  "running_low",
  "too_much",
  "healthy",
] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

export type AbcRole = "A" | "B" | "C";

export interface RateWindowSpec {
  days: number;
  weight: number;
}

export interface EngineSettings {
  /** Shop default lead time when the supplier has none (§7.4). */
  leadTimeDays: number;
  /** Order cycle (§7.4). */
  cycleDays: number;
  /** "Too much" when days left exceeds this (§7.5). */
  tooMuchDays: number;
  /** "Dead" after this many days without a sale, for products at least this old (§7.5). */
  deadDays: number;
  /** Below this many in-stock days (over `historyDays`): not enough data (§7.2). */
  minInStockDays: number;
  /** A rate window with fewer in-stock days than this is dropped (§7.2). */
  minWindowInStockDays: number;
  /** Rate windows and weights (§7.2). */
  rateWindows: readonly RateWindowSpec[];
  /** Look-back for in-stock day count, σ and sales lost to sell-outs (§7.2, §7.6). */
  historyDays: number;
  /** z by ABC role (§7.4). */
  z: Readonly<Record<AbcRole, number>>;
  /** ABC cumulative revenue cut-offs (§7.4). */
  abcAShare: number;
  abcBShare: number;
  /** Sales at risk horizon (§7.6). */
  atRiskDays: number;
  /** Cash stuck: units beyond this many days of forecast are "stuck" (§7.6). */
  cashStuckCoverDays: number;
  /** Sold-out page traffic look-back (§7.6). */
  soldOutTrafficDays: number;
}

export const ENGINE_DEFAULTS: Readonly<EngineSettings> = Object.freeze({
  leadTimeDays: 14,
  cycleDays: 14,
  tooMuchDays: 180,
  deadDays: 90,
  minInStockDays: 14,
  minWindowInStockDays: 7,
  rateWindows: Object.freeze([
    { days: 28, weight: 0.5 },
    { days: 56, weight: 0.3 },
    { days: 90, weight: 0.2 },
  ]),
  historyDays: 90,
  z: Object.freeze({ A: 1.65, B: 1.28, C: 1.04 }),
  abcAShare: 0.8,
  abcBShare: 0.95,
  atRiskDays: 28,
  cashStuckCoverDays: 90,
  soldOutTrafficDays: 30,
});

/** Shop overrides on top of ENGINE_DEFAULTS (undefined keys keep the default). */
export function resolveSettings(overrides?: Partial<EngineSettings> | null): EngineSettings {
  const out: EngineSettings = { ...ENGINE_DEFAULTS };
  if (!overrides) return out;
  for (const key of Object.keys(overrides) as (keyof EngineSettings)[]) {
    const v = overrides[key];
    if (v !== undefined && v !== null) (out as unknown as Record<string, unknown>)[key] = v;
  }
  return out;
}

/** Forecast multipliers (§7.3 values come from a later task; default 1.0). */
export interface ForecastMultipliers {
  seasonal: number;
  trend: number;
  plan: number;
}

/** Where a money card's value basis came from. */
export type CostBasis = "cost" | "retail";

export interface MoneyWindow {
  days: number;
  /** First day included. */
  from: DayKey;
  /** Last day included. */
  to: DayKey;
}

/** Every money card returns this shape; `amount` is null when inputs are insufficient ("—"). */
export interface MoneyCard<B> {
  amount: number | null;
  basis: B & { window: MoneyWindow; currency: string; costBasis: CostBasis };
}
