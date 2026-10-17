/**
 * Purchase order CSV (/app/reorder/:id/csv) — spec §5.3, Growth (`poExport`).
 * Headers in the store's language; no unit costs when the supplier sees no
 * prices. Free gets the upgrade JSON (403). One line per variant; with
 * `?layout=grid` the size grid (lib/po-grid-shared: one row per style and
 * colour, sizes as columns, style code, totals). Never freight & duty.
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticateApp } from "../services/data-scope.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { poDocument } from "../services/po-document.server";
import { translate } from "../lib/i18n";
import { poCsv, poFileName } from "../lib/purchase-order-shared";
import { buildPoGrid, poGridCsv } from "../lib/po-grid-shared";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  if (!features.poExport) return upgradeResponse("poExport", "Purchase order downloads are on the Growth plan.");
  const doc = await poDocument(shop, params.id ?? "");
  if (!doc) throw new Response("Not found", { status: 404 });
  const { pdf } = doc;
  const tr = (s: string) => translate(pdf.locale, s);
  const grid = new URL(request.url).searchParams.get("layout") === "grid";
  const csv = grid
    ? poGridCsv(buildPoGrid(pdf.gridLines ?? pdf.lines.map((l, i) => ({ ...l, group: `l${i}` })), pdf.hidePrices), tr, { hidePrices: pdf.hidePrices, currency: pdf.currency })
    : poCsv(pdf.lines, tr, { hidePrices: pdf.hidePrices, currency: pdf.currency });
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${poFileName(grid ? `${pdf.number}-grid` : pdf.number, "csv")}"`,
      "Cache-Control": "no-store",
    },
  });
};
