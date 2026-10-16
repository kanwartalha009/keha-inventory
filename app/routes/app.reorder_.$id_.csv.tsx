/**
 * Purchase order CSV (/app/reorder/:id/csv) — spec §5.3, Growth (`poExport`).
 * Headers in the store's language; no unit costs when the supplier sees no
 * prices. Free gets the upgrade JSON (403).
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { poDocument } from "../services/po-document.server";
import { translate } from "../lib/i18n";
import { poCsv, poFileName } from "../lib/purchase-order-shared";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.poExport) return upgradeResponse("poExport", "Purchase order downloads are on the Growth plan.");
  const doc = await poDocument(session.shop, params.id ?? "");
  if (!doc) throw new Response("Not found", { status: 404 });
  const { pdf } = doc;
  const csv = poCsv(pdf.lines, (s) => translate(pdf.locale, s), { hidePrices: pdf.hidePrices, currency: pdf.currency });
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${poFileName(pdf.number, "csv")}"`,
      "Cache-Control": "no-store",
    },
  });
};
