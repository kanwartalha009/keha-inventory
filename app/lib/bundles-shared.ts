/**
 * Bundles: a bundle's sales count on its components (R4 forecast quality). Pure.
 *
 * A bundle variant (requiresComponents) holds no stock of its own: selling one takes `quantity`
 * units of each component from stock. Keha never plans the bundle itself (isBundle), so without
 * this the components' demand would miss every unit sold inside a bundle.
 *
 *  - The components come from ProductVariant.productVariantComponents (read_products; catalog
 *    sync), stored as Variant.bundleComponents [{ variantId, quantity }].
 *  - Component demand on a day = its own units sold + Σ over the bundles that contain it of
 *    bundle units sold that day × quantity, in the same SalesDaily view as its own demand.
 *  - Shopify's sales reports attribute a bundle sale to the bundle line, not to the components
 *    (ASSUMED from Shopify's bundle reporting docs; not measured on a store with bundles). If a
 *    store's bundle has no sales rows of its own, nothing is added, so no unit is counted twice.
 */

export type BundleComponent = { variantId: string; quantity: number };

/** Most components kept per bundle (the sync reads productVariantComponents(first: 30); Shopify's limit is 30). */
export const MAX_BUNDLE_COMPONENTS = 30;
const MAX_QTY = 10_000;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

/**
 * Validated components: ProductVariant ids, whole quantities 1…10,000, never the bundle itself;
 * the same component twice is merged. Anything else (or not an array) → [].
 */
export function readBundleComponents(raw: unknown, bundleId?: string): BundleComponent[] {
  if (!Array.isArray(raw)) return [];
  const qty = new Map<string, number>();
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const id = typeof r.variantId === "string" ? r.variantId : null;
    const q = typeof r.quantity === "number" ? r.quantity : NaN;
    if (!id || !VARIANT_GID.test(id) || id === bundleId || !Number.isInteger(q) || q < 1 || q > MAX_QTY) continue;
    qty.set(id, Math.min(MAX_QTY, (qty.get(id) ?? 0) + q));
  }
  return [...qty].slice(0, MAX_BUNDLE_COMPONENTS).map(([variantId, quantity]) => ({ variantId, quantity }));
}

/**
 * The `nodes(ids:)` answer of BUNDLE_COMPONENTS_QUERY → bundle id → its components. A node that
 * isn't a variant (null, deleted) is left out, so its stored components stay as they were.
 */
export function bundleComponentsFromNodes(nodes: unknown): Map<string, BundleComponent[]> {
  const out = new Map<string, BundleComponent[]>();
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const r = n as { id?: unknown; productVariantComponents?: { nodes?: unknown } | null };
    if (typeof r.id !== "string" || !VARIANT_GID.test(r.id)) continue;
    const list = Array.isArray(r.productVariantComponents?.nodes) ? (r.productVariantComponents!.nodes as unknown[]) : [];
    const flat = list.map((c) => {
      const x = (c ?? {}) as { quantity?: unknown; productVariant?: { id?: unknown } | null };
      return { variantId: x.productVariant?.id, quantity: x.quantity };
    });
    out.set(r.id, readBundleComponents(flat, r.id));
  }
  return out;
}

/** component variant id → the bundles that contain it, with the units each bundle takes. */
export function componentBundles(bundles: readonly { id: string; bundleComponents: unknown }[]): Map<string, { bundleId: string; quantity: number }[]> {
  const out = new Map<string, { bundleId: string; quantity: number }[]>();
  for (const b of bundles) {
    for (const c of readBundleComponents(b.bundleComponents, b.id)) {
      const list = out.get(c.variantId) ?? [];
      list.push({ bundleId: b.id, quantity: c.quantity });
      out.set(c.variantId, list);
    }
  }
  return out;
}

/** The bundles any of `variantIds` is part of (to read their sales). */
export function bundlesOf(map: ReadonlyMap<string, { bundleId: string; quantity: number }[]>, variantIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of variantIds) for (const b of map.get(id) ?? []) out.add(b.bundleId);
  return [...out];
}

/**
 * Component sales rows from bundle sales: for each component in `variantIds`, one row per bundle
 * sales day, units = bundle units × quantity. Added to the component's own rows (buildSeries sums
 * rows of the same day). Negative bundle days (returns over sales) add nothing.
 */
export function bundleSalesForComponents<T extends { variantId: string; day: string; sold: number }>(
  map: ReadonlyMap<string, { bundleId: string; quantity: number }[]>,
  bundleSales: readonly T[],
  variantIds: readonly string[],
): { variantId: string; day: string; sold: number; gross: number }[] {
  const byBundle = new Map<string, T[]>();
  for (const s of bundleSales) {
    const list = byBundle.get(s.variantId) ?? [];
    list.push(s);
    byBundle.set(s.variantId, list);
  }
  const out: { variantId: string; day: string; sold: number; gross: number }[] = [];
  for (const id of variantIds) {
    for (const b of map.get(id) ?? []) {
      for (const s of byBundle.get(b.bundleId) ?? []) {
        if (s.sold > 0) out.push({ variantId: id, day: s.day, sold: s.sold * b.quantity, gross: 0 });
      }
    }
  }
  return out;
}
