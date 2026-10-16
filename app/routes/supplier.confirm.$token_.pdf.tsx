/**
 * /supplier/confirm/:token/pdf — the order as PDF for the supplier (spec
 * §5.3: the email links here; the email service sends no attachments).
 * Same rules as the supplier page: public, rate-limited, only while the link
 * works, no prices when hidden; anything else is the same 404.
 */
import type { LoaderFunctionArgs } from "react-router";
import { allowConfirmRequest, lookupConfirm } from "../services/supplier-confirm.server";
import { documentFor } from "../services/po-document.server";
import { renderPoPdf } from "../services/po-pdf.server";
import { poFileName } from "../lib/purchase-order-shared";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const token = params.token ?? "";
  if (!allowConfirmRequest(request, token)) return new Response("Too many requests", { status: 429 });
  const found = await lookupConfirm(token);
  if (!found.ok) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const pdf = await renderPoPdf(await documentFor(found.shop, found.order));
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${poFileName(found.order.number, "pdf")}"`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
};
