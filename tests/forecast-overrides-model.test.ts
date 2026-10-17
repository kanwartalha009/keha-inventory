/**
 * models/forecast-overrides (R4): "Don't cap" and "Plan like…" rows, the product page's choice
 * and the like-search — against an in-memory Prisma. Our database only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ forecastOverride: ["shop", "productId"] });
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { forecastChoiceFor, likeTargetExists, overridesFor, searchLikeForVariant, setNoCap, setPlanLike } from "../app/models/forecast-overrides.server";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const P = (n: number) => `gid://shopify/Product/${n}`;
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;

beforeEach(() => {
  db.reset();
  db.tables.forecastOverride = [];
  db.tables.variant = [
    { id: V(11), shop: S, productId: P(1), productTitle: "Parka classic", productType: "Jackets", isBundle: false },
    { id: V(21), shop: S, productId: P(2), productTitle: "Bomber", productType: "Jackets", isBundle: false },
    { id: V(31), shop: S, productId: P(3), productTitle: "New parka", productType: "Jackets", isBundle: false },
    { id: V(41), shop: S, productId: P(4), productTitle: "Gift box", productType: "Sets", isBundle: true },
  ];
  db.tables.variantMetric = [
    { shop: S, variantId: V(11), scope: "online", rate: 4, inputs: { enoughData: true } },
    { shop: S, variantId: V(21), scope: "online", rate: 2, inputs: { enoughData: true } },
    { shop: S, variantId: V(31), scope: "online", rate: 1, inputs: { enoughData: false, inStockDays: 5 } },
  ];
});

describe("forecast overrides", () => {
  it("one row per product; a row with nothing left in it is removed", async () => {
    await setNoCap(S, P(1), true);
    expect(await overridesFor(S)).toEqual(new Map([[P(1), { productId: P(1), noCap: true, likeKind: null, likeRef: null, likePct: 100 }]]));
    await setPlanLike(S, P(1), { kind: "productType", ref: "Jackets", pct: 80 });
    expect((await overridesFor(S, [P(1)])).get(P(1))).toMatchObject({ noCap: true, likeKind: "productType", likeRef: "Jackets", likePct: 80 });
    await setNoCap(S, P(1), false);
    expect(db.tables.forecastOverride).toHaveLength(1);
    await setPlanLike(S, P(1), null);
    expect(db.tables.forecastOverride).toEqual([]);
  });

  it("the product page: a young product gets the offer with its type's median (without itself); a chosen product its name and pace", async () => {
    const offer = await forecastChoiceFor(S, { productId: P(3), productType: "Jackets" }, 5);
    expect(offer).toEqual({ noCap: false, like: null, offer: { productType: "Jackets", suggestion: { rate: 3, products: 2 } } });
    // 28+ days in stock: no offer.
    expect((await forecastChoiceFor(S, { productId: P(1), productType: "Jackets" }, 60)).offer).toBeNull();
    await setPlanLike(S, P(3), { kind: "product", ref: P(1), pct: 50 });
    expect((await forecastChoiceFor(S, { productId: P(3), productType: "Jackets" }, 5)).like).toEqual({ kind: "product", ref: P(1), name: "Parka classic", pct: 50, rate: 2 });
  });

  it("search: every word in the title, not itself, own pace only, most sold first; the reference must exist (no bundles)", async () => {
    expect((await searchLikeForVariant(S, V(31), "parka"))!.map((p) => p.title)).toEqual(["Parka classic"]);
    expect((await searchLikeForVariant(S, V(31), ""))!.map((p) => p.title)).toEqual(["Parka classic", "Bomber"]);
    expect(await searchLikeForVariant(S, V(99), "x")).toBeNull();
    expect(await likeTargetExists(S, { kind: "product", ref: P(2) })).toBe(true);
    expect(await likeTargetExists(S, { kind: "product", ref: P(4) })).toBe(false);
    expect(await likeTargetExists(S, { kind: "productType", ref: "Jackets" })).toBe(true);
    expect(await likeTargetExists(S, { kind: "productType", ref: "Sets" })).toBe(false);
  });
});
