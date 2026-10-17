/**
 * Product page · "Plan like…" search (/app/products/:variantId/like?q=…), a resource route read
 * with a fetcher (R4 forecast quality). Products whose title has every word of `q`, with their
 * own sales pace from the last compute (models/forecast-overrides), at most 10; never the
 * product itself. Read only.
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticateApp } from "../services/data-scope.server";
import { searchLikeForVariant, type LikeCandidate } from "../models/forecast-overrides.server";
import { variantGid } from "../lib/products-shared";

export type LikeSearchData = { ok: true; products: LikeCandidate[] } | { ok: false };

export const loader = async ({ request, params }: LoaderFunctionArgs): Promise<LikeSearchData> => {
  const { shop } = await authenticateApp(request);
  const gid = variantGid(params.variantId ?? "");
  if (!gid) return { ok: false };
  const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 200);
  const products = await searchLikeForVariant(shop, gid, q);
  return products ? { ok: true, products } : { ok: false };
};
