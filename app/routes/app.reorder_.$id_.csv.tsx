/**
 * Purchase order CSV (/app/reorder/:id/csv) — spec §5.3, Growth (`poExport`).
 * Headers in the supplier's PO language (English by default); no unit costs
 * when the supplier sees no prices. Above the table: buyer, ship-to, payment
 * terms, Incoterms, ship / arrival dates (YYYY-MM-DD) and the note. Free gets the upgrade JSON (403). One line per variant; with
 * `?layout=grid` the size grid (lib/po-grid-shared: one row per style and
 * colour, sizes as columns, style code, totals). Never freight & duty.
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticateApp } from "../services/data-scope.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { poCsvFile, poDocument } from "../services/po-document.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  if (!features.poExport) return upgradeResponse("poExport", "Purchase order downloads are on the Growth plan.");
  const doc = await poDocument(shop, params.id ?? "");
  if (!doc) throw new Response("Not found", { status: 404 });
  const { csv, fileName } = poCsvFile(doc.pdf, new URL(request.url).searchParams.get("layout") === "grid");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
};
