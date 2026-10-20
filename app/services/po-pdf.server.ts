/**
 * Purchase order as PDF (spec §5.3, §9: pdfkit). A plain A4 document in the
 * given language: who it's for, dates, the lines and the totals, and the
 * supplier's confirm link. Unit costs are left out when the supplier sees no
 * prices. Lines are shown as a size grid (lib/po-grid-shared: one row per style
 * and colour, sizes as columns, the supplier's style code, totals per row and
 * column); products without sizes as a flat list. Freight & duty (landed cost)
 * is never on it: only the order's own line costs.
 *
 * Fonts: Liberation Sans (SIL OFL 1.1, app/assets/fonts) is embedded so every language prints —
 * Polish ł, ą, ż included (post-approval backlog C4). If the font files can't be read, pdfkit's
 * built-in Helvetica is used and text outside Windows-1252 is written without its accent rather
 * than as a broken glyph (`pdfSafe` below).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { translate, fill, type Locale } from "../lib/i18n";
import { lineVariant, supplierTotals, type SupplierLine } from "../lib/purchase-order-shared";
import { buildPoGrid, type GridLine } from "../lib/po-grid-shared";
import { poDetailRows, type PoDetails } from "../lib/po-document-shared";

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
  /** Supplier-safe lines (lib/purchase-order-shared supplierLines): no unit cost when prices are hidden. */
  lines: SupplierLine[];
  /** The same lines with their product grouping and supplier code (size grid); absent = a flat list. */
  gridLines?: GridLine[];
  confirmUrl: string | null;
  /** Buyer, ship-to, payment terms, Incoterms, ship / arrival dates and the note (lib/po-document-shared). Absent = dates only. */
  details?: PoDetails;
};

// Windows-1252 characters above Latin-1's control block (0x80–0x9F).
const CP1252_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const SPECIAL: Record<string, string> = { ł: "l", Ł: "L", đ: "d", Đ: "D", ı: "i", " ": " ", " ": " ", " ": " " };

type PdfFonts = { regular: string; bold: string; unicode: boolean; files?: { regular: Buffer; bold: Buffer } };
let fontCache: PdfFonts | null = null;

/** The embedded Unicode font when its files are there (the Docker image copies the repo), else Helvetica. */
export function pdfFonts(dir: string = join(process.cwd(), "app", "assets", "fonts")): PdfFonts {
  if (fontCache && dir === join(process.cwd(), "app", "assets", "fonts")) return fontCache;
  let out: PdfFonts;
  try {
    out = {
      regular: "Keha-Regular",
      bold: "Keha-Bold",
      unicode: true,
      files: { regular: readFileSync(join(dir, "LiberationSans-Regular.ttf")), bold: readFileSync(join(dir, "LiberationSans-Bold.ttf")) },
    };
  } catch (e) {
    console.error("[po-pdf] embedded font missing, using Helvetica", e);
    out = { regular: "Helvetica", bold: "Helvetica-Bold", unicode: false };
  }
  if (dir === join(process.cwd(), "app", "assets", "fonts")) fontCache = out;
  return out;
}

/** With the embedded font: any text, control characters as spaces. */
const unicodeSafe = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, " ");

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
export function renderPoPdf(input: PoPdfInput, fonts: PdfFonts = pdfFonts()): Promise<Buffer> {
  const tr = (key: string) => translate(input.locale, key);
  const s = (t: string) => (fonts.unicode ? unicodeSafe(t) : pdfSafe(t));
  const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `${input.number}`, Producer: "Keha Inventory Planner" } });
  if (fonts.files) {
    doc.registerFont(fonts.regular, fonts.files.regular);
    doc.registerFont(fonts.bold, fonts.files.bold);
  }
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  doc.font(fonts.bold).fontSize(20).text(s(fill(tr("Purchase order {number}"), { number: input.number })), left);
  doc.moveDown(0.3);
  doc.font(fonts.regular).fontSize(11).fillColor("#444444").text(s(input.storeName));
  doc.moveDown(0.8);
  doc.fillColor("#000000").fontSize(10);
  const meta: [string, string][] = [
    [tr("Supplier"), input.supplierName || "—"],
    [tr("Order date"), day(input.orderDate, input.locale)],
  ];
  if (!input.details) {
    if (input.expectedDate) meta.push([tr("Expected arrival"), day(input.expectedDate, input.locale)]);
    if (input.confirmedShipDate) meta.push([tr("Ship date confirmed by the supplier"), day(input.confirmedShipDate, input.locale)]);
  }
  for (const [k, v] of meta) {
    doc.font(fonts.bold).text(s(`${k}: `), { continued: true }).font(fonts.regular).text(s(v));
  }
  // Buyer, ship-to, terms, Incoterms, dates, note — the same rows as the CSV and the email.
  for (const r of input.details ? poDetailRows(input.details, tr, (d) => day(d, input.locale)) : []) {
    if (r.lines.length === 1) {
      doc.font(fonts.bold).text(s(`${r.label}: `), { continued: true }).font(fonts.regular).text(s(r.lines[0]!));
    } else {
      doc.moveDown(0.3).font(fonts.bold).text(s(r.label));
      for (const l of r.lines) doc.font(fonts.regular).text(s(l));
    }
  }
  doc.moveDown(1);

  type Col = { key: string; w: number; right?: boolean };
  const row = (cols: readonly Col[], cells: Record<string, string>, bold: boolean, size = 9) => {
    doc.font(bold ? fonts.bold : fonts.regular).fontSize(size);
    const heights = cols.map((c) => doc.heightOfString(s(cells[c.key] ?? ""), { width: c.w * width - 4 }));
    const h = Math.max(...heights) + 6;
    if (doc.y + h > bottom()) doc.addPage();
    const y = doc.y;
    let x = left;
    for (const c of cols) {
      doc.text(s(cells[c.key] ?? ""), x, y + 3, { width: c.w * width - 4, align: c.right ? "right" : "left" });
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
  const count = (n: number) => new Intl.NumberFormat(input.locale).format(n);

  // Size grid (supplier module): one row per style and colour, the sizes as columns, totals per row
  // and column. Products without a size dimension stay in the flat list below.
  const grid = input.gridLines?.length ? buildPoGrid(input.gridLines, input.hidePrices) : null;
  const flatLines = grid ? grid.flat : input.lines;
  for (const b of grid?.blocks ?? []) {
    const fixed = input.hidePrices ? 0.12 + 0.3 + 0.08 : 0.11 + 0.22 + 0.07 + 0.12;
    const sizeW = (1 - fixed) / b.sizes.length;
    const cols: Col[] = [
      { key: "code", w: input.hidePrices ? 0.12 : 0.11 },
      { key: "product", w: input.hidePrices ? 0.3 : 0.22 },
      ...b.sizes.map((_, i) => ({ key: `s${i}`, w: sizeW, right: true })),
      { key: "units", w: input.hidePrices ? 0.08 : 0.07, right: true },
      ...(input.hidePrices ? [] : [{ key: "total", w: 0.12, right: true }]),
    ];
    const fontSize = b.sizes.length > 10 ? 7 : 8;
    row(cols, { code: tr("Style code"), product: tr("Product"), ...Object.fromEntries(b.sizes.map((z, i) => [`s${i}`, z])), units: tr("Total units"), total: tr("Line total") }, true, fontSize);
    for (const r of b.rows) {
      row(
        cols,
        {
          code: r.styleCode ?? "—",
          product: r.label ? `${r.productTitle} — ${r.label}` : r.productTitle,
          ...Object.fromEntries(r.qty.map((q, i) => [`s${i}`, q > 0 ? count(q) : ""])),
          units: count(r.units),
          total: money(r.cost, input.currency, input.locale),
        },
        false,
        fontSize,
      );
    }
    row(cols, { code: tr("Totals"), ...Object.fromEntries(b.columnTotals.map((q, i) => [`s${i}`, count(q)])), units: count(b.units), total: money(b.cost, input.currency, input.locale) }, true, fontSize);
    doc.moveDown(1);
  }

  // Columns: SKU · Product · Qty · (Unit cost · Line total)
  const cols: Col[] = input.hidePrices
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
  if (flatLines.length) row(cols, label, true);
  for (const l of flatLines) {
    const variant = lineVariant(l.variantTitle);
    row(
      cols,
      {
        sku: l.sku ?? "—",
        product: variant ? `${l.productTitle} — ${variant}` : l.productTitle,
        qty: count(l.qty),
        unit: money(l.unitCost ?? null, input.currency, input.locale),
        total: money(l.unitCost == null ? null : l.unitCost * l.qty, input.currency, input.locale),
      },
      false,
    );
  }
  const totals = supplierTotals(input.lines, input.hidePrices);
  doc.moveDown(0.8);
  doc.font(fonts.bold).fontSize(10);
  doc.text(s(fill(tr("Total units: {n}"), { n: new Intl.NumberFormat(input.locale).format(totals.units) })), left, doc.y, { width, align: "right" });
  if (!input.hidePrices) {
    doc.text(s(fill(tr("Total cost: {amount}"), { amount: money(totals.cost ?? null, input.currency, input.locale) })), left, doc.y, { width, align: "right" });
  }
  if (input.confirmUrl) {
    doc.moveDown(1.5);
    doc.font(fonts.regular).fontSize(10).fillColor("#000000").text(s(tr("Please confirm the ship date here:")), left, doc.y, { width });
    doc.fillColor("#1a56db").text(input.confirmUrl, { width, link: input.confirmUrl, underline: true });
    doc.fillColor("#000000");
  }
  doc.end();
  return done;
}
