/**
 * The Import & export templates with the current values (Settings → Import & export, Growth
 * `csvImport`): /app/settings/import/suppliers.csv and /app/settings/import/product-settings.csv.
 * The product settings file is streamed page by page (one row per variant). Free gets the
 * upgrade JSON (403).
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { exportProductsStream, exportSuppliersCsv } from "../models/setup-import.server";

const HEADERS = (name: string) => ({
  "Content-Type": "text/csv; charset=utf-8",
  "Content-Disposition": `attachment; filename="${name}"`,
  "Cache-Control": "no-store",
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.csvImport) return upgradeResponse("csvImport", "CSV import is on the Growth plan.");
  switch (params.file) {
    case "suppliers.csv":
      return new Response(await exportSuppliersCsv(session.shop), { headers: HEADERS("suppliers.csv") });
    case "product-settings.csv":
      return new Response(exportProductsStream(session.shop), { headers: HEADERS("product-settings.csv") });
    default:
      throw new Response("Not found", { status: 404 });
  }
};
