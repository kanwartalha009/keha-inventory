/**
 * "Plan like…" for new styles and "Don't cap" (R4 forecast quality). Pure.
 *
 * A new style has too few in-stock days for its own pace: Keha can't plan it, so its first
 * order is a guess. The merchant picks a similar product — or the product type — whose pace
 * (× an optional %) is used until the style has PLAN_LIKE_DAYS in-stock days:
 *
 *   reference (per product) = Σ the reference product's variant paces from the last compute
 *                              (VariantMetric.rate), or the MEDIAN of the per-product paces of
 *                              the type's other products with their own pace; × pct ÷ 100;
 *   per variant             = reference × the variant's share: its share of the style's units
 *                              so far, else equal shares;
 *   blended pace            = w × own pace + (1 − w) × reference,  w = own in-stock days ÷ 28,
 *                              so the style moves smoothly onto its own pace as it sells.
 *
 * The suggestion shown before the merchant chooses is the product type's median (they confirm).
 */
import { PLAN_LIKE_DAYS, ownWeight } from "./engine/new-style-shared";

export { PLAN_LIKE_DAYS, ownWeight };
export const PLAN_LIKE_PCT = Object.freeze({ min: 10, max: 500 });

export type LikeKind = "product" | "productType";

export interface OverrideRow {
  productId: string;
  noCap: boolean;
  likeKind: LikeKind | null;
  likeRef: string | null;
  likePct: number;
}

export interface ProductPace {
  productId: string;
  title: string;
  productType: string | null;
  /** Σ of its variants' paces (units per day while in stock). */
  rate: number;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Per-product paces from stored metrics: only variants with their OWN pace count (the metric
 * had enough data or the in-stock pace, and was not itself planned like another product).
 */
export function productPaces(
  metrics: readonly { variantId: string; rate: number | null; inputs: unknown }[],
  variants: readonly { id: string; productId: string; productTitle: string; productType: string | null }[],
): Map<string, ProductPace> {
  const byId = new Map(variants.map((v) => [v.id, v]));
  const out = new Map<string, ProductPace>();
  for (const m of metrics) {
    const v = byId.get(m.variantId);
    if (!v || !finite(m.rate) || m.rate < 0) continue;
    const inputs = m.inputs && typeof m.inputs === "object" ? (m.inputs as Record<string, unknown>) : {};
    if (inputs.planLike) continue;
    if (inputs.enoughData !== true && !inputs.pace) continue;
    const p = out.get(v.productId) ?? { productId: v.productId, title: v.productTitle, productType: v.productType, rate: 0 };
    p.rate += m.rate;
    out.set(v.productId, p);
  }
  return out;
}

/** Median per-product pace of a product type's products (without `exceptProductId`); null when none. */
export function typeMedian(paces: ReadonlyMap<string, ProductPace>, productType: string, exceptProductId?: string): { rate: number; products: number } | null {
  const xs = [...paces.values()].filter((p) => p.productType === productType && p.productId !== exceptProductId).map((p) => p.rate).sort((a, b) => a - b);
  if (!xs.length) return null;
  const n = xs.length;
  return { rate: n % 2 ? xs[(n - 1) / 2]! : (xs[n / 2 - 1]! + xs[n / 2]!) / 2, products: n };
}

export interface PlanLikeReference {
  kind: LikeKind;
  /** Product id or product type. */
  ref: string;
  /** What the merchant reads: the product's title or the type. */
  name: string;
  pct: number;
  /** Per-product pace after pct (units per day). */
  rate: number;
  /** Products behind a type median. */
  products?: number;
}

/** The reference an override points at, or null when it has none / the reference has no pace. */
export function resolveReference(o: Pick<OverrideRow, "likeKind" | "likeRef" | "likePct" | "productId"> | null | undefined, paces: ReadonlyMap<string, ProductPace>): PlanLikeReference | null {
  if (!o || !o.likeKind || !o.likeRef) return null;
  const pct = clampPct(o.likePct);
  if (o.likeKind === "product") {
    if (o.likeRef === o.productId) return null;
    const p = paces.get(o.likeRef);
    if (!p) return null;
    return { kind: "product", ref: o.likeRef, name: p.title, pct, rate: (p.rate * pct) / 100 };
  }
  const m = typeMedian(paces, o.likeRef, o.productId);
  if (!m) return null;
  return { kind: "productType", ref: o.likeRef, name: o.likeRef, pct, rate: (m.rate * pct) / 100, products: m.products };
}

export function clampPct(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 100;
  return Math.min(PLAN_LIKE_PCT.max, Math.max(PLAN_LIKE_PCT.min, n));
}

/** Each variant's share of the style: its share of the units sold so far, else equal. */
export function variantShares(units: ReadonlyMap<string, number>, variantIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!variantIds.length) return out;
  const total = variantIds.reduce((a, id) => a + Math.max(0, units.get(id) ?? 0), 0);
  for (const id of variantIds) out.set(id, total > 0 ? Math.max(0, units.get(id) ?? 0) / total : 1 / variantIds.length);
  return out;
}

/** Parse the product page's "Plan like" form; null when invalid. */
export function parsePlanLike(body: Record<string, unknown>, productId: string): { kind: LikeKind; ref: string; pct: number } | null {
  const kind = body.kind === "product" || body.kind === "productType" ? body.kind : null;
  const ref = typeof body.ref === "string" ? body.ref.trim() : "";
  if (!kind || !ref || ref.length > 300) return null;
  if (kind === "product" && (ref === productId || !/^gid:\/\/shopify\/Product\/\d+$/.test(ref))) return null;
  const pct = Number(body.pct);
  if (!Number.isInteger(pct) || pct < PLAN_LIKE_PCT.min || pct > PLAN_LIKE_PCT.max) return null;
  return { kind, ref, pct };
}
