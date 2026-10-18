/**
 * Per-product forecast choices (ForecastOverride, R4 forecast quality): "Don't cap" and
 * "Plan like…". Our database only — nothing in the merchant's store changes. Read by compute
 * (services/compute.server) and the product page.
 */
import prisma from "../db.server";
import { PLAN_LIKE_DAYS, productPaces, resolveReference, typeMedian, type LikeKind, type OverrideRow, type ProductPace } from "../lib/forecast-override-shared";
import { SCOPE_ONLINE } from "../lib/compute-shared";

export async function overridesFor(shop: string, productIds?: readonly string[]): Promise<Map<string, OverrideRow>> {
  const rows = await prisma.forecastOverride.findMany({
    where: { shop, ...(productIds ? { productId: { in: [...productIds] } } : {}) },
    select: { productId: true, noCap: true, likeKind: true, likeRef: true, likePct: true },
  });
  return new Map(
    rows.map((r) => [
      r.productId,
      { productId: r.productId, noCap: r.noCap === true, likeKind: r.likeKind === "product" || r.likeKind === "productType" ? r.likeKind : null, likeRef: r.likeRef ?? null, likePct: r.likePct ?? 100 },
    ]),
  );
}

async function upsert(shop: string, productId: string, data: Partial<Omit<OverrideRow, "productId">>): Promise<void> {
  await prisma.forecastOverride.upsert({
    where: { shop_productId: { shop, productId } },
    create: { shop, productId, noCap: false, likePct: 100, ...data },
    update: data,
  });
  // A row with nothing left in it is removed.
  await prisma.forecastOverride.deleteMany({ where: { shop, productId, noCap: false, likeKind: null } });
}

export async function setNoCap(shop: string, productId: string, value: boolean): Promise<void> {
  await upsert(shop, productId, { noCap: value });
}

export async function setPlanLike(shop: string, productId: string, like: { kind: LikeKind; ref: string; pct: number } | null): Promise<void> {
  await upsert(shop, productId, like ? { likeKind: like.kind, likeRef: like.ref, likePct: like.pct } : { likeKind: null, likeRef: null, likePct: 100 });
}

/**
 * Product-level sales paces from the last compute (VariantMetric.rate of the online pool, summed
 * per product), with each product's type and title — the reference of "Plan like…". Only
 * products whose variants had their own pace (enough in-stock days, not planned like another).
 */
export async function lastProductPaces(shop: string): Promise<Map<string, ProductPace>> {
  const [metrics, variants] = await Promise.all([
    prisma.variantMetric.findMany({ where: { shop, scope: SCOPE_ONLINE }, select: { variantId: true, rate: true, inputs: true } }),
    prisma.variant.findMany({ where: { shop, isBundle: false }, select: { id: true, productId: true, productTitle: true, productType: true } }),
  ]);
  return productPaces(metrics, variants);
}

export { PLAN_LIKE_DAYS };

export type ForecastChoice = {
  noCap: boolean;
  /** The "Plan like" reference as chosen (name: the product's title or the type); null = none. */
  like: { kind: LikeKind; ref: string; name: string; pct: number; rate: number | null } | null;
  /** Shown while the product has too few days in stock: the product type and its median pace (the suggestion). */
  offer: { productType: string | null; suggestion: { rate: number; products: number } | null } | null;
};

/** The product page's "Forecast settings" (R4). `inStockDays`: this variant's own, from its metric. */
export async function forecastChoiceFor(
  shop: string,
  product: { productId: string; productType: string | null },
  inStockDays: number | null,
): Promise<ForecastChoice> {
  const o = (await overridesFor(shop, [product.productId])).get(product.productId) ?? null;
  const young = inStockDays === null || inStockDays < PLAN_LIKE_DAYS;
  const needPaces = !!o?.likeKind || young;
  const paces = needPaces ? await lastProductPaces(shop) : new Map<string, ProductPace>();
  let like: ForecastChoice["like"] = null;
  if (o?.likeKind && o.likeRef) {
    const ref = resolveReference(o, paces);
    const title = o.likeKind === "product" ? (paces.get(o.likeRef)?.title ?? (await prisma.variant.findFirst({ where: { shop, productId: o.likeRef }, select: { productTitle: true } }))?.productTitle ?? null) : o.likeRef;
    like = { kind: o.likeKind, ref: o.likeRef, name: title ?? "—", pct: o.likePct, rate: ref?.rate ?? null };
  }
  const offer = young
    ? { productType: product.productType, suggestion: product.productType ? typeMedian(paces, product.productType, product.productId) : null }
    : null;
  return { noCap: o?.noCap === true, like, offer };
}

export type LikeCandidate = { productId: string; title: string; productType: string | null; rate: number };

/**
 * Products to plan like (R4): every word of `q` in the title, the product's own pace from the
 * last compute, at most 10, most sold first; never the product itself.
 */
export async function searchLikeProducts(shop: string, productId: string, q: string): Promise<LikeCandidate[]> {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const paces = await lastProductPaces(shop);
  return [...paces.values()]
    .filter((p) => p.productId !== productId && words.every((w) => p.title.toLowerCase().includes(w)))
    .sort((a, b) => b.rate - a.rate || (a.title < b.title ? -1 : 1))
    .slice(0, 10)
    .map((p) => ({ productId: p.productId, title: p.title, productType: p.productType, rate: p.rate }));
}

/** A "Plan like" reference exists in this shop: the product, or a product with that type. */
export async function likeTargetExists(shop: string, like: { kind: LikeKind; ref: string }): Promise<boolean> {
  const where = like.kind === "product" ? { shop, productId: like.ref, isBundle: false } : { shop, productType: like.ref, isBundle: false };
  return (await prisma.variant.count({ where, take: 1 })) > 0;
}

/** searchLikeProducts for a variant's product; null when the variant isn't this shop's. */
export async function searchLikeForVariant(shop: string, variantId: string, q: string): Promise<LikeCandidate[] | null> {
  const v = await prisma.variant.findFirst({ where: { shop, id: variantId }, select: { productId: true } });
  return v ? searchLikeProducts(shop, v.productId, q) : null;
}
