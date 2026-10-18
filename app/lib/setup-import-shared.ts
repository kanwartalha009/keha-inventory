/**
 * Settings → Import & export (owner 2026-10-17, "setup at scale"): CSV export of the current
 * values and CSV import with a validation preview, for
 *   - suppliers: one row per supplier, matched by name (new names are added, suppliers missing
 *     from the file stay as they are, nothing is deleted);
 *   - product settings: one row per variant (or per product), matched by variant_id, sku or
 *     handle (a handle row sets every variant of the product) — supplier, case pack, Don't reorder.
 * Pure and client-safe: the server (models/setup-import.server) reads the store's rows, calls the
 * planners here and writes the plan only when the merchant confirms. Nothing is saved by a preview.
 *
 * Column registry. Every column is one entry in SUPPLIER_COLUMNS / PRODUCT_COLUMNS: its header in
 * the file (English snake_case, the same in every admin language so a file round-trips), its
 * translated label and hint for the column reference, how the current value is exported and how
 * a cell is read. A new supplier or product field (payment terms, landed cost, the supplier's
 * article code) is one more entry here — the parser, preview, diff, export and reference table
 * pick it up.
 *
 * Rules: a column left out of the file keeps its values; an empty cell clears the value (the
 * template is exported with the current values, so editing it changes only what was edited).
 * Rows with a problem are skipped and listed with their line and column; the other rows import.
 * Importing the same file twice changes nothing the second time.
 */
import { fill } from "./i18n";
import {
  SUPPLIER_BOUNDS,
  newSupplierForm,
  supplierToForm,
  validateSupplierForm,
  type SupplierErrorCode,
  type SupplierForm,
  type SupplierInput,
} from "./suppliers-shared";
import { readMinOrderScope } from "./supplier-shared";
import { isBalanceDue } from "./cash-shared";
import { readSupplierCode } from "./po-grid-shared";
import { parsePoLanguage } from "./po-document-shared";

type T = (s: string) => string;

export const IMPORT_ENTITIES = ["suppliers", "products"] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];
export function isImportEntity(v: unknown): v is ImportEntity {
  return v === "suppliers" || v === "products";
}

/** Data rows per file (the header not counted) and file size. */
export const MAX_IMPORT_ROWS = 50_000;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
/** Rows listed per section of the preview (changes, problems, not found); the counts are always complete. */
export const PREVIEW_LIST_MAX = 100;
/** Case pack per product: as on the product page. */
export const CASE_PACK_MAX = 10_000;

// ── CSV reading ────────────────────────────────────────────────────────────────

export type CsvRecord = { line: number; cells: string[] };

/** "," / ";" (European spreadsheets) / tab, from the header line (quotes respected). */
export function detectDelimiter(text: string): "," | ";" | "\t" {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && (c === "," || c === ";" || c === "\t")) counts[c]++;
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) return "\t";
  return ",";
}

/**
 * RFC 4180 records, one at a time (a generator: a 50,000-row file is never split into an array of
 * lines first). UTF-8 BOM dropped; CRLF, LF or CR line ends; quoted cells with doubled quotes and
 * line breaks. `line` is the file line the record starts on (the header is line 1).
 */
export function* readCsv(text: string, delimiter: string = detectDelimiter(text)): Generator<CsvRecord> {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const start = line;
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    let ended = false;
    while (i < n) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          quoted = false;
          i++;
          continue;
        }
        if (c === "\n") line++;
        cell += c;
        i++;
        continue;
      }
      if (c === '"' && cell.trim() === "") {
        quoted = true;
        cell = "";
        i++;
        continue;
      }
      if (c === delimiter) {
        cells.push(cell);
        cell = "";
        i++;
        continue;
      }
      if (c === "\r" || c === "\n") {
        i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
        line++;
        ended = true;
        break;
      }
      cell += c;
      i++;
    }
    cells.push(cell);
    if (!ended && i >= n && cells.length === 1 && cells[0] === "") break; // trailing newline
    yield { line: start, cells };
  }
}

/**
 * A cell as typed: trimmed, and the apostrophe our own exports put before a cell that starts with
 * = + - @ (spreadsheet formula guard) taken off again, so an exported file imports unchanged.
 */
export function cleanCell(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
}

const normHeader = (h: string) =>
  cleanCell(h)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

// ── CSV writing (same rules as the Products export) ─────────────────────────────

function csvCell(v: string): string {
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: string[]) => cells.map(csvCell).join(",");
/** The UTF-8 BOM Excel needs to read the file as UTF-8. */
export const CSV_BOM = "﻿";

// ── Column registry ────────────────────────────────────────────────────────────

export type ColumnRole = "key" | "info" | "value";

export type ImportColumn = {
  /** Header in the file (English snake_case, every language). */
  header: string;
  /** Other spellings accepted on import. */
  aliases?: string[];
  role: ColumnRole;
  /** English label / hint / example for the column reference (go through t()). */
  label: string;
  hint: string;
  example: string;
};

/** What a cell can be wrong with (file-level problems are FileError). */
export type IssueCode =
  | "missingKey"
  | "missingName"
  | "notFound"
  | "ambiguousSku"
  | "duplicate"
  | "unknownSupplier"
  | "range"
  | "yesNo"
  | "scope"
  | "paymentTerms"
  | "language"
  | "codeLong"
  | "supplier";

export type ImportIssue = {
  line: number;
  /** The file header of the column, null for the whole row. */
  column: string | null;
  code: IssueCode;
  /** The cell as typed (shown back). */
  value?: string;
  /** ambiguousSku: variants with that SKU · duplicate: the earlier line. */
  n?: number;
  /** code "supplier": the supplier form's own error (suppliers-shared). */
  supplierCode?: SupplierErrorCode;
  /** code "range": bounds. */
  min?: number;
  max?: number;
};

type Read<V> = { ok: true; value: V } | { ok: false; issue: Omit<ImportIssue, "line" | "column" | "value"> };

const YES = new Set(["yes", "y", "true", "1", "x"]);
const NO = new Set(["no", "n", "false", "0", ""]);
export function readYesNo(cell: string): boolean | null {
  const c = cell.trim().toLowerCase();
  return YES.has(c) ? true : NO.has(c) ? false : null;
}
const yesNo = (b: boolean) => (b ? "yes" : "no");

// ---- Suppliers ----

export type SupplierColumn = ImportColumn & {
  /** The SupplierForm field this column fills (errors from validateSupplierForm map back to it). */
  field: keyof SupplierForm;
  /** Current value, as the file shows it. */
  export: (f: SupplierForm) => string;
  /** Put the cell into the form (null = fine). */
  apply: (f: SupplierForm, cell: string) => Omit<ImportIssue, "line" | "column" | "value"> | null;
};

const textField = (
  field:
    | "name"
    | "email"
    | "leadTimeDays"
    | "minOrder"
    | "minOrderTotal"
    | "casePack"
    | "transitDays"
    | "orderCycleDays"
    | "minOrderValue"
    | "exchangeRate"
    | "currency"
    | "depositPercent"
    | "balanceDays"
    | "landedCostPercent"
    | "incoterms",
) => ({
  field,
  export: (f: SupplierForm) => String(f[field] ?? ""),
  apply: (f: SupplierForm, cell: string) => {
    f[field] = cell;
    return null;
  },
});

/** Vendors in one cell, separated by "|" (commas and semicolons are the file's own separators). */
export const VENDOR_SEPARATOR = "|";

export const SUPPLIER_COLUMNS: SupplierColumn[] = [
  { header: "name", aliases: ["supplier", "supplier_name"], role: "key", label: "Supplier name", hint: "Matches an existing supplier (not case-sensitive); a new name adds a supplier.", example: "Acme Textiles", ...textField("name") },
  { header: "email", aliases: ["emails", "supplier_email"], role: "value", label: "Email", hint: "Where purchase orders go. Stored encrypted.", example: "orders@acme.example", ...textField("email") },
  { header: "lead_time_days", aliases: ["lead_time"], role: "value", label: "Lead time (days)", hint: "From placing the order to stock arriving. Required.", example: "30", ...textField("leadTimeDays") },
  { header: "transit_days", aliases: ["transit"], role: "value", label: "Transit time (days)", hint: "The shipping part of the lead time (sea or air freight).", example: "21", ...textField("transitDays") },
  { header: "order_every_days", aliases: ["order_cycle_days"], role: "value", label: "Order enough for (days)", hint: "Days of stock each order should last after it arrives. Empty = your store's setting.", example: "30", ...textField("orderCycleDays") },
  { header: "min_per_item", aliases: ["moq"], role: "value", label: "Minimum per item", hint: "Minimum units per line.", example: "10", ...textField("minOrder") },
  {
    header: "min_per_item_applies_to",
    aliases: ["moq_scope"],
    role: "value",
    label: "Minimum applies to",
    hint: "variant (each size or color) or product (each style, split across its sizes).",
    example: "variant",
    field: "minOrderScope",
    export: (f) => f.minOrderScope,
    apply: (f, cell) => {
      const c = cell.trim().toLowerCase();
      if (c === "") f.minOrderScope = "variant";
      else if (c === "variant" || c === "product") f.minOrderScope = readMinOrderScope(c);
      else return { code: "scope" };
      return null;
    },
  },
  { header: "min_order_units", aliases: ["min_order_total"], role: "value", label: "Minimum order (units)", hint: "Minimum total units for the whole order.", example: "200", ...textField("minOrderTotal") },
  { header: "min_order_value", role: "value", label: "Minimum order (value)", hint: "Minimum order value in the supplier's currency.", example: "1500", ...textField("minOrderValue") },
  { header: "case_pack", aliases: ["case_size"], role: "value", label: "Case pack", hint: "Units per case for this supplier's products (a product's own case pack wins).", example: "6", ...textField("casePack") },
  { header: "currency", role: "value", label: "Currency", hint: "3-letter code the supplier bills in. Empty = your store's currency.", example: "USD", ...textField("currency") },
  { header: "exchange_rate", role: "value", label: "Exchange rate", hint: "1 unit of the supplier's currency in your store's currency.", example: "0.92", ...textField("exchangeRate") },
  {
    header: "vendors",
    aliases: ["vendor_match"],
    role: "value",
    label: "Vendors",
    hint: "Products of these Shopify vendors go to this supplier. Separate several with |.",
    example: "Acme|Acme Kids",
    field: "vendorMatch",
    export: (f) => f.vendorMatch.join(VENDOR_SEPARATOR),
    apply: (f, cell) => {
      f.vendorMatch = cell
        .split(VENDOR_SEPARATOR)
        .map((v) => v.trim())
        .filter(Boolean);
      return null;
    },
  },
  {
    header: "hide_prices",
    role: "value",
    label: "Hide prices",
    hint: "yes = no unit costs on the supplier's confirmation page.",
    example: "no",
    field: "hidePrices",
    export: (f) => yesNo(f.hidePrices),
    apply: (f, cell) => {
      const b = readYesNo(cell);
      if (b === null) return { code: "yesNo" };
      f.hidePrices = b;
      return null;
    },
  },
  // Payment terms and freight & duty (Settings → Suppliers → More options, R3).
  {
    header: "payment_terms",
    aliases: ["balance_due"],
    role: "value",
    label: "Payment terms",
    hint: "When the rest is paid: order (everything when you order), ship, arrival or after_arrival.",
    example: "arrival",
    field: "balanceDue",
    export: (f) => f.balanceDue,
    apply: (f, cell) => {
      const c = cell.trim().toLowerCase();
      if (c === "" || c === "order") f.balanceDue = "order";
      else if (isBalanceDue(c)) f.balanceDue = c;
      else return { code: "paymentTerms" };
      return null;
    },
  },
  { header: "deposit_percent", aliases: ["deposit"], role: "value", label: "Deposit", hint: "Paid when you place the order, in % of the goods. Use 0 for no deposit.", example: "30", ...textField("depositPercent") },
  { header: "rest_days_after_arrival", aliases: ["balance_days"], role: "value", label: "Rest paid after arrival", hint: "Days after the stock arrives.", example: "30", ...textField("balanceDays") },
  {
    header: "freight_duty_percent",
    aliases: ["landed_cost_percent", "freight_duty"],
    role: "value",
    label: "Freight & duty",
    hint: "Shipping and import duty in % of the goods cost, paid on arrival. In your costs and cash, never on the purchase order to the supplier.",
    example: "12",
    ...textField("landedCostPercent"),
  },
  // Purchase-order documents (merchant audit 2026-10-18).
  {
    header: "po_language",
    aliases: ["order_language", "language"],
    role: "value",
    label: "Purchase order language",
    hint: "en, es, fr, de, it, pt, nl or pl. Empty = English.",
    example: "en",
    field: "poLanguage",
    export: (f) => f.poLanguage,
    apply: (f, cell) => {
      const l = parsePoLanguage(cell);
      if (!l) return { code: "language" };
      f.poLanguage = l;
      return null;
    },
  },
  { header: "incoterms", aliases: ["delivery_terms"], role: "value", label: "Delivery terms (Incoterms)", hint: "Optional, on the order: an Incoterm and the place, e.g. FOB Ningbo.", example: "FOB Ningbo", ...textField("incoterms") },
];

// ---- Product settings ----

/** One variant as the importer reads it (models/setup-import.server). */
export type ImportVariant = {
  id: string;
  productId: string;
  sku: string | null;
  handle: string;
  productTitle: string;
  variantTitle: string;
  vendor: string | null;
  supplierId: string | null;
  caseQty: number | null;
  noReorder: boolean;
  /** The supplier's article / style number (product page → Supplier code; purchase orders). */
  supplierCode: string | null;
};

/** What a product import may change on a variant (our database only — never the store). */
export type VariantPatch = { supplierId?: string | null; caseQty?: number | null; noReorder?: boolean; supplierCode?: string | null };
export type VariantPatchField = keyof VariantPatch;

export type ProductCtx = {
  /** lower-cased name → supplier. */
  suppliersByName: Map<string, { id: string; name: string }>;
  supplierName: Map<string, string>;
};

export type ProductColumn = ImportColumn & {
  /** Value columns: the Variant field they set. */
  field?: VariantPatchField;
  export: (v: ImportVariant, ctx: ProductCtx) => string;
  /** Value columns: the cell → the field's value. */
  read?: (cell: string, ctx: ProductCtx) => Read<VariantPatch[VariantPatchField]>;
  /** Value columns: a value as the preview shows it. */
  show?: (value: VariantPatch[VariantPatchField], ctx: ProductCtx) => string;
};

/** "gid://shopify/ProductVariant/123" ↔ "123". */
export const numericId = (gid: string) => gid.replace(/^gid:\/\/shopify\/\w+\//, "");
export const variantGid = (raw: string) => (/^\d+$/.test(raw) ? `gid://shopify/ProductVariant/${raw}` : raw);

export const PRODUCT_COLUMNS: ProductColumn[] = [
  { header: "variant_id", aliases: ["variant", "id"], role: "key", label: "Variant ID", hint: "Shopify's variant ID — the most exact match.", example: "44123456789012", export: (v) => numericId(v.id) },
  { header: "sku", role: "key", label: "SKU", hint: "Used when there is no variant ID. A SKU shared by several variants can't be used.", example: "TEE-BLK-M", export: (v) => v.sku ?? "" },
  { header: "handle", aliases: ["product_handle"], role: "key", label: "Product handle", hint: "Used when there is no variant ID or SKU: the row sets every variant of the product.", example: "linen-shirt", export: (v) => v.handle },
  { header: "product", aliases: ["product_title", "title"], role: "info", label: "Product", hint: "For reading only; not imported.", example: "Linen shirt", export: (v) => v.productTitle },
  { header: "variant_title", aliases: ["option"], role: "info", label: "Variant", hint: "For reading only; not imported.", example: "Black / M", export: (v) => v.variantTitle },
  { header: "vendor", role: "info", label: "Vendor", hint: "For reading only. To assign by vendor, use the vendors column of the suppliers file.", example: "Acme", export: (v) => v.vendor ?? "" },
  {
    header: "supplier",
    aliases: ["supplier_name"],
    role: "value",
    label: "Supplier",
    hint: "A supplier's name from Settings → Suppliers. Empty = matched by vendor again.",
    example: "Acme Textiles",
    field: "supplierId",
    export: (v, ctx) => (v.supplierId ? (ctx.supplierName.get(v.supplierId) ?? "") : ""),
    read: (cell, ctx) => {
      if (!cell) return { ok: true, value: null };
      const s = ctx.suppliersByName.get(cell.toLowerCase());
      return s ? { ok: true, value: s.id } : { ok: false, issue: { code: "unknownSupplier" } };
    },
    show: (v, ctx) => (typeof v === "string" ? (ctx.supplierName.get(v) ?? "") : ""),
  },
  {
    header: "case_pack",
    aliases: ["case_size", "case_qty"],
    role: "value",
    label: "Case pack",
    hint: "Units per case for this product (wins over the supplier's). Empty = the supplier's.",
    example: "12",
    field: "caseQty",
    export: (v) => (v.caseQty === null ? "" : String(v.caseQty)),
    read: (cell) => {
      if (!cell) return { ok: true, value: null };
      const n = Number(cell);
      return Number.isInteger(n) && n >= 1 && n <= CASE_PACK_MAX ? { ok: true, value: n } : { ok: false, issue: { code: "range", min: 1, max: CASE_PACK_MAX } };
    },
    show: (v) => (typeof v === "number" ? String(v) : ""),
  },
  {
    header: "dont_reorder",
    aliases: ["no_reorder", "do_not_reorder"],
    role: "value",
    label: "Don't reorder",
    hint: "yes = keep it in stock numbers, never in orders (sell through, discontinued).",
    example: "no",
    field: "noReorder",
    export: (v) => yesNo(v.noReorder),
    read: (cell) => {
      const b = readYesNo(cell);
      return b === null ? { ok: false, issue: { code: "yesNo" } } : { ok: true, value: b };
    },
    show: (v) => yesNo(!!v),
  },
  {
    header: "supplier_code",
    aliases: ["style_code", "article_code"],
    role: "value",
    label: "Supplier code",
    hint: "The supplier's article or style number for this product. Shown on purchase orders. Leave empty to use the start of the SKUs.",
    example: "AC-1042",
    field: "supplierCode",
    export: (v) => v.supplierCode ?? "",
    read: (cell) => {
      const r = readSupplierCode(cell);
      return r.ok ? { ok: true, value: r.code } : { ok: false, issue: { code: "codeLong" } };
    },
    show: (v) => (typeof v === "string" ? v : ""),
  },
];

export function columnsFor(entity: ImportEntity): ImportColumn[] {
  return entity === "suppliers" ? SUPPLIER_COLUMNS : PRODUCT_COLUMNS;
}

/** Header → column index in the file; unknown headers listed (ignored). */
function mapHeader<C extends ImportColumn>(cells: string[], columns: C[]): { at: Map<C, number>; ignored: string[]; duplicate: string | null } {
  const at = new Map<C, number>();
  const ignored: string[] = [];
  let duplicate: string | null = null;
  cells.forEach((raw, i) => {
    const h = normHeader(raw);
    if (!h) return;
    const col = columns.find((c) => c.header === h || c.aliases?.includes(h));
    if (!col) ignored.push(cleanCell(raw));
    else if (at.has(col)) duplicate ??= col.header;
    else at.set(col, i);
  });
  return { at, ignored, duplicate };
}

// ── Preview and plan ───────────────────────────────────────────────────────────

export type FileError = "empty" | "tooBig" | "tooMany" | "noKey" | "noName" | "noValues" | "duplicateColumn" | "notCsv";

export type ChangeRow = {
  line: number;
  /** Supplier name, or "Product · Variant" (a handle row: the product and its variant count). */
  label: string;
  variants?: number;
  kind: "create" | "update";
  fields: { column: string; from: string; to: string }[];
};

export type ImportPreview = {
  entity: ImportEntity;
  fileError: FileError | null;
  /** Data rows read (blank rows not counted). */
  rows: number;
  /** Rows that change something. */
  changed: number;
  /** products: variants changed. */
  variantsChanged: number;
  /** suppliers: new suppliers. */
  created: number;
  unchanged: number;
  /** Rows skipped because of a problem (not found rows not counted). */
  problemRows: number;
  issues: ImportIssue[];
  /** Rows whose key matched no product (`issues` lists them, code notFound); total count. */
  notFound: number;
  changes: ChangeRow[];
  ignoredColumns: string[];
  /** The value columns in the file (what an import can change). */
  valueColumns: string[];
  /** Identifies exactly these writes: Confirm applies only when the plan is still the same. */
  fingerprint: string;
};

export type ProductsPlan = { patches: Map<string, VariantPatch> };
export type SuppliersPlan = { creates: SupplierInput[]; updates: { id: string; input: SupplierInput }[] };

function emptyPreview(entity: ImportEntity, fileError: FileError | null): ImportPreview {
  return { entity, fileError, rows: 0, changed: 0, variantsChanged: 0, created: 0, unchanged: 0, problemRows: 0, issues: [], notFound: 0, changes: [], ignoredColumns: [], valueColumns: [], fingerprint: "" };
}

/** FNV-1a over a string (32-bit, hex): a cheap, stable fingerprint of a plan. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Is the text too big, or not text at all, before anything is parsed? */
export function fileProblem(text: string, bytes: number): FileError | null {
  if (bytes > MAX_IMPORT_BYTES) return "tooBig";
  if (/\u0000/.test(text.slice(0, 4096))) return "notCsv";
  return null;
}

function pushIssue(p: ImportPreview, issue: ImportIssue) {
  if (p.issues.length < PREVIEW_LIST_MAX * 2) p.issues.push(issue);
}

/**
 * Product settings: rows → per-variant patches (only what differs from the stored values).
 * `variants`: every variant of the store; `suppliers`: the store's suppliers.
 */
export function planProductsImport(
  records: Iterable<CsvRecord>,
  variants: readonly ImportVariant[],
  suppliers: readonly { id: string; name: string }[],
): { preview: ImportPreview; plan: ProductsPlan } {
  const plan: ProductsPlan = { patches: new Map() };
  const it = records[Symbol.iterator]();
  const first = it.next();
  if (first.done) return { preview: emptyPreview("products", "empty"), plan };
  const { at, ignored, duplicate } = mapHeader(first.value.cells, PRODUCT_COLUMNS);
  const p = emptyPreview("products", null);
  p.ignoredColumns = ignored;
  if (duplicate) return { preview: { ...p, fileError: "duplicateColumn", ignoredColumns: [duplicate] }, plan };
  const keys = PRODUCT_COLUMNS.filter((c) => c.role === "key" && at.has(c));
  const values = PRODUCT_COLUMNS.filter((c) => c.role === "value" && at.has(c));
  p.valueColumns = values.map((c) => c.header);
  if (!keys.length) return { preview: { ...p, fileError: "noKey" }, plan };
  if (!values.length) return { preview: { ...p, fileError: "noValues" }, plan };

  const ctx: ProductCtx = {
    suppliersByName: new Map(suppliers.map((s) => [s.name.trim().toLowerCase(), s])),
    supplierName: new Map(suppliers.map((s) => [s.id, s.name])),
  };
  const byId = new Map<string, ImportVariant>();
  const bySku = new Map<string, ImportVariant[]>();
  const byHandle = new Map<string, ImportVariant[]>();
  for (const v of variants) {
    byId.set(v.id, v);
    if (v.sku?.trim()) {
      const k = v.sku.trim().toLowerCase();
      (bySku.get(k) ?? bySku.set(k, []).get(k)!).push(v);
    }
    const h = v.handle.trim().toLowerCase();
    (byHandle.get(h) ?? byHandle.set(h, []).get(h)!).push(v);
  }
  const seen = new Map<string, number>(); // variant id → line that set it

  for (let r = it.next(); !r.done; r = it.next()) {
    const { line, cells } = r.value;
    if (cells.every((c) => !c.trim())) continue;
    p.rows++;
    if (p.rows > MAX_IMPORT_ROWS) return { preview: { ...emptyPreview("products", "tooMany"), rows: p.rows }, plan: { patches: new Map() } };
    const cell = (c: ProductColumn) => cleanCell(cells[at.get(c)!]);

    // Which variants: the first key column with a value, in registry order.
    const key = keys.find((c) => cell(c) !== "");
    if (!key) {
      p.problemRows++;
      pushIssue(p, { line, column: null, code: "missingKey" });
      continue;
    }
    const raw = cell(key);
    let targets: ImportVariant[] = [];
    if (key.header === "variant_id") {
      const v = byId.get(variantGid(raw));
      targets = v ? [v] : [];
    } else if (key.header === "sku") {
      targets = bySku.get(raw.toLowerCase()) ?? [];
      if (targets.length > 1) {
        p.problemRows++;
        pushIssue(p, { line, column: key.header, code: "ambiguousSku", value: raw, n: targets.length });
        continue;
      }
    } else targets = byHandle.get(raw.toLowerCase()) ?? [];
    if (!targets.length) {
      p.notFound++;
      pushIssue(p, { line, column: key.header, code: "notFound", value: raw });
      continue;
    }
    const earlier = targets.map((v) => seen.get(v.id)).find((x) => x !== undefined);
    if (earlier !== undefined) {
      p.problemRows++;
      pushIssue(p, { line, column: key.header, code: "duplicate", value: raw, n: earlier });
      continue;
    }

    // Read every value column first: one bad cell skips the whole row.
    const patch: VariantPatch = {};
    let bad = false;
    for (const c of values) {
      const got = c.read!(cell(c), ctx);
      if (!got.ok) {
        bad = true;
        pushIssue(p, { line, column: c.header, value: cell(c), ...got.issue });
      } else (patch as Record<string, unknown>)[c.field!] = got.value;
    }
    if (bad) {
      p.problemRows++;
      continue;
    }
    for (const v of targets) seen.set(v.id, line);

    const fields: ChangeRow["fields"] = [];
    let rowChanged = false;
    for (const v of targets) {
      const diff: VariantPatch = {};
      for (const c of values) {
        const f = c.field!;
        const next = patch[f];
        if ((v[f] ?? null) !== (next ?? null)) (diff as Record<string, unknown>)[f] = next;
      }
      if (Object.keys(diff).length) {
        rowChanged = true;
        plan.patches.set(v.id, diff);
        p.variantsChanged++;
      }
    }
    if (!rowChanged) {
      p.unchanged++;
      continue;
    }
    p.changed++;
    if (p.changes.length < PREVIEW_LIST_MAX) {
      for (const c of values) {
        const f = c.field!;
        const froms = [...new Set(targets.filter((v) => (v[f] ?? null) !== (patch[f] ?? null)).map((v) => c.show!(v[f], ctx)))];
        if (froms.length) fields.push({ column: c.header, from: froms.slice(0, 3).join(", "), to: c.show!(patch[f], ctx) });
      }
      const v0 = targets[0];
      p.changes.push({
        line,
        label: targets.length > 1 || key.header === "handle" ? v0.productTitle : `${v0.productTitle} · ${v0.variantTitle}`,
        ...(targets.length > 1 ? { variants: targets.length } : {}),
        kind: "update",
        fields,
      });
    }
  }
  if (!p.rows) return { preview: { ...p, fileError: "empty" }, plan };
  p.fingerprint = fnv1a(
    JSON.stringify(
      [...plan.patches.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    ),
  );
  return { preview: p, plan };
}

export type SupplierImportCtx = {
  storeCurrency: string;
  defaultLeadTime: number;
  /** Secure storage for supplier emails is set up (lib/crypto.server secretsWritable). */
  secretsWritable: boolean;
};

/** The supplier's values in the file's own spelling (diff and display). */
function canonical(form: SupplierForm, storeCurrency: string, taken: string[]): SupplierForm {
  const v = validateSupplierForm(form, taken, storeCurrency);
  return v.ok ? supplierToForm(v.input) : form;
}

/** Suppliers: rows → creates and updates (only what differs). `existing`: every supplier with its form (email decrypted). */
export function planSuppliersImport(
  records: Iterable<CsvRecord>,
  existing: readonly { id: string; form: SupplierForm }[],
  ctx: SupplierImportCtx,
): { preview: ImportPreview; plan: SuppliersPlan } {
  const plan: SuppliersPlan = { creates: [], updates: [] };
  const it = records[Symbol.iterator]();
  const first = it.next();
  if (first.done) return { preview: emptyPreview("suppliers", "empty"), plan };
  const { at, ignored, duplicate } = mapHeader(first.value.cells, SUPPLIER_COLUMNS);
  const p = emptyPreview("suppliers", null);
  p.ignoredColumns = ignored;
  if (duplicate) return { preview: { ...p, fileError: "duplicateColumn", ignoredColumns: [duplicate] }, plan };
  const nameCol = SUPPLIER_COLUMNS[0];
  if (!at.has(nameCol)) return { preview: { ...p, fileError: "noName" }, plan };
  const present = SUPPLIER_COLUMNS.filter((c) => at.has(c));
  p.valueColumns = present.filter((c) => c.role === "value").map((c) => c.header);

  const byName = new Map(existing.map((s) => [s.form.name.trim().toLowerCase(), s]));
  const allNames = existing.map((s) => s.form.name);
  const inFile = new Map<string, number>(); // lower name → line
  const createdNames: string[] = [];

  for (let r = it.next(); !r.done; r = it.next()) {
    const { line, cells } = r.value;
    if (cells.every((c) => !c.trim())) continue;
    p.rows++;
    if (p.rows > MAX_IMPORT_ROWS) return { preview: { ...emptyPreview("suppliers", "tooMany"), rows: p.rows }, plan: { creates: [], updates: [] } };
    const cell = (c: SupplierColumn) => cleanCell(cells[at.get(c)!]);
    const name = cell(nameCol);
    if (!name) {
      p.problemRows++;
      pushIssue(p, { line, column: nameCol.header, code: "missingName" });
      continue;
    }
    const lower = name.toLowerCase();
    if (inFile.has(lower)) {
      p.problemRows++;
      pushIssue(p, { line, column: nameCol.header, code: "duplicate", value: name, n: inFile.get(lower) });
      continue;
    }
    inFile.set(lower, line);
    const match = byName.get(lower) ?? null;
    const base: SupplierForm = match ? { ...match.form, vendorMatch: [...match.form.vendorMatch] } : newSupplierForm(ctx.defaultLeadTime, ctx.storeCurrency);
    const form: SupplierForm = { ...base, vendorMatch: [...base.vendorMatch] };
    let bad = false;
    for (const c of present) {
      const issue = c.apply(form, cell(c));
      if (issue) {
        bad = true;
        pushIssue(p, { line, column: c.header, value: cell(c), ...issue });
      }
    }
    // Another supplier's name (the matched one's own name may change case), or one added above.
    const taken = [...allNames.filter((n) => !match || n !== match.form.name), ...createdNames];
    const v = validateSupplierForm(form, taken, ctx.storeCurrency);
    if (!v.ok) {
      bad = true;
      for (const [field, code] of Object.entries(v.errors) as [keyof SupplierForm, SupplierErrorCode][]) {
        const col = SUPPLIER_COLUMNS.find((c) => c.field === field) ?? nameCol;
        const range = col.field in SUPPLIER_BOUNDS ? SUPPLIER_BOUNDS[col.field as keyof typeof SUPPLIER_BOUNDS] : undefined;
        pushIssue(p, { line, column: col.header, value: at.has(col) ? cell(col) : undefined, code: "supplier", supplierCode: code, ...(code === "range" && range ? range : {}) });
      }
    }
    // As Settings → Suppliers: an email is stored encrypted only, never in the clear.
    if (!bad && v.ok && v.input.email && !ctx.secretsWritable) {
      bad = true;
      pushIssue(p, { line, column: "email", code: "supplier", supplierCode: "emailStorage" });
    }
    if (bad || !v.ok) {
      p.problemRows++;
      continue;
    }
    const to = supplierToForm(v.input);
    if (!match) {
      plan.creates.push(v.input);
      createdNames.push(v.input.name);
      p.created++;
      p.changed++;
      if (p.changes.length < PREVIEW_LIST_MAX)
        p.changes.push({ line, label: v.input.name, kind: "create", fields: present.filter((c) => c.role === "value").map((c) => ({ column: c.header, from: "", to: c.export(to) })) });
      continue;
    }
    const from = canonical(match.form, ctx.storeCurrency, allNames.filter((n) => n !== match.form.name));
    const fields = SUPPLIER_COLUMNS.filter((c) => c.export(from) !== c.export(to)).map((c) => ({
      column: c.header,
      // Emails are shown masked in the preview (they are stored encrypted).
      from: c.header === "email" ? maskEmail(c.export(from)) : c.export(from),
      to: c.header === "email" ? maskEmail(c.export(to)) : c.export(to),
    }));
    if (!fields.length) {
      p.unchanged++;
      continue;
    }
    plan.updates.push({ id: match.id, input: v.input });
    p.changed++;
    if (p.changes.length < PREVIEW_LIST_MAX) p.changes.push({ line, label: match.form.name, kind: "update", fields });
  }
  if (!p.rows) return { preview: { ...p, fileError: "empty" }, plan };
  p.fingerprint = fnv1a(JSON.stringify([plan.creates, plan.updates]));
  return { preview: p, plan };
}

/** "orders@acme.example" → "o•••@acme.example" (the preview never shows a stored email in full). */
export function maskEmail(e: string): string {
  const m = /^([^@])[^@]*(@.+)$/.exec(e);
  return m ? `${m[1]}•••${m[2]}` : e;
}

// ── Export ──────────────────────────────────────────────────────────────────────

export function suppliersCsv(forms: readonly SupplierForm[]): string {
  return CSV_BOM + [csvLine(SUPPLIER_COLUMNS.map((c) => c.header)), ...forms.map((f) => csvLine(SUPPLIER_COLUMNS.map((c) => c.export(f))))].join("\r\n") + "\r\n";
}

export const productsCsvHeader = () => csvLine(PRODUCT_COLUMNS.map((c) => c.header));
export const productsCsvRow = (v: ImportVariant, ctx: ProductCtx) => csvLine(PRODUCT_COLUMNS.map((c) => c.export(v, ctx)));

export function productCtx(suppliers: readonly { id: string; name: string }[]): ProductCtx {
  return {
    suppliersByName: new Map(suppliers.map((s) => [s.name.trim().toLowerCase(), s])),
    supplierName: new Map(suppliers.map((s) => [s.id, s.name])),
  };
}

// ── Copy (literal t() calls so the coverage test sees every string) ────────────

export function fileErrorText(e: FileError, entity: ImportEntity, t: T): string {
  switch (e) {
    case "empty":
      return t("This file has no rows to import.");
    case "tooBig":
      return t("This file is larger than 10 MB. Split it into smaller files.");
    case "tooMany":
      return t("This file has more than 50,000 rows. Split it into smaller files.");
    case "noKey":
      return t("The file needs a variant_id, sku or handle column to find your products.");
    case "noName":
      return t("The file needs a name column with the supplier's name.");
    case "noValues":
      return entity === "products"
        ? t("The file has no column to import. Add supplier, case_pack, dont_reorder or supplier_code.")
        : t("The file has no column to import.");
    case "duplicateColumn":
      return t("A column appears twice in this file. Keep one of them.");
    case "notCsv":
      return t("This isn't a CSV file. Save it as CSV (comma or semicolon separated) and try again.");
  }
}

export function issueText(issue: ImportIssue, t: T, supplierText: (code: SupplierErrorCode) => string): string {
  const n = (v: number | undefined) => (v === undefined ? "" : v);
  switch (issue.code) {
    case "missingKey":
      return t("Add a variant_id, sku or handle to this row.");
    case "missingName":
      return t("Add the supplier's name to this row.");
    case "notFound":
      return fill(t("No product with this {column}: {value}"), { column: issue.column ?? "", value: issue.value ?? "" });
    case "ambiguousSku":
      return fill(t("{n} variants share this SKU. Use variant_id for this row."), { n: n(issue.n) });
    case "duplicate":
      return fill(t("Row {line} already changes this. Keep one of the two rows."), { line: n(issue.n) });
    case "unknownSupplier":
      return fill(t("No supplier called {value}. Add it in Settings → Suppliers or import your suppliers file first."), { value: issue.value ?? "" });
    case "range":
      return fill(t("Enter a whole number from {min} to {max}."), { min: n(issue.min), max: n(issue.max) });
    case "yesNo":
      return t("Use yes or no.");
    case "scope":
      return t("Use variant or product.");
    case "paymentTerms":
      return t("Use order, ship, arrival or after_arrival.");
    case "language":
      return t("Use en, es, fr, de, it, pt, nl or pl.");
    case "codeLong":
      return t("Use up to 64 characters.");
    case "supplier":
      return fill(issue.supplierCode ? supplierText(issue.supplierCode) : "", { min: n(issue.min), max: n(issue.max) });
  }
}
