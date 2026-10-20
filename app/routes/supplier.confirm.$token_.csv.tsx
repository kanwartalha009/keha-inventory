/**
 * /supplier/confirm/:token/csv — the order as CSV for the supplier (owner decision 2026-10-18: the
 * "Open in your email" message says the PDF and CSV can be downloaded from the order link). Same
 * rules as the supplier page and its PDF: public, rate-limited (per address and per token), only
 * while the link works, in the supplier's PO language, no prices when hidden; anything else is the
 * same 404. `?layout=grid` = the size grid, like the merchant's download.
 */
import type { LoaderFunctionArgs } from "react-router";
import { allowConfirmRequest, lookupConfirm } from "../services/supplier-confirm.server";
import { documentFor, poCsvFile, poCsvLayout } from "../services/po-document.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const token = params.token ?? "";
  if (!allowConfirmRequest(request, token)) return new Response("Too many requests", { status: 429 });
  const found = await lookupConfirm(token);
  if (!found.ok) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const { csv, fileName } = poCsvFile(await documentFor(found.shop, found.order), poCsvLayout(new URL(request.url).searchParams.get("layout")));
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
};
