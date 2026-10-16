/**
 * Purchase order as PDF (spec §5.3, §9: pdfkit). A plain A4 document in the
 * given language: who it's for, dates, the lines and the totals, and the
 * supplier's confirm link. Unit costs are left out when the supplier sees no
 * prices.
 *
 * pdfkit's built-in Helvetica only covers Windows-1252 (Western European).
 * Text outside it (e.g. Polish ł, ą) is written without its accent rather
 * than as a broken glyph — `pdfSafe` below. Embedding a Unicode font would
 * need a font file in the repo; not done in v1.
 */
import PDFDocument from "pdfkit";
import { translate, fill, type Locale } from "../lib/i18n";
import type { PoLine } from "../lib/supplier-shared";
import { lineVariant, poTotals } from "../lib/purchase-order-shared";

export type PoPdfInput = {
  locale: Locale;
  storeName: string;
  number: string;
  supplierName: string | null;
  /** The day the order was sent, else created ("YYYY-MM-DD"). */
  orderDate: string;
  expectedDate: string | null;
  confirmedShipDate: string | null;
  currency: string | null;
  hidePrices: boolean;
  lines: PoLine[];
  confirmUrl: string | null;
};

// Windows-1252 characters above Latin-1's control block (0x80–0x9F).
const CP1252_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const SPECIAL: Record<string, string> = { ł: "l", Ł: "L", đ: "d", Đ: "D", ı: "i", " ": " ", " ": " ", " ": " " };

/** Text the standard PDF fonts can draw: Windows-1252 kept, other letters without their accent, the rest "?". */
export function pdfSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRA.has(ch)) out += ch;
    else if (ch === "\n" || ch === "\t") out += " ";
    else if (SPECIAL[ch]) out += SPECIAL[ch];
    else {
      const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      out += base && [...base].every((c) => c.codePointAt(0)! <= 0xff) ? base : "?";
    }
  }
  return out;
}

function money(v: number | null, currency: string | null, locale: Locale): string {
  if (v === null) return "—";
  try {
    return currency
      ? new Intl.NumberFormat(locale, { style: "currency", currency }).format(v)
      : new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  } catch {
    return v.toFixed(2);
  }
}

function day(d: string | null, locale: Locale): string {
  if (!d) return "—";
  try {
    return new Date(`${d}T12:00:00Z`).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  } catch {
    return d;
  }
}

/** Renders the PDF into a Buffer. */
export function renderPoPdf(input: PoPdfInput): Promise<Buffer> {
  const tr = (key: string) => translate(input.locale, key);
  const s = (t: string) => pdfSafe(t);
  const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `${input.number}`, Producer: "Keha Inventory Intelligence" } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  doc.font("Helvetica-Bold").fontSize(20).text(s(fill(tr("Purchase order {number}"), { number: input.number })), left);
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(11).fillColor("#444444").text(s(input.storeName));
  doc.moveDown(0.8);
  doc.fillColor("#000000").fontSize(10);
  const meta: [string, string][] = [
    [tr("Supplier"), input.supplierName || "—"],
    [tr("Order date"), day(input.orderDate, input.locale)],
  ];
  if (input.expectedDate) meta.push([tr("Expected arrival"), day(input.expectedDate, input.locale)]);
  if (input.confirmedShipDate) meta.push([tr("Ship date confirmed by the supplier"), day(input.confirmedShipDate, input.locale)]);
  for (const [k, v] of meta) {
    doc.font("Helvetica-Bold").text(s(`${k}: `), { continued: true }).font("Helvetica").text(s(v));
  }
  doc.moveDown(1);

  // Columns: SKU · Product · Qty · (Unit cost · Line total)
  const cols = input.hidePrices
    ? [
        { key: "sku", w: 0.22 },
        { key: "product", w: 0.63 },
        { key: "qty", w: 0.15, right: true },
      ]
    : [
        { key: "sku", w: 0.16 },
        { key: "product", w: 0.42 },
        { key: "qty", w: 0.1, right: true },
        { key: "unit", w: 0.15, right: true },
        { key: "total", w: 0.17, right: true },
      ];
  const label: Record<string, string> = {
    sku: tr("SKU"),
    product: tr("Product"),
    qty: tr("Quantity"),
    unit: tr("Unit cost"),
    total: tr("Line total"),
  };
  const row = (cells: Record<string, string>, bold: boolean) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    const heights = cols.map((c) => doc.heightOfString(s(cells[c.key] ?? ""), { width: c.w * width - 6 }));
    const h = Math.max(...heights) + 6;
    if (doc.y + h > bottom()) doc.addPage();
    const y = doc.y;
    let x = left;
    for (const c of cols) {
      doc.text(s(cells[c.key] ?? ""), x, y + 3, { width: c.w * width - 6, align: c.right ? "right" : "left" });
      x += c.w * width;
    }
    doc
      .moveTo(left, y + h)
      .lineTo(left + width, y + h)
      .strokeColor("#dddddd")
      .lineWidth(0.5)
      .stroke();
    doc.x = left;
    doc.y = y + h;
  };
  row(label, true);
  for (const l of input.lines) {
    const variant = lineVariant(l.variantTitle);
    row(
      {
        sku: l.sku ?? "—",
        product: variant ? `${l.productTitle} — ${variant}` : l.productTitle,
        qty: new Intl.NumberFormat(input.locale).format(l.qty),
        unit: money(l.unitCost, input.currency, input.locale),
        total: money(l.unitCost === null ? null : l.unitCost * l.qty, input.currency, input.locale),
      },
      false,
    );
  }
  const totals = poTotals(input.lines);
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(10);
  doc.text(s(fill(tr("Total units: {n}"), { n: new Intl.NumberFormat(input.locale).format(totals.units) })), left, doc.y, { width, align: "right" });
  if (!input.hidePrices) {
    doc.text(s(fill(tr("Total cost: {amount}"), { amount: money(totals.cost, input.currency, input.locale) })), left, doc.y, { width, align: "right" });
  }
  if (input.confirmUrl) {
    doc.moveDown(1.5);
    doc.font("Helvetica").fontSize(10).fillColor("#000000").text(s(tr("Please confirm the ship date here:")), left, doc.y, { width });
    doc.fillColor("#1a56db").text(input.confirmUrl, { width, link: input.confirmUrl, underline: true });
    doc.fillColor("#000000");
  }
  doc.end();
  return done;
}
