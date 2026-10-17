/**
 * Settings → Import & export on an in-memory Prisma (models/setup-import.server): a preview writes
 * nothing; Import writes exactly the previewed changes in grouped statements (one per field value,
 * at most 1,000 ids each, one transaction), refuses when the store changed since the preview,
 * and a second import of the same file writes nothing; suppliers are created with the email
 * encrypted; the product settings export is streamed page by page for 30,000 variants.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] });
  // The in-memory `in` matcher is O(ids) per row; for 30,000 variants use a Set (same result).
  const variant = db.client.variant as { updateMany: (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }> };
  const slow = variant.updateMany;
  variant.updateMany = async (args) => {
    const idIn = (args.where.id as { in?: string[] } | undefined)?.in;
    if (!idIn || Object.keys(args.where).some((k) => k !== "id" && k !== "shop")) return slow(args);
    db.calls.push({ table: "variant", op: "updateMany", args: { count: idIn.length } });
    const ids = new Set(idIn);
    let count = 0;
    for (const r of db.tables.variant ?? []) if (r.shop === args.where.shop && ids.has(r.id as string)) (Object.assign(r, args.data), count++);
    return { count };
  };
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { WRITE_CHUNK, applyImport, exportProductsStream, exportSuppliersCsv, importCounts, patchStatements, planImport } from "../app/models/setup-import.server";
import { decryptSecret } from "../app/lib/crypto.server";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const bytes = (s: string) => Buffer.byteLength(s);

/** R3's supplier columns as the database returns them for a supplier without terms. */
const TERMS = { depositPercent: null, balanceDue: null, balanceDays: null, landedCostPercent: null, leadSamples: null, leadPromisedDays: null, leadActualDays: null, leadDelayDays: null, leadSigmaDays: null, leadOnTimeShare: null, leadStatsAt: null };

function seed(variants = 4) {
  fake.reset();
  fake.tables.shop = [{ domain: S, currency: "EUR", settings: { leadTimeDays: 21 } }];
  fake.tables.supplier = [
    { id: "s1", shop: S, name: "Acme Textiles", email: null, leadTimeDays: 30, minOrder: null, minOrderTotal: null, casePack: 6, transitDays: null, orderCycleDays: null, minOrderValue: null, minOrderScope: "variant", exchangeRate: null, currency: null, hidePrices: false, vendorMatch: ["Acme"], ...TERMS },
    { id: "other", shop: "other.myshopify.com", name: "Not yours", email: null, leadTimeDays: 5, minOrder: null, minOrderTotal: null, casePack: null, transitDays: null, orderCycleDays: null, minOrderValue: null, minOrderScope: "variant", exchangeRate: null, currency: null, hidePrices: false, vendorMatch: [], ...TERMS },
  ];
  fake.tables.variant = Array.from({ length: variants }, (_, i) => ({
    id: V(i + 1),
    shop: S,
    productId: `gid://shopify/Product/${i + 1}`,
    productTitle: `Product ${String(i + 1).padStart(5, "0")}`,
    variantTitle: "M",
    handle: `product-${i + 1}`,
    sku: `SKU-${i + 1}`,
    vendor: "Acme",
    supplierId: null,
    caseQty: null,
    noReorder: false,
    supplierCode: null,
  }));
  fake.tables.variant.push({ ...fake.tables.variant[0], id: V(999), shop: "other.myshopify.com", sku: "SKU-1" });
}

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = "b".repeat(64);
});
beforeEach(() => seed());

const writes = () => fake.calls.filter((c) => ["update", "updateMany", "create", "createMany", "upsert", "deleteMany"].includes(c.op));

describe("product settings", () => {
  const file = "sku,supplier,case_pack,dont_reorder\r\nSKU-1,Acme Textiles,12,no\r\nSKU-2,,12,yes\r\nSKU-3,,,no\r\n";

  it("the preview writes nothing; only this store's variants and suppliers are matched", async () => {
    const { preview } = await planImport(S, "products", file, bytes(file));
    expect(preview).toMatchObject({ rows: 3, changed: 2, unchanged: 1, variantsChanged: 2 });
    expect(writes()).toEqual([]);
    const foreign = await planImport(S, "products", "sku,supplier\r\nSKU-1,Not yours\r\n", 30);
    expect(foreign.preview.issues[0]).toMatchObject({ code: "unknownSupplier" });
  });

  it("Import writes the previewed changes, then importing the same file again writes nothing", async () => {
    const { preview } = await planImport(S, "products", file, bytes(file));
    const r = await applyImport(S, "products", file, bytes(file), preview.fingerprint);
    expect(r).toMatchObject({ ok: true, applied: 2, variants: 2 });
    const v = (n: number) => fake.tables.variant.find((x) => x.id === V(n) && x.shop === S)!;
    expect(v(1)).toMatchObject({ supplierId: "s1", caseQty: 12, noReorder: false });
    expect(v(2)).toMatchObject({ supplierId: null, caseQty: 12, noReorder: true });
    expect(v(3)).toMatchObject({ caseQty: null });
    expect(fake.tables.variant.find((x) => x.id === V(999))!.caseQty).toBeNull(); // other store untouched
    fake.calls.length = 0;
    const again = await planImport(S, "products", file, bytes(file));
    expect(again.preview.changed).toBe(0);
    const r2 = await applyImport(S, "products", file, bytes(file), again.preview.fingerprint);
    expect(r2).toMatchObject({ ok: true, applied: 0 });
    expect(writes()).toEqual([]);
  });

  it("refuses when the store changed since the preview (or the fingerprint doesn't match): the new preview, nothing written", async () => {
    const { preview } = await planImport(S, "products", file, bytes(file));
    fake.tables.variant[0].caseQty = 12; // someone set it on the product page meanwhile
    fake.calls.length = 0;
    const r = await applyImport(S, "products", file, bytes(file), preview.fingerprint);
    expect(r).toMatchObject({ ok: false, reason: "changed" });
    expect(writes()).toEqual([]);
    expect((await applyImport(S, "products", "", 0, "")).ok).toBe(false);
  });

  it("grouped writes: one statement per field value, at most 1,000 ids each", () => {
    const patches = new Map<string, { caseQty?: number | null; noReorder?: boolean }>();
    for (let i = 0; i < 2_500; i++) patches.set(V(i), { caseQty: i % 2 ? 6 : 12, noReorder: true });
    const st = patchStatements(patches);
    expect(st.every((s) => s.ids.length <= WRITE_CHUNK)).toBe(true);
    expect(st.filter((s) => s.field === "caseQty").length).toBe(4); // 1,250 + 1,250 → 2 chunks each
    expect(st.filter((s) => s.field === "noReorder").length).toBe(3); // 2,500 → 3 chunks
    expect(st.reduce((a, s) => a + s.ids.length, 0)).toBe(5_000);
  });

  it("30,000 variants: export streamed page by page, edited and imported in grouped statements", async () => {
    seed(30_000);
    const reader = exportProductsStream(S).getReader();
    let text = "";
    let chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks++;
      text += new TextDecoder("utf-8", { ignoreBOM: true }).decode(value); // keep the BOM to check it
    }
    const lines = text.trimEnd().split("\r\n");
    expect(lines[0]).toBe("﻿variant_id,sku,handle,product,variant_title,vendor,supplier,case_pack,dont_reorder,supplier_code");
    expect(lines.length).toBe(30_001);
    expect(chunks).toBeGreaterThanOrEqual(7); // header + 6 pages of 5,000
    // Every variant: case pack 6.
    const edited = lines.map((l, i) => (i === 0 ? l : l.replace(/,,no,$/, ",6,no,"))).join("\r\n");
    const { preview } = await planImport(S, "products", edited, bytes(edited));
    expect(preview.changed).toBe(30_000);
    fake.calls.length = 0;
    const r = await applyImport(S, "products", edited, bytes(edited), preview.fingerprint);
    expect(r).toMatchObject({ ok: true, variants: 30_000 });
    expect(fake.calls.filter((c) => c.table === "variant" && c.op === "updateMany")).toHaveLength(30);
    expect(fake.tables.variant.filter((v) => v.shop === S && v.caseQty === 6)).toHaveLength(30_000);
  }, 60_000);
});

describe("suppliers", () => {
  it("export with current values; import creates (email encrypted) and updates, never touches other stores", async () => {
    const out = await exportSuppliersCsv(S);
    expect(out).toContain("Acme Textiles,,30,,,,variant,,,6,,,Acme,no,order,,,");
    expect(out).not.toContain("Not yours");
    const file = out + "Porto Knit,porto@knit.example,60,,,,product,,,,USD,0.92,,yes,after_arrival,30,45,12.5\r\n";
    const { preview } = await planImport(S, "suppliers", file, bytes(file));
    expect(preview).toMatchObject({ changed: 1, created: 1, unchanged: 1 });
    const r = await applyImport(S, "suppliers", file, bytes(file), preview.fingerprint);
    expect(r).toMatchObject({ ok: true, applied: 1 });
    const porto = fake.tables.supplier.find((s) => s.name === "Porto Knit")!;
    expect(porto).toMatchObject({ shop: S, leadTimeDays: 60, minOrderScope: "product", currency: "USD", exchangeRate: 0.92, hidePrices: true, balanceDue: "after_arrival", depositPercent: 30, balanceDays: 45, landedCostPercent: 12.5 });
    expect(porto.email).not.toBe("porto@knit.example");
    expect(decryptSecret(porto.email as string)).toBe("porto@knit.example");
    expect(await importCounts(S)).toEqual({ suppliers: 2, variants: 4 });
  });

  it("payment terms and freight & duty (R3) round-trip; a wrong payment_terms cell is a problem row, a column left out keeps its value", async () => {
    const s1 = fake.tables.supplier.find((s) => s.id === "s1")!;
    Object.assign(s1, { balanceDue: "arrival", depositPercent: 20, landedCostPercent: 8 });
    const out = await exportSuppliersCsv(S);
    expect(out.split("\r\n")[0]).toBe("\uFEFFname,email,lead_time_days,transit_days,order_every_days,min_per_item,min_per_item_applies_to,min_order_units,min_order_value,case_pack,currency,exchange_rate,vendors,hide_prices,payment_terms,deposit_percent,rest_days_after_arrival,freight_duty_percent,po_language,incoterms");
    // Merchant audit 2026-10-18: the order language (English by default) and Incoterms follow.
    expect(out).toContain("Acme Textiles,,30,,,,variant,,,6,,,Acme,no,arrival,20,,8,en,");
    // Re-importing the export changes nothing.
    expect((await planImport(S, "suppliers", out, bytes(out))).preview).toMatchObject({ changed: 0, unchanged: 1 });
    const file = "name,payment_terms,freight_duty_percent\r\nAcme Textiles,ship,\r\nNew One,later,\r\n";
    const { preview } = await planImport(S, "suppliers", file, bytes(file));
    expect(preview).toMatchObject({ changed: 1, problemRows: 1 });
    expect(preview.issues[0]).toMatchObject({ line: 3, column: "payment_terms", code: "paymentTerms" });
    expect(await applyImport(S, "suppliers", file, bytes(file), preview.fingerprint)).toMatchObject({ ok: true, applied: 1 });
    // ship kept the 20 % deposit (column left out); the empty freight cell cleared it.
    expect(s1).toMatchObject({ balanceDue: "ship", depositPercent: 20, landedCostPercent: null });
  });
});

describe("supplier code (R3) in the product settings file", () => {
  it("imports per matched variant (a handle row sets every variant), an over-long code is a problem row", async () => {
    fake.tables.variant[1].productId = fake.tables.variant[0].productId;
    fake.tables.variant[1].handle = fake.tables.variant[0].handle;
    const file = `handle,sku,supplier_code\r\nproduct-1,,AC-1042\r\n,SKU-3,${"x".repeat(65)}\r\n,SKU-4,  TR  77 \r\n`;
    const { preview } = await planImport(S, "products", file, bytes(file));
    expect(preview).toMatchObject({ problemRows: 1 });
    expect(preview.issues[0]).toMatchObject({ column: "supplier_code", code: "codeLong" });
    expect(await applyImport(S, "products", file, bytes(file), preview.fingerprint)).toMatchObject({ ok: true, variants: 3 });
    expect(fake.tables.variant.filter((v) => v.shop === S).map((v) => v.supplierCode)).toEqual(["AC-1042", "AC-1042", null, "TR 77"]);
  });
});
