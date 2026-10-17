/**
 * Purchase order PDF (/app/reorder/:id/pdf) — spec §5.3, Growth (`poExport`).
 * In the store's language (it goes to the supplier); unit costs left out when
 * the supplier sees no prices. Free gets the upgrade JSON (403).
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticateApp } from "../services/data-scope.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { poDocument } from "../services/po-document.server";
import { poFileName } from "../lib/purchase-order-shared";
import { renderPoPdf } from "../services/po-pdf.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  if (!features.poExport) return upgradeResponse("poExport", "Purchase order downloads are on the Growth plan.");
  const doc = await poDocument(shop, params.id ?? "");
  if (!doc) throw new Response("Not found", { status: 404 });
  const pdf = await renderPoPdf(doc.pdf);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${poFileName(doc.pdf.number, "pdf")}"`,
      "Cache-Control": "no-store",
    },
  });
};
