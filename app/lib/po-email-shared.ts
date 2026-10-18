/**
 * The purchase-order email to a supplier (spec §5.3 "Email supplier"), in the
 * supplier's PO language (Settings → Suppliers; English by default — merchant
 * audit 2026-10-18), with the order's details (buyer, ship-to, payment terms,
 * Incoterms, dates, note: lib/po-document-shared poDetailRows). The email service sends text + HTML only (no
 * attachments), so the email carries the lines and a link to the supplier
 * page, where the supplier confirms the ship date and downloads the PDF.
 * Pure: `tr` translates into the PO language.
 */
import { fill } from "./i18n";
import { lineVariant, supplierTotals, type SupplierLine } from "./purchase-order-shared";
import { formatDay } from "./dashboard-shared";
import { detailText, type PoDetailRow } from "./po-document-shared";

type T = (s: string) => string;

export type SupplierEmailInput = {
  storeName: string;
  supplierName: string | null;
  number: string;
  /** Supplier-safe lines (purchase-order-shared supplierLines). */
  lines: readonly SupplierLine[];
  /** The currency the lines' prices are in (the supplier's when converted). */
  currency: string | null;
  hidePrices: boolean;
  confirmUrl: string;
  locale: string;
  /** The ship date the supplier confirmed ("YYYY-MM-DD"), if any. */
  shipDate?: string | null;
  /** Expected arrival: ship date + transit days, else the lead-time estimate. */
  arrival?: string | null;
  /** Buyer, ship-to, terms, Incoterms, dates and note (poDetailRows); when given they replace the ship / arrival line. */
  details?: readonly PoDetailRow[];
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function money(v: number | null, currency: string | null, locale: string): string {
  if (v === null) return "—";
  try {
    return currency ? new Intl.NumberFormat(locale, { style: "currency", currency }).format(v) : v.toFixed(2);
  } catch {
    return v.toFixed(2);
  }
}

/** "12 × Product — Variant (SKU X) · €3.00": one supplier line as text (the email and "Open in your email"). */
export function supplierLineText(l: SupplierLine, input: Pick<SupplierEmailInput, "hidePrices" | "currency" | "locale">, tr: T): string {
  const num = (n: number) => new Intl.NumberFormat(input.locale).format(n);
  const name = [l.productTitle, lineVariant(l.variantTitle)].filter(Boolean).join(" — ");
  const sku = l.sku ? ` (${tr("SKU")} ${l.sku})` : "";
  const price = input.hidePrices ? "" : ` · ${money(l.unitCost ?? null, input.currency, input.locale)}`;
  return `${num(l.qty)} × ${name}${sku}${price}`;
}

/** "Total units: 40 · Total cost: €120.00" (no cost when the supplier sees no prices). */
export function supplierTotalText(input: Pick<SupplierEmailInput, "lines" | "hidePrices" | "currency" | "locale">, tr: T): string {
  const totals = supplierTotals(input.lines, input.hidePrices);
  const num = (n: number) => new Intl.NumberFormat(input.locale).format(n);
  const units = fill(tr("Total units: {n}"), { n: num(totals.units) });
  return input.hidePrices ? units : `${units} · ${fill(tr("Total cost: {amount}"), { amount: money(totals.cost ?? null, input.currency, input.locale) })}`;
}

export function supplierEmail(input: SupplierEmailInput, tr: T): { subject: string; text: string; html: string } {
  const subject = fill(tr("Purchase order {number} from {store}"), { number: input.number, store: input.storeName });
  const greeting = input.supplierName ? fill(tr("Hello {name},"), { name: input.supplierName }) : tr("Hello,");
  const intro = fill(tr("{store} would like to order the items below."), { store: input.storeName });
  const ask = tr("Please confirm the ship date with the link below. You can also download the order as a PDF there.");
  const lineText = (l: SupplierLine) => supplierLineText(l, input, tr);
  const totalLine = supplierTotalText(input, tr);
  const dates = input.details
    ? input.details.map(detailText).join("\n")
    : [
        input.shipDate ? fill(tr("Ship date: {date}"), { date: formatDay(input.shipDate, input.locale) }) : "",
        input.arrival ? fill(tr("Expected arrival: ~{date}"), { date: formatDay(input.arrival, input.locale) }) : "",
      ]
        .filter(Boolean)
        .join(" · ");
  const text = [
    greeting,
    "",
    intro,
    "",
    ...input.lines.map((l) => `- ${lineText(l)}`),
    "",
    totalLine,
    ...(dates ? [dates] : []),
    "",
    ask,
    input.confirmUrl,
    "",
    tr("Reply to this email to reach the store."),
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.5">
<p>${esc(greeting)}</p>
<p>${esc(intro)}</p>
<ul>${input.lines.map((l) => `<li>${esc(lineText(l))}</li>`).join("")}</ul>
<p><strong>${esc(totalLine)}</strong></p>
${dates ? `<p>${dates.split("\n").map(esc).join("<br>")}</p>\n` : ""}<p>${esc(ask)}</p>
<p><a href="${esc(input.confirmUrl)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${esc(
    tr("Confirm the ship date"),
  )}</a></p>
<p style="color:#616161;font-size:13px">${esc(tr("Reply to this email to reach the store."))}</p>
</body></html>`;
  return { subject, text, html };
}

/**
 * Abuse limits for "Email supplier" (review fix 2026-10-17): the email goes
 * out from Keha's sending domain to an address the merchant typed, so a
 * merchant account must not be able to use it as a mail cannon.
 *  - one email per order per 10 minutes (OwnerEmailLog kind "supplier_po",
 *    periodKey "order:<id>", sentAt = the last send);
 *  - 50 supplier emails per store per UTC day (kind "supplier_po_day", one
 *    row per send, periodKey "<YYYY-MM-DD>#<n>" — the unique
 *    (shop, kind, periodKey) index makes each slot claimable once).
 */
export const SUPPLIER_EMAIL_KIND = "supplier_po";
export const SUPPLIER_EMAIL_DAY_KIND = "supplier_po_day";
export const SUPPLIER_EMAIL_COOLDOWN_MS = 10 * 60 * 1000;
export const SUPPLIER_EMAIL_DAILY_CAP = 50;
export const supplierEmailOrderKey = (orderId: string) => `order:${orderId}`;
export const supplierEmailDayPrefix = (now: Date) => `${now.toISOString().slice(0, 10)}#`;

/** The public supplier page for an order. */
export function confirmUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/supplier/confirm/${encodeURIComponent(token)}`;
}
