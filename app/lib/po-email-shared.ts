/**
 * The purchase-order email to a supplier (spec §5.3 "Email supplier"), in the
 * store's language. The email service sends text + HTML only (no
 * attachments), so the email carries the lines and a link to the supplier
 * page, where the supplier confirms the ship date and downloads the PDF.
 * Pure: `tr` translates into the store language.
 */
import { fill } from "./i18n";
import { lineVariant, supplierTotals, type SupplierLine } from "./purchase-order-shared";

type T = (s: string) => string;

export type SupplierEmailInput = {
  storeName: string;
  supplierName: string | null;
  number: string;
  /** Supplier-safe lines (purchase-order-shared supplierLines). */
  lines: readonly SupplierLine[];
  currency: string | null;
  hidePrices: boolean;
  confirmUrl: string;
  locale: string;
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

export function supplierEmail(input: SupplierEmailInput, tr: T): { subject: string; text: string; html: string } {
  const subject = fill(tr("Purchase order {number} from {store}"), { number: input.number, store: input.storeName });
  const greeting = input.supplierName ? fill(tr("Hello {name},"), { name: input.supplierName }) : tr("Hello,");
  const intro = fill(tr("{store} would like to order the items below."), { store: input.storeName });
  const ask = tr("Please confirm the ship date with the link below. You can also download the order as a PDF there.");
  const totals = supplierTotals(input.lines, input.hidePrices);
  const num = (n: number) => new Intl.NumberFormat(input.locale).format(n);
  const lineText = (l: SupplierLine) => {
    const name = [l.productTitle, lineVariant(l.variantTitle)].filter(Boolean).join(" — ");
    const sku = l.sku ? ` (${tr("SKU")} ${l.sku})` : "";
    const price = input.hidePrices ? "" : ` · ${money(l.unitCost ?? null, input.currency, input.locale)}`;
    return `${num(l.qty)} × ${name}${sku}${price}`;
  };
  const totalLine = input.hidePrices
    ? fill(tr("Total units: {n}"), { n: num(totals.units) })
    : `${fill(tr("Total units: {n}"), { n: num(totals.units) })} · ${fill(tr("Total cost: {amount}"), {
        amount: money(totals.cost ?? null, input.currency, input.locale),
      })}`;
  const text = [
    greeting,
    "",
    intro,
    "",
    ...input.lines.map((l) => `- ${lineText(l)}`),
    "",
    totalLine,
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
<p>${esc(ask)}</p>
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
