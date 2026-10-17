/**
 * CSV import / export for setup at scale (owner 2026-10-17, lib/setup-import-shared): reading
 * CSV as spreadsheets write it (BOM, quotes, CRLF, semicolons), the column registry, matching by
 * variant_id / sku / handle, row-level validation with line and column, only real changes in the
 * plan, idempotency (export → import changes nothing), and a 30,000-row file.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_IMPORT_ROWS,
  PRODUCT_COLUMNS,
  SUPPLIER_COLUMNS,
  cleanCell,
  detectDelimiter,
  fileErrorText,
  fileProblem,
  issueText,
  planProductsImport,
  planSuppliersImport,
  productCtx,
  productsCsvHeader,
  productsCsvRow,
  readCsv,
  suppliersCsv,
  type ImportVariant,
} from "../app/lib/setup-import-shared";
import { newSupplierForm, supplierErrorText, type SupplierForm } from "../app/lib/suppliers-shared";

const t = (s: string) => s;
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;

function variant(n: number, over: Partial<ImportVariant> = {}): ImportVariant {
  return {
    id: V(n),
    productId: `gid://shopify/Product/${Math.ceil(n / 2)}`,
    sku: `SKU-${n}`,
    handle: `product-${Math.ceil(n / 2)}`,
    productTitle: `Product ${Math.ceil(n / 2)}`,
    variantTitle: n % 2 ? "S" : "M",
    vendor: "Acme",
    supplierId: null,
    caseQty: null,
    noReorder: false,
    ...over,
  };
}
const SUPPLIERS = [
  { id: "s1", name: "Acme Textiles" },
  { id: "s2", name: "Lisbon Linen" },
];
const VARIANTS = [1, 2, 3, 4].map((n) => variant(n));
const csv = (lines: string[]) => lines.join("\r\n") + "\r\n";
const products = (text: string, variants = VARIANTS, suppliers = SUPPLIERS) => planProductsImport(readCsv(text), variants, suppliers);

describe("reading CSV", () => {
  it("BOM, quoted cells with commas, quotes and line breaks, CRLF; line numbers of the file", () => {
    const text = '﻿name,email\r\n"Acme, Inc.","a@b.c"\r\n"Say ""hi""","multi\nline"\r\n\r\nlast,x';
    const rows = [...readCsv(text)];
    expect(rows.map((r) => r.cells)).toEqual([["name", "email"], ["Acme, Inc.", "a@b.c"], ['Say "hi"', "multi\nline"], [""], ["last", "x"]]);
    expect(rows.map((r) => r.line)).toEqual([1, 2, 3, 5, 6]);
  });

  it("European spreadsheets: semicolons; tabs; commas inside quotes don't count", () => {
    expect(detectDelimiter("sku;case_pack\nA;6")).toBe(";");
    expect(detectDelimiter('"a,b";"c,d";x\n')).toBe(";");
    expect(detectDelimiter("sku\tcase_pack\n")).toBe("\t");
    expect(detectDelimiter("sku,case_pack\n")).toBe(",");
    expect([...readCsv("sku;case_pack\nSKU-1;6\n")].map((r) => r.cells)).toEqual([["sku", "case_pack"], ["SKU-1", "6"]]);
  });

  it("the formula guard of our own exports comes off again", () => {
    expect(cleanCell("  '=SUM(A1)  ")).toBe("=SUM(A1)");
    expect(cleanCell("'-5")).toBe("-5");
    expect(cleanCell("O'Neil")).toBe("O'Neil");
  });

  it("file problems before parsing", () => {
    expect(fileProblem("a", 11 * 1024 * 1024)).toBe("tooBig");
    expect(fileProblem("PK\u0003\u0004\u0000\u0000", 6)).toBe("notCsv");
    expect(fileProblem("sku\n", 4)).toBeNull();
    expect(fileErrorText("noKey", "products", t)).toBe("The file needs a variant_id, sku or handle column to find your products.");
  });
});

describe("product settings import", () => {
  it("matches by variant_id (number or gid), sku and handle; a handle row sets every variant", () => {
    const { preview, plan } = products(csv(["variant_id,sku,handle,case_pack", "1,,,6", `${V(2)},,,8`, ",SKU-3,,10", ",,product-2,12"]));
    expect(preview.fileError).toBeNull();
    expect(preview.rows).toBe(4);
    // Row 5 (product-2 = variants 3 and 4) conflicts with row 4 (variant 3): the second row is skipped.
    expect(plan.patches.get(V(1))).toEqual({ caseQty: 6 });
    expect(plan.patches.get(V(2))).toEqual({ caseQty: 8 });
    expect(plan.patches.get(V(3))).toEqual({ caseQty: 10 });
    expect(preview.issues).toEqual([{ line: 5, column: "handle", code: "duplicate", value: "product-2", n: 4 }]);
    const byHandle = products(csv(["handle,case_pack", "product-2,12"]));
    expect([...byHandle.plan.patches.keys()].sort()).toEqual([V(3), V(4)]);
    expect(byHandle.preview.changes[0]).toMatchObject({ line: 2, label: "Product 2", variants: 2, fields: [{ column: "case_pack", from: "", to: "12" }] });
    expect(byHandle.preview.variantsChanged).toBe(2);
  });

  it("supplier by name (any case), case pack, Don't reorder; only what differs is written", () => {
    const vs = [variant(1, { supplierId: "s1", caseQty: 6 }), variant(2)];
    const { preview, plan } = products(csv(["sku,supplier,case_pack,dont_reorder", "SKU-1,acme textiles,6,no", "SKU-2,Lisbon Linen,,yes"]), vs);
    expect(preview.unchanged).toBe(1);
    expect(preview.changed).toBe(1);
    expect([...plan.patches]).toEqual([[V(2), { supplierId: "s2", noReorder: true }]]);
    expect(preview.changes[0].fields).toEqual([
      { column: "supplier", from: "", to: "Lisbon Linen" },
      { column: "dont_reorder", from: "no", to: "yes" },
    ]);
  });

  it("an empty cell clears; a column left out keeps its values", () => {
    const vs = [variant(1, { supplierId: "s1", caseQty: 6, noReorder: true })];
    const cleared = products(csv(["sku,supplier,case_pack", "SKU-1,,"]), vs);
    expect(cleared.plan.patches.get(V(1))).toEqual({ supplierId: null, caseQty: null }); // noReorder untouched
  });

  it("row problems with line and column; the rest still imports", () => {
    const { preview, plan } = products(
      csv(["sku,handle,supplier,case_pack,dont_reorder", ",,Acme Textiles,6,no", "SKU-1,,Nobody,6,no", "SKU-2,,,0,no", "SKU-3,,,6,maybe", "SKU-9,,,6,no", "SKU-4,,,6,no"]),
    );
    expect(preview.problemRows).toBe(4);
    expect(preview.notFound).toBe(1);
    expect(preview.changed).toBe(1);
    expect([...plan.patches.keys()]).toEqual([V(4)]);
    expect(preview.issues.map((i) => [i.line, i.column, i.code])).toEqual([
      [2, null, "missingKey"],
      [3, "supplier", "unknownSupplier"],
      [4, "case_pack", "range"],
      [5, "dont_reorder", "yesNo"],
      [6, "sku", "notFound"],
    ]);
    const sup = (c: Parameters<typeof supplierErrorText>[0]) => supplierErrorText(c, t);
    expect(issueText(preview.issues[1], t, sup)).toBe("No supplier called {value}. Add it in Settings → Suppliers or import your suppliers file first.".replace("{value}", "Nobody"));
    expect(issueText(preview.issues[2], t, sup)).toBe("Enter a whole number from 1 to 10000.");
    expect(issueText(preview.issues[4], t, sup)).toBe("No product with this sku: SKU-9");
  });

  it("a SKU shared by several variants can't be used", () => {
    const vs = [variant(1, { sku: "DUP" }), variant(2, { sku: "dup" })];
    const { preview } = products(csv(["sku,case_pack", "DUP,6"]), vs);
    expect(preview.issues[0]).toMatchObject({ code: "ambiguousSku", n: 2 });
    expect(issueText(preview.issues[0], t, () => "")).toBe("2 variants share this SKU. Use variant_id for this row.");
  });

  it("file-level problems: no key column, nothing to import, a column twice, no rows; unknown columns are listed", () => {
    expect(products(csv(["product,case_pack", "x,6"])).preview.fileError).toBe("noKey");
    expect(products(csv(["sku,product,vendor", "SKU-1,x,y"])).preview.fileError).toBe("noValues");
    expect(products(csv(["sku,case_pack,case_size", "SKU-1,6,6"])).preview.fileError).toBe("duplicateColumn");
    expect(products(csv(["sku,case_pack"])).preview.fileError).toBe("empty");
    expect(products("").preview.fileError).toBe("empty");
    const p = products(csv(["SKU,Case Pack,Notes", "SKU-1,6,hello"])).preview; // headers: any case, spaces
    expect(p.fileError).toBeNull();
    expect(p.ignoredColumns).toEqual(["Notes"]);
    expect(p.changed).toBe(1);
  });

  it("idempotent: our export, imported unchanged, changes nothing; imported twice, the second time changes nothing", () => {
    const vs = [variant(1, { supplierId: "s2", caseQty: 12, noReorder: true }), variant(2, { sku: "=CMD", vendor: "+Acme" }), variant(3, { sku: null })];
    const ctx = productCtx(SUPPLIERS);
    const exported = [productsCsvHeader(), ...vs.map((v) => productsCsvRow(v, ctx))].join("\r\n");
    expect(exported).toContain("'=CMD"); // formula guard on export
    const again = products(exported, vs);
    expect(again.preview.fileError).toBeNull();
    expect(again.preview.issues).toEqual([]);
    expect(again.preview.changed).toBe(0);
    expect(again.preview.unchanged).toBe(3);
    expect(again.plan.patches.size).toBe(0);
    // Apply a change, then import the same file on the result: nothing more.
    const edited = exported.replace(",12,yes", ",24,yes");
    const first = products(edited, vs);
    expect(first.preview.changed).toBe(1);
    const applied = vs.map((v) => ({ ...v, ...(first.plan.patches.get(v.id) ?? {}) }));
    expect(products(edited, applied).preview.changed).toBe(0);
  });

  it("the fingerprint names exactly the writes", () => {
    const a = products(csv(["sku,case_pack", "SKU-1,6", "SKU-2,8"])).preview.fingerprint;
    const b = products(csv(["sku,case_pack", "SKU-2,8", "SKU-1,6"])).preview.fingerprint;
    const c = products(csv(["sku,case_pack", "SKU-1,6", "SKU-2,9"])).preview.fingerprint;
    expect(a).toBe(b); // same writes, another row order
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("30,000 rows: every variant planned in well under the request time, then idempotent", () => {
    const vs = Array.from({ length: 30_000 }, (_, i) => variant(i + 1));
    const ctx = productCtx(SUPPLIERS);
    const rows = vs.map((v) => productsCsvRow({ ...v, caseQty: 6, supplierId: v.id.endsWith("0") ? "s1" : null }, ctx));
    const text = [productsCsvHeader(), ...rows].join("\r\n");
    const started = Date.now();
    const { preview, plan } = products(text, vs);
    const ms = Date.now() - started;
    expect(preview.rows).toBe(30_000);
    expect(preview.changed).toBe(30_000);
    expect(plan.patches.size).toBe(30_000);
    expect(preview.changes.length).toBe(100); // the list is capped, the counts are not
    expect(ms).toBeLessThan(5_000);
    const after = vs.map((v) => ({ ...v, ...(plan.patches.get(v.id) ?? {}) }));
    expect(products(text, after).preview.changed).toBe(0);
  });

  it("more than 50,000 rows: refused before anything is planned", () => {
    const text = ["sku,case_pack", ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `X-${i},6`)].join("\n");
    const { preview, plan } = products(text, []);
    expect(preview.fileError).toBe("tooMany");
    expect(plan.patches.size).toBe(0);
  });
});

describe("suppliers import", () => {
  const form = (over: Partial<SupplierForm> = {}): SupplierForm => ({ ...newSupplierForm(14, "EUR"), currency: "", ...over });
  const existing = [
    { id: "s1", form: form({ name: "Acme Textiles", email: "orders@acme.example", leadTimeDays: "30", casePack: "6", vendorMatch: ["Acme"] }) },
    { id: "s2", form: form({ name: "Lisbon Linen", leadTimeDays: "21" }) },
  ];
  const ctx = { storeCurrency: "EUR", defaultLeadTime: 14, secretsWritable: true };
  const plan = (text: string, ex = existing, c = ctx) => planSuppliersImport(readCsv(text), ex, c);

  it("updates by name (any case), adds new names, leaves the rest; only changed columns listed, emails masked", () => {
    const { preview, plan: p } = plan(
      csv([
        "name,email,lead_time_days,case_pack,vendors,min_per_item_applies_to,hide_prices",
        "ACME TEXTILES,new@acme.example,45,6,Acme|Acme Kids,variant,no",
        "Porto Knit,porto@knit.example,60,,,product,yes",
      ]),
    );
    expect(preview.changed).toBe(2);
    expect(preview.created).toBe(1);
    expect(p.updates).toHaveLength(1);
    expect(p.updates[0]).toMatchObject({ id: "s1", input: { name: "ACME TEXTILES", email: "new@acme.example", leadTimeDays: 45, vendorMatch: ["Acme", "Acme Kids"] } });
    expect(p.creates[0]).toMatchObject({ name: "Porto Knit", leadTimeDays: 60, minOrderScope: "product", hidePrices: true });
    const upd = preview.changes.find((c) => c.kind === "update")!;
    expect(upd.fields.map((f) => f.column)).toEqual(["name", "email", "lead_time_days", "vendors"]);
    expect(upd.fields[1]).toEqual({ column: "email", from: "o•••@acme.example", to: "n•••@acme.example" });
  });

  it("a new supplier without lead_time_days gets the store's default lead time", () => {
    expect(plan(csv(["name", "Newco"])).plan.creates[0]).toMatchObject({ name: "Newco", leadTimeDays: 14 });
  });

  it("validation as Settings → Suppliers, mapped to the column; duplicates in the file; email needs secure storage", () => {
    const { preview } = plan(
      csv(["name,lead_time_days,transit_days,currency,min_per_item_applies_to", "Acme Textiles,400,,EUR,variant", "B,10,20,EUR,variant", "C,10,,EURO,variant", "D,10,,,style", ",10,,,", "c,10,,,"]),
    );
    const sup = (code: Parameters<typeof supplierErrorText>[0]) => supplierErrorText(code, t);
    expect(preview.issues.map((i) => [i.line, i.column, i.code, i.supplierCode ?? null])).toEqual([
      [2, "lead_time_days", "supplier", "range"],
      [3, "transit_days", "supplier", "transit"],
      [4, "currency", "supplier", "currency"],
      [5, "min_per_item_applies_to", "scope", null],
      [6, "name", "missingName", null],
      [7, "name", "duplicate", null],
    ]);
    expect(issueText(preview.issues[0], t, sup)).toBe("Enter a whole number from 0 to 365.");
    expect(preview.problemRows).toBe(6);
    const noStore = plan(csv(["name,email", "Newco,x@y.example"]), existing, { ...ctx, secretsWritable: false }).preview;
    expect(noStore.issues[0]).toMatchObject({ column: "email", code: "supplier", supplierCode: "emailStorage" });
  });

  it("a name already used by another supplier can't be taken by renaming", () => {
    // Two rows: one creates "Zed"; a later new row can't be "zed" again (duplicate in the file).
    const r = plan(csv(["name", "Zed", "zed"]));
    expect(r.plan.creates).toHaveLength(1);
    expect(r.preview.issues[0]).toMatchObject({ line: 3, code: "duplicate", n: 2 });
  });

  it("idempotent: the exported suppliers file imports with no change", () => {
    const text = suppliersCsv(existing.map((e) => e.form));
    expect(text.startsWith("﻿name,email,lead_time_days")).toBe(true);
    const r = plan(text);
    expect(r.preview.issues).toEqual([]);
    expect(r.preview.changed).toBe(0);
    expect(r.preview.unchanged).toBe(2);
    expect(r.plan.updates).toEqual([]);
  });
});

describe("column registry", () => {
  it("one header per column, keys first; every value column can be exported and read back", () => {
    for (const cols of [SUPPLIER_COLUMNS, PRODUCT_COLUMNS]) {
      const all = cols.flatMap((c) => [c.header, ...(c.aliases ?? [])]);
      expect(new Set(all).size).toBe(all.length);
      for (const c of cols) expect(c.header).toMatch(/^[a-z_]+$/);
    }
    expect(PRODUCT_COLUMNS.filter((c) => c.role === "key").map((c) => c.header)).toEqual(["variant_id", "sku", "handle"]);
    for (const c of PRODUCT_COLUMNS.filter((x) => x.role === "value")) expect(c.field && c.read && c.show, c.header).toBeTruthy();
  });
});
