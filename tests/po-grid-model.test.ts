/**
 * Size-grid purchase order on an in-memory Prisma (supplier module, Kanwar 2026-10-17): the
 * product's supplier code (written to every variant), the document's lines grouped per product
 * without ids, the PDF drawn as a grid, and the CSV route (`?layout=grid`, the flat CSV kept).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] });
  return { default: db.client, __fake: db };
});
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() }, unauthenticated: {} }));
vi.mock("../app/services/entitlements.server", () => ({ getEntitlements: vi.fn(), upgradeResponse: vi.fn(() => new Response("upgrade", { status: 403 })) }));

import * as dbModule from "../app/db.server";
import { setProductSupplierCode } from "../app/models/products.server";
import { getOrder } from "../app/models/reorder.server";
import { documentFor } from "../app/services/po-document.server";
import { renderPoPdf } from "../app/services/po-pdf.server";
import { buildPoGrid } from "../app/lib/po-grid-shared";
import { loader as poCsvLoader } from "../app/routes/app.reorder_.$id_.csv";
import { authenticate } from "../app/shopify.server";
import { getEntitlements } from "../app/services/entitlements.server";
import { featureMap } from "../app/lib/plan-shared";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const NOW = new Date("2026-10-16T10:00:00Z");

const variant = (n: number, over: Record<string, unknown>) => ({ id: V(n), shop: S, productId: "P1", productTitle: "Tee", vendor: "Acme", tracked: true, isBundle: false, ...over });
const poLine = (n: number, variantTitle: string, qty: number) => ({ variantId: V(n), qty, unitCost: 10, productTitle: "Tee", variantTitle, sku: `TS-1-${variantTitle.replace(" / ", "")}` });

beforeEach(() => {
  fake.reset();
  fake.tables.shop = [{ domain: S, currency: "EUR", timezone: "UTC", locale: "en", settings: {}, uninstalledAt: null }];
  fake.tables.supplier = [{ id: "s1", shop: S, name: "Acme Textiles", email: null, leadTimeDays: 30, hidePrices: false, vendorMatch: ["Acme"] }];
  fake.tables.variant = [variant(1, { variantTitle: "Black / S", sku: "TS-1-BlackS" }), variant(2, { variantTitle: "Black / M", sku: "TS-1-BlackM" }), variant(3, { productId: "P2", productTitle: "Tote", variantTitle: "Default Title", sku: "TOTE-1" })];
  fake.tables.purchaseOrder = [
    {
      id: "po1",
      shop: S,
      number: "PO-0001",
      source: "keha",
      status: "draft",
      supplierId: "s1",
      confirmToken: "t".repeat(43),
      createdAt: NOW,
      currency: "EUR",
      lines: [poLine(1, "Black / S", 4), poLine(2, "Black / M", 6), { ...poLine(3, "Default Title", 3), productTitle: "Tote", sku: "TOTE-1" }],
    },
  ];
});

describe("supplier code", () => {
  it("is written to every variant of the product; null clears it", async () => {
    expect(await setProductSupplierCode(S, "P1", "ART-9")).toEqual({ ok: true, count: 2 });
    expect(fake.tables.variant!.map((v) => v.supplierCode ?? null)).toEqual(["ART-9", "ART-9", null]);
    expect(await setProductSupplierCode(S, "P1", null)).toEqual({ ok: true, count: 2 });
    expect(fake.tables.variant!.every((v) => (v.supplierCode ?? null) === null)).toBe(true);
    expect(await setProductSupplierCode(S, "nope", "X")).toEqual({ ok: false });
  });
});

describe("the size-grid document", () => {
  it("groups the lines per product with an opaque counter and the supplier code; no ids reach the document", async () => {
    await setProductSupplierCode(S, "P1", "ART-9");
    const doc = await documentFor(S, (await getOrder(S, "po1"))!, NOW);
    expect(doc.gridLines!.map((l) => [l.group, l.supplierCode])).toEqual([
      ["g1", "ART-9"],
      ["g1", "ART-9"],
      ["g2", null],
    ]);
    expect(JSON.stringify(doc)).not.toContain("gid://shopify");
    const grid = buildPoGrid(doc.gridLines!, doc.hidePrices);
    expect(grid.blocks).toEqual([{ sizes: ["S", "M"], rows: [{ styleCode: "ART-9", productTitle: "Tee", label: "Black", qty: [4, 6], units: 10, cost: 100 }], columnTotals: [4, 6], units: 10, cost: 100 }]);
    expect(grid.flat.map((l) => l.productTitle)).toEqual(["Tote"]);
    // The PDF draws the grid and the flat list, prices shown or hidden.
    for (const hidePrices of [false, true]) {
      const pdf = await renderPoPdf({ ...doc, hidePrices });
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(1000);
    }
    // A variant deleted since: grouped by its product title.
    fake.tables.variant = [];
    const gone = await documentFor(S, (await getOrder(S, "po1"))!, NOW);
    expect(gone.gridLines!.map((l) => l.group)).toEqual(["g1", "g1", "g2"]);
  });

  it("the CSV route: ?layout=grid gives the grid, the plain link stays one line per variant", async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: S } } as never);
    vi.mocked(getEntitlements).mockResolvedValue({ plan: "growth", features: featureMap("growth"), comped: false, checked: true } as never);
    await setProductSupplierCode(S, "P1", "ART-9");
    const call = async (q: string) => (await poCsvLoader({ request: new Request(`https://x/app/reorder/po1/csv${q}`), params: { id: "po1" }, context: {} } as never)) as Response;
    const grid = await call("?layout=grid");
    expect(grid.headers.get("Content-Disposition")).toContain("PO-0001-grid.csv");
    const rows = (await grid.text()).replace(/^﻿/, "").split("\r\n");
    expect(rows.slice(0, 3)).toEqual(["Style code,Product,Variant,S,M,Total units,Line total,Currency", "ART-9,Tee,Black,4,6,10,100,EUR", "Totals,,,4,6,10,100,EUR"]);
    expect(rows).toContain(",TOTE-1,Tote,,3,10,30,EUR");
    const flat = await (await call("")).text();
    expect(flat).toContain("SKU,Product,Variant,Quantity,Unit cost,Line total,Currency");
    expect(flat).toContain("TS-1-BlackS,Tee,Black / S,4,10,40,EUR");
  });
});
