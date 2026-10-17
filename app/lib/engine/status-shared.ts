/**
 * Variant status (spec §7.5). The first rule that matches wins:
 *   out → not_enough_data → dead → running_low → too_much → healthy.
 *
 * Audit fixes 2026-10-17:
 *  - Out: on hand ≤ 0, including negative (oversold) positions.
 *  - Dead (M3): no sale in `deadDays` IN-STOCK days (sold-out days don't count) — unless it is
 *    OFF SEASON (it sold in the coming `deadDays` last year): then it is waiting for its season.
 *  - Running low (M2): the cover counting incoming that lands before the run-out
 *    (`coverDays`) is below lead time + safety days — a purchase order landing in time means
 *    not running low.
 *  - Too much (H6): days left are projected day by day with the seasonal shape, so a January
 *    low (index 0.4) doesn't read as a year of stock and pre-peak overstock shows. Never for an
 *    off-season product.
 */
import { ENGINE_DEFAULTS, type EngineSettings, type VariantStatus } from "./types-shared";

export interface StatusInput {
  onHand: number;
  /** In-stock days over the history window. */
  inStockDays: number;
  /**
   * In-stock days with no sale up to yesterday (null = unknown). When the series has no sale at
   * all, the caller passes the in-stock days the data covers.
   */
  noSaleDays: number | null;
  /** Days since the product was created (null = unknown → never dead). */
  productAgeDays: number | null;
  /** Days the on-hand stock lasts (projected); null when there is no rate. */
  daysLeft: number | null;
  /** Days until the first stock-out counting incoming (null → daysLeft is used). */
  coverDays?: number | null;
  leadTimeDays: number;
  safetyDays: number;
  trend: number;
  /** Sold in the coming `deadDays` last year: never Dead / Too much. */
  offSeason?: boolean;
}

export function variantStatus(
  s: StatusInput,
  settings: EngineSettings = ENGINE_DEFAULTS,
): VariantStatus {
  if (!(s.onHand > 0)) return "out";
  if (s.inStockDays < settings.minInStockDays) return "not_enough_data";
  if (
    !s.offSeason &&
    s.noSaleDays !== null &&
    s.noSaleDays >= settings.deadDays &&
    s.productAgeDays !== null &&
    s.productAgeDays >= settings.deadDays
  ) {
    return "dead";
  }
  const cover = s.coverDays ?? s.daysLeft;
  if (cover !== null && cover < s.leadTimeDays + s.safetyDays) return "running_low";
  if (!s.offSeason && s.daysLeft !== null && s.daysLeft > settings.tooMuchDays && s.trend <= 1) return "too_much";
  return "healthy";
}
