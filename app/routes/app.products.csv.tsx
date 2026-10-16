/**
 * CSV export of the Products table (/app/products/csv) — spec §5.2, Growth
 * (`csvExport`). Same filters as the table, every matching row, headers in
 * the admin language (`lang`). Free gets the upgrade JSON (403).
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { allProducts } from "../models/products.server";
import { toSupportedLocale, translate } from "../lib/i18n";
import { parseFilters, productsCsv } from "../lib/products-shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.csvExport) return upgradeResponse("csvExport", "CSV export is on the Growth plan.");
  const url = new URL(request.url);
  const locale = toSupportedLocale(url.searchParams.get("lang"));
  const rows = await allProducts(session.shop, parseFilters(url.searchParams), features.forecast);
  const csv = productsCsv(rows, (s) => translate(locale, s), features.forecast);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="products.csv"',
      "Cache-Control": "no-store",
    },
  });
};
