/**
 * Size-grid purchase order (supplier module, Kanwar 2026-10-17). Pure, client-safe; used by the PO
 * PDF (services/po-pdf.server) and the grid CSV (/app/reorder/:id/csv?layout=grid).
 *
 * Fashion suppliers read an order as one row per style (and colour) with the sizes as columns. The
 * lines of one product are grouped; each variant title ("Black / M") is split on " / " and the
 * option position whose values all look like sizes (XS … 5XL, one size, numbers such as 36 or
 * 8.5, waist/leg such as 32/34, "EU 38") is the size dimension. Shopify's option names aren't kept
 * in Keha, so sizes are recognised by their values. The other options (the colour) name the row.
 * A product without a size dimension, a product with more than MAX_SIZE_COLUMNS sizes, or a
 * single-variant product goes to the flat list below the grid (one line per variant, as before).
 *
 * Each row has the supplier's article / style code when known: the product's own supplier code
 * (product page → Ordering), else the common prefix of its variants' SKUs (cut at a separator,
 * at least 3 characters). Totals per row (units, and money when prices are shown) and per size
 * column. Only supplier-safe line fields are read (lib/purchase-order-shared SupplierLine).
 */
import { toCsv } from "./products-shared";
import { lineVariant, type SupplierLine } from "./purchase-order-shared";

type T = (s: string) => string;

/** More sizes than this in one product: its lines go to the flat list (the grid would not fit a page). */
export const MAX_SIZE_COLUMNS = 14;
/** Longest supplier code accepted. */
export const SUPPLIER_CODE_MAX = 64;
const SKU_PREFIX_MIN = 3;

/** A supplier-safe line with the product's grouping and code (no ids). */
export type GridLine = SupplierLine & {
  /** Opaque grouping key for the product (the document's own counter, never a Shopify id). */
  group: string;
  /** The product's supplier code (Variant.supplierCode); null = none set. */
  supplierCode?: string | null;
};

export type GridRow = {
  styleCode: string | null;
  productTitle: string;
  /** The other options (colour …); "" when the size is the only option. */
  label: string;
  /** Units per size column ("" columns this row doesn't have are 0). */
  qty: number[];
  units: number;
  /** Σ qty × unit cost (prices shown); null when hidden or a cost is missing. */
  cost: number | null;
};

export type GridBlock = {
  /** The size columns, in size order. */
  sizes: string[];
  rows: GridRow[];
  /** Units per size column, and in total. */
  columnTotals: number[];
  units: number;
  cost: number | null;
};

export type PoGrid = {
  /** One block per distinct size run (products sharing the same sizes share a block). */
  blocks: GridBlock[];
  /** Lines without a size dimension (one per variant, in order). */
  flat: (SupplierLine & { styleCode: string | null })[];
  units: number;
};

/** A supplier code typed on the product page: trimmed, printable, at most 64 characters; empty = none. */
export function readSupplierCode(raw: unknown): { ok: true; code: string | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, code: null };
  if (typeof raw !== "string") return { ok: false };
  const code = raw.trim().replace(/\s+/g, " ");
  if (!code) return { ok: true, code: null };
  // eslint-disable-next-line no-control-regex
  if (code.length > SUPPLIER_CODE_MAX || /[\u0000-\u001f\u007f]/.test(code)) return { ok: false };
  return { ok: true, code };
}

const LETTER = ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL", "5XL", "6XL"];
const LETTER_ALIAS: Record<string, string> = { "2XS": "XXS", "3XS": "XXXS", "2XL": "XXL", "3XL": "XXXL", XXXXL: "4XL", XXXXXL: "5XL" };
const ONE_SIZE = /^(one size|onesize|os|o\/s|unique|única|unica|taille unique|einheitsgröße|einheitsgrosse|tu|uni)$/i;

const letterRank = (v: string): number | null => {
  const u = v.toUpperCase().replace(/\s+/g, "");
  const k = LETTER_ALIAS[u] ?? u;
  const i = LETTER.indexOf(k);
  return i >= 0 ? i : null;
};

/** A number size: 36, 8.5, 10½, "EU 38", "US 8", 32/34 (waist/leg), 0–3M / 3-6M (baby). Returns its sort keys. */
function numberSize(v: string): number[] | null {
  const s = v.trim().replace(/½/g, ".5").replace(",", ".");
  const m = /^(?:(?:eu|us|uk|fr|it|de|jp|cn|size|talla|taille|größe|maat|rozmiar)\s*)?(\d{1,3}(?:\.\d)?)(?:\s*(?:\/|x)\s*(\d{1,3}))?(?:\s*(?:m|y|yrs?|months?|años|ans|jahre))?$/i.exec(s);
  if (m) return [Number(m[1]), m[2] ? Number(m[2]) : 0];
  const range = /^(\d{1,2})\s*-\s*(\d{1,2})\s*(m|y|months?|yrs?)?$/i.exec(s);
  if (range) return [Number(range[1]) + (/y/i.test(range[3] ?? "") ? 100 : 0), Number(range[2])];
  return null;
}

/** Does this option value look like a size? */
export function isSizeValue(v: string): boolean {
  const s = v.trim();
  if (!s) return false;
  return letterRank(s) !== null || ONE_SIZE.test(s) || numberSize(s) !== null;
}

/** Size order: one size, letter sizes XXS → 5XL, then numbers ascending; unknown last (as given). */
export function compareSizes(a: string, b: string): number {
  const key = (v: string): [number, number, number] => {
    if (ONE_SIZE.test(v.trim())) return [0, 0, 0];
    const l = letterRank(v);
    if (l !== null) return [1, l, 0];
    const n = numberSize(v);
    if (n) return [2, n[0]!, n[1]!];
    return [3, 0, 0];
  };
  const x = key(a);
  const y = key(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || 0;
}

/** Options of a variant title ("Black / M" → ["Black", "M"]; "Default Title" → []). */
export const optionsOf = (variantTitle: string): string[] => {
  const v = lineVariant(variantTitle);
  return v ? v.split(" / ").map((x) => x.trim()) : [];
};

/**
 * The size option's position for one product's variant titles: the position where every variant
 * has a size-like value, more than one distinct value, and (with several such positions) the one
 * with the most distinct values; null = no size dimension.
 */
export function sizePosition(titles: readonly string[]): number | null {
  const opts = titles.map(optionsOf);
  const n = opts[0]?.length ?? 0;
  if (!n || opts.some((o) => o.length !== n)) return null;
  let best: { i: number; distinct: number } | null = null;
  for (let i = 0; i < n; i++) {
    const values = opts.map((o) => o[i]!);
    if (!values.every(isSizeValue)) continue;
    const distinct = new Set(values.map((v) => v.toUpperCase())).size;
    if (distinct < 2) continue;
    if (!best || distinct > best.distinct) best = { i, distinct };
  }
  return best ? best.i : null;
}

/** The common SKU prefix of a product's variants, cut at the last separator; null when shorter than 3 characters or any SKU is missing. */
export function skuPrefix(skus: readonly (string | null | undefined)[]): string | null {
  const list = skus.map((s) => (s ?? "").trim());
  if (!list.length || list.some((s) => !s)) return null;
  if (list.length === 1) return null;
  let p = list[0]!;
  for (const s of list) while (!s.startsWith(p)) p = p.slice(0, -1);
  if (list.every((s) => s === p)) return p.length >= SKU_PREFIX_MIN ? p : null;
  const cut = Math.max(p.lastIndexOf("-"), p.lastIndexOf("_"), p.lastIndexOf("/"), p.lastIndexOf("."), p.lastIndexOf(" "));
  const prefix = (cut >= 0 ? p.slice(0, cut) : p).trim();
  return prefix.length >= SKU_PREFIX_MIN ? prefix : null;
}

const money2 = (n: number) => Math.round(n * 100) / 100;

/** The order as size-grid blocks plus the flat lines that have no size dimension (see the module header). */
export function buildPoGrid(lines: readonly GridLine[], hidePrices: boolean): PoGrid {
  const groups = new Map<string, GridLine[]>();
  for (const l of lines) (groups.get(l.group) ?? groups.set(l.group, []).get(l.group)!).push(l);
  const blocks = new Map<string, GridBlock>();
  const flat: PoGrid["flat"] = [];
  for (const list of groups.values()) {
    const code = list.find((l) => l.supplierCode)?.supplierCode ?? skuPrefix(list.map((l) => l.sku));
    const pos = list.length > 1 ? sizePosition(list.map((l) => l.variantTitle)) : null;
    const sizes = pos === null ? [] : [...new Set(list.map((l) => optionsOf(l.variantTitle)[pos]!))].sort(compareSizes);
    if (pos === null || sizes.length > MAX_SIZE_COLUMNS) {
      for (const l of list) flat.push({ ...stripGrid(l), styleCode: code });
      continue;
    }
    const sizeKey = sizes.join("|");
    const block = blocks.get(sizeKey) ?? { sizes, rows: [], columnTotals: sizes.map(() => 0), units: 0, cost: hidePrices ? null : 0 };
    blocks.set(sizeKey, block);
    const rows = new Map<string, GridRow & { missing: boolean }>();
    for (const l of list) {
      const o = optionsOf(l.variantTitle);
      const label = o.filter((_, i) => i !== pos).join(" / ");
      const row = rows.get(label) ?? { styleCode: code, productTitle: l.productTitle, label, qty: sizes.map(() => 0), units: 0, cost: hidePrices ? null : 0, missing: false };
      rows.set(label, row);
      const col = sizes.indexOf(o[pos]!);
      row.qty[col]! += l.qty;
      row.units += l.qty;
      if (!hidePrices) {
        if (l.unitCost === null || l.unitCost === undefined) row.missing = true;
        else row.cost = money2((row.cost ?? 0) + l.unitCost * l.qty);
      }
    }
    for (const r of rows.values()) {
      const { missing, ...row } = r;
      if (missing) row.cost = null;
      block.rows.push(row);
      row.qty.forEach((q, i) => (block.columnTotals[i]! += q));
      block.units += row.units;
      if (block.cost !== null) block.cost = row.cost === null ? null : money2(block.cost + row.cost);
    }
  }
  const out = [...blocks.values()];
  return { blocks: out, flat, units: out.reduce((a, b) => a + b.units, 0) + flat.reduce((a, l) => a + l.qty, 0) };
}

function stripGrid(l: GridLine): SupplierLine {
  const out: SupplierLine = { productTitle: l.productTitle, variantTitle: l.variantTitle, sku: l.sku, qty: l.qty };
  if ("unitCost" in l) out.unitCost = l.unitCost;
  return out;
}

/**
 * The order as a size-grid CSV: per block a header (Style code, Product, Variant — the other
 * options, the sizes, Total units, and Line total when prices are shown), its rows, then a Totals row; then the
 * flat lines with the usual columns. Headers in the given language.
 */
export function poGridCsv(grid: PoGrid, t: T, opts: { hidePrices: boolean; currency: string | null }): string {
  const parts: string[] = [];
  const flatHeader = () => {
    const header = [t("Style code"), t("SKU"), t("Product"), t("Variant"), t("Quantity")];
    if (!opts.hidePrices) header.push(t("Unit cost"), t("Line total"), t("Currency"));
    return header;
  };
  if (!grid.blocks.length && !grid.flat.length) return toCsv(flatHeader(), []);
  for (const b of grid.blocks) {
    const header = [t("Style code"), t("Product"), t("Variant"), ...b.sizes, t("Total units")];
    if (!opts.hidePrices) header.push(t("Line total"), t("Currency"));
    const rows: (string | number | null)[][] = b.rows.map((r) => {
      const row: (string | number | null)[] = [r.styleCode, r.productTitle, r.label, ...r.qty.map((q) => (q > 0 ? q : null)), r.units];
      if (!opts.hidePrices) row.push(r.cost, opts.currency);
      return row;
    });
    const total: (string | number | null)[] = [t("Totals"), null, null, ...b.columnTotals, b.units];
    if (!opts.hidePrices) total.push(b.cost, opts.currency);
    rows.push(total);
    parts.push(toCsv(header, rows));
  }
  if (grid.flat.length) {
    const header = flatHeader();
    const rows = grid.flat.map((l) => {
      const row: (string | number | null)[] = [l.styleCode, l.sku, l.productTitle, lineVariant(l.variantTitle), l.qty];
      if (!opts.hidePrices) row.push(l.unitCost ?? null, l.unitCost == null ? null : money2(l.unitCost * l.qty), opts.currency);
      return row;
    });
    parts.push(toCsv(header, rows));
  }
  // One byte-order mark at the start; a blank line between the blocks.
  return parts.map((p, i) => (i ? p.replace(/^\uFEFF/, "") : p)).join("\r\n");
}
