/**
 * Supplier order builder · "Add products" (/app/reorder/build/products?supplier=<key>&q=…), a
 * resource route read with a fetcher (no page, no revalidation of the builder's plan). The
 * supplier's own products matching every word of `q` (models/supplier-order.server), at most 25.
 * Growth (`reorderPlan`); below it nothing is sent.
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getEntitlements } from "../services/entitlements.server";
import { searchSupplierProducts } from "../models/supplier-order.server";
import type { AddableProduct } from "../lib/supplier-order-shared";

export type BuilderProductsData = { ok: true; products: AddableProduct[] } | { ok: false };

export const loader = async ({ request }: LoaderFunctionArgs): Promise<BuilderProductsData> => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.reorderPlan) return { ok: false };
  const url = new URL(request.url);
  const key = url.searchParams.get("supplier") ?? "";
  if (!/^(supplier|vendor):/.test(key) || key.length > 300) return { ok: false };
  const q = (url.searchParams.get("q") ?? "").slice(0, 200);
  return { ok: true, products: await searchSupplierProducts(session.shop, key, q) };
};
