/**
 * R4 pure parts: "Plan like…" references (forecast-override-shared) and bundles counted on their
 * components (bundles-shared).
 */
import { describe, expect, it } from "vitest";
import { clampPct, parsePlanLike, productPaces, resolveReference, typeMedian, variantShares, type ProductPace } from "../app/lib/forecast-override-shared";
import { bundleComponentsFromNodes, bundleSalesForComponents, bundlesOf, componentBundles, readBundleComponents } from "../app/lib/bundles-shared";

const P = (n: number) => `gid://shopify/Product/${n}`;
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;

describe("Plan like: product paces, the type median, the reference", () => {
  const variants = [
    { id: V(11), productId: P(1), productTitle: "Parka", productType: "Jackets" },
    { id: V(12), productId: P(1), productTitle: "Parka", productType: "Jackets" },
    { id: V(21), productId: P(2), productTitle: "Bomber", productType: "Jackets" },
    { id: V(31), productId: P(3), productTitle: "Rain shell", productType: "Jackets" },
    { id: V(41), productId: P(4), productTitle: "New coat", productType: "Jackets" },
    { id: V(51), productId: P(5), productTitle: "Tee", productType: "Shirts" },
  ];
  const metrics = [
    { variantId: V(11), rate: 2, inputs: { enoughData: true } },
    { variantId: V(12), rate: 1, inputs: { enoughData: true } },
    { variantId: V(21), rate: 5, inputs: { enoughData: true } },
    // Its pace comes from older in-stock days: still its own.
    { variantId: V(31), rate: 1, inputs: { enoughData: false, pace: { from: "2026-05-01", inStockDays: 28 } } },
    // Planned like another product: not a reference (no borrowed paces chained).
    { variantId: V(41), rate: 4, inputs: { enoughData: false, planLike: { name: "Parka" } } },
    // Too few days, no pace: not a reference.
    { variantId: V(51), rate: 9, inputs: { enoughData: false } },
    { variantId: V(99), rate: 9, inputs: { enoughData: true } }, // not in the catalogue
  ];
  const paces = productPaces(metrics, variants);

  it("sums each product's own variant paces; skips borrowed, unmeasured and unknown ones", () => {
    expect([...paces.keys()].sort()).toEqual([P(1), P(2), P(3)]);
    expect(paces.get(P(1))).toEqual({ productId: P(1), title: "Parka", productType: "Jackets", rate: 3 });
  });

  it("type median over the type's other products (even count: the middle two); none → null", () => {
    expect(typeMedian(paces, "Jackets")).toEqual({ rate: 3, products: 3 });
    expect(typeMedian(paces, "Jackets", P(2))).toEqual({ rate: 2, products: 2 });
    expect(typeMedian(paces, "Shirts")).toBeNull();
  });

  it("the reference: a product × pct, or the type median × pct; itself, a gone product or an empty type → null", () => {
    expect(resolveReference({ productId: P(4), likeKind: "product", likeRef: P(2), likePct: 80 }, paces)).toEqual({ kind: "product", ref: P(2), name: "Bomber", pct: 80, rate: 4 });
    expect(resolveReference({ productId: P(4), likeKind: "productType", likeRef: "Jackets", likePct: 100 }, paces)).toEqual({ kind: "productType", ref: "Jackets", name: "Jackets", pct: 100, rate: 3, products: 3 });
    expect(resolveReference({ productId: P(2), likeKind: "product", likeRef: P(2), likePct: 100 }, paces)).toBeNull();
    expect(resolveReference({ productId: P(4), likeKind: "product", likeRef: P(77), likePct: 100 }, paces)).toBeNull();
    expect(resolveReference({ productId: P(4), likeKind: "productType", likeRef: "Shirts", likePct: 100 }, paces)).toBeNull();
    expect(resolveReference({ productId: P(4), likeKind: null, likeRef: null, likePct: 100 }, paces)).toBeNull();
    expect(resolveReference(null, new Map<string, ProductPace>())).toBeNull();
  });

  it("percent clamped 10…500; variant shares by units so far, else equal", () => {
    expect([clampPct(5), clampPct(80.4), clampPct(900), clampPct("x")]).toEqual([10, 80, 500, 100]);
    expect(variantShares(new Map([[V(1), 3], [V(2), 1]]), [V(1), V(2)])).toEqual(new Map([[V(1), 0.75], [V(2), 0.25]]));
    expect(variantShares(new Map(), [V(1), V(2)])).toEqual(new Map([[V(1), 0.5], [V(2), 0.5]]));
    expect(variantShares(new Map(), [])).toEqual(new Map());
  });

  it("parsePlanLike: a product gid (not itself) or a type, a whole percent 10…500", () => {
    expect(parsePlanLike({ kind: "product", ref: P(2), pct: 80 }, P(4))).toEqual({ kind: "product", ref: P(2), pct: 80 });
    expect(parsePlanLike({ kind: "productType", ref: " Jackets ", pct: 100 }, P(4))).toEqual({ kind: "productType", ref: "Jackets", pct: 100 });
    for (const bad of [
      { kind: "product", ref: P(4), pct: 100 },
      { kind: "product", ref: "Parka", pct: 100 },
      { kind: "collection", ref: "x", pct: 100 },
      { kind: "productType", ref: "", pct: 100 },
      { kind: "productType", ref: "Jackets", pct: 9 },
      { kind: "productType", ref: "Jackets", pct: 50.5 },
      { kind: "productType", ref: "x".repeat(301), pct: 100 },
    ]) expect(parsePlanLike(bad, P(4))).toBeNull();
  });
});

describe("Bundles: sales count on the components", () => {
  it("reads components defensively: variant gids, whole quantities 1…10,000, not itself, duplicates merged", () => {
    expect(
      readBundleComponents(
        [
          { variantId: V(1), quantity: 2 },
          { variantId: V(1), quantity: 1 },
          { variantId: V(2), quantity: 0 },
          { variantId: "x", quantity: 1 },
          { variantId: V(9), quantity: 1 },
          { variantId: V(3), quantity: 1.5 },
          null,
        ],
        V(9),
      ),
    ).toEqual([{ variantId: V(1), quantity: 3 }]);
    expect(readBundleComponents("nope")).toEqual([]);
  });

  it("the nodes answer → bundle → components; a missing node keeps what was stored (not in the map)", () => {
    const m = bundleComponentsFromNodes([
      { id: V(9), productVariantComponents: { nodes: [{ quantity: 2, productVariant: { id: V(1) } }, { quantity: 1, productVariant: { id: V(2) } }] } },
      null,
      { id: V(8), productVariantComponents: null },
    ]);
    expect(m).toEqual(
      new Map([
        [V(9), [{ variantId: V(1), quantity: 2 }, { variantId: V(2), quantity: 1 }]],
        [V(8), []],
      ]),
    );
    expect(bundleComponentsFromNodes(undefined)).toEqual(new Map());
  });

  it("component demand = own + bundle units × quantity per day; only for the components asked for", () => {
    const map = componentBundles([
      { id: V(9), bundleComponents: [{ variantId: V(1), quantity: 2 }, { variantId: V(2), quantity: 1 }] },
      { id: V(8), bundleComponents: [{ variantId: V(1), quantity: 1 }] },
      { id: V(7), bundleComponents: null },
    ]);
    expect(bundlesOf(map, [V(1)]).sort()).toEqual([V(8), V(9)]);
    expect(bundlesOf(map, [V(3)])).toEqual([]);
    const sales = [
      { variantId: V(9), day: "2026-10-01", sold: 3 },
      { variantId: V(8), day: "2026-10-01", sold: 1 },
      { variantId: V(9), day: "2026-10-02", sold: -1 }, // returns over sales: adds nothing
    ];
    expect(bundleSalesForComponents(map, sales, [V(1)])).toEqual([
      { variantId: V(1), day: "2026-10-01", sold: 6, gross: 0 },
      { variantId: V(1), day: "2026-10-01", sold: 1, gross: 0 },
    ]);
    expect(bundleSalesForComponents(map, sales, [V(2)])).toEqual([{ variantId: V(2), day: "2026-10-01", sold: 3, gross: 0 }]);
  });
});
