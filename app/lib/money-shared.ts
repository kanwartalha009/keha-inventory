/**
 * The four money-at-stake cards as stored in MoneyAtStake (one row per shop
 * per day) and shown on Home and in the Monday email (spec §5.1, §7.6, §11).
 * `basis` holds each card's engine basis for the "how we got this" popover.
 * Pure, client-safe.
 */
import type { AtRiskBasis, CashStuckBasis, LostBasis, TrafficBasis } from "./engine/money-shared";
import type { CostBasis, MoneyWindow } from "./engine/types-shared";
import type { MoneyRefresh } from "./plan-shared";

export const MONEY_CARDS = ["atRisk", "lost90", "cashStuck", "soldOutTraffic"] as const;
export type MoneyCardKey = (typeof MONEY_CARDS)[number];

/**
 * The two figures the Dashboard and the weekly summary show (clarity pass 2026-10-23): the same
 * window ahead, comparable at a glance. Lost sales and sold-out page visits are on the Actions page.
 */
export const DASHBOARD_MONEY = ["atRisk", "cashStuck"] as const satisfies readonly MoneyCardKey[];
/** The Actions page's money: what sold-out products already cost. */
export const ACTIONS_MONEY = ["lost90", "soldOutTraffic"] as const satisfies readonly MoneyCardKey[];

type Basis<B> = B & { window: MoneyWindow; currency: string; costBasis: CostBasis };

/** MoneyAtStake.basis JSON. */
export type MoneyBasisJson = {
  computedAt: string;
  currency: string;
  /** "weekly" on Free (audit 2026-10-17; "monthly" on rows stored before), "daily" on paid plans. */
  refresh: MoneyRefresh;
  atRisk: Basis<AtRiskBasis>;
  lost90: Basis<LostBasis>;
  cashStuck: Basis<CashStuckBasis>;
  soldOutTraffic: Basis<TrafficBasis>;
};

/** One day's cards for display: null = "—" (not enough data), never 0. */
export type MoneySnapshot = {
  day: string;
  currency: string;
  values: Record<MoneyCardKey, number | null>;
  basis: MoneyBasisJson | null;
};

/** Week-on-week change; null when either side is unknown. */
export function change(now: number | null, before: number | null): number | null {
  if (now == null || before == null) return null;
  return Math.round((now - before) * 100) / 100;
}
