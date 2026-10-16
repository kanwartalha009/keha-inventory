/**
 * Variant status (spec §7.5). The first rule that matches wins:
 *   out → not_enough_data → dead → running_low → too_much → healthy.
 */
import { ENGINE_DEFAULTS, type EngineSettings, type VariantStatus } from "./types-shared";

export interface StatusInput {
  onHand: number;
  /** In-stock days over the history window. */
  inStockDays: number;
  /**
   * Days with no sale up to yesterday (null = unknown). When the series has
   * no sale at all, the caller passes the number of days the data covers.
   */
  noSaleDays: number | null;
  /** Days since the product was created (null = unknown → never dead). */
  productAgeDays: number | null;
  /** Null when there is no rate. */
  daysLeft: number | null;
  leadTimeDays: number;
  safetyDays: number;
  trend: number;
}

export function variantStatus(
  s: StatusInput,
  settings: EngineSettings = ENGINE_DEFAULTS,
): VariantStatus {
  if (s.onHand <= 0) return "out";
  if (s.inStockDays < settings.minInStockDays) return "not_enough_data";
  if (
    s.noSaleDays !== null &&
    s.noSaleDays >= settings.deadDays &&
    s.productAgeDays !== null &&
    s.productAgeDays >= settings.deadDays
  ) {
    return "dead";
  }
  if (s.daysLeft !== null && s.daysLeft < s.leadTimeDays + s.safetyDays) return "running_low";
  if (s.daysLeft !== null && s.daysLeft > settings.tooMuchDays && s.trend <= 1) return "too_much";
  return "healthy";
}
