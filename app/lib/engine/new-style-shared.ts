/**
 * "Plan like…" for new styles (R4 forecast quality): how long a style borrows a reference pace
 * and how the borrowed and its own pace blend. Pure. The reference itself is resolved outside
 * the engine (lib/forecast-override-shared).
 */

/** In-stock days after which a style plans on its own pace only. */
export const PLAN_LIKE_DAYS = 28;

/** w = own in-stock days ÷ PLAN_LIKE_DAYS, 0 … 1 (1: its own pace only). */
export function ownWeight(inStockDays: number): number {
  const d = typeof inStockDays === "number" && Number.isFinite(inStockDays) ? inStockDays : 0;
  return Math.max(0, Math.min(1, d / PLAN_LIKE_DAYS));
}

/** The variant's share of the reference pace (VariantInput.planLike). */
export interface PlanLikeInput {
  /** Units per day for THIS variant: the reference's per-product pace × pct × the variant's share. */
  rate: number;
  kind: "product" | "productType";
  /** Product title or product type (shown to the merchant). */
  name: string;
  pct: number;
  /** The variant's share of the style (0 … 1). */
  share: number;
}
