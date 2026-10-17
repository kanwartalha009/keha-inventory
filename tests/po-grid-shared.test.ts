/**
 * Size-grid purchase order (lib/po-grid-shared; supplier module, Kanwar 2026-10-17): the size
 * option found by its values, size order, one row per style and colour with sizes as columns, the
 * supplier code (own, else the SKU prefix), totals per row and column, the flat fallback, and the
 * grid CSV (no prices when hidden; never freight & duty).
 */
import { describe, expect, it } from "vitest";
import {
  MAX_SIZE_COLUMNS,
  buildPoGrid,
  compareSizes,
  isSizeValue,
  poGridCsv,
  readSupplierCode,
  sizePosition,
  skuPrefix,
  type GridLine,
} from "../app/lib/po-grid-shared";

const t = (s: string) => s;
const line = (group: string, variantTitle: string, qty: number, o: Partial<GridLine> = {}): GridLine => ({
  group,
  productTitle: o.productTitle ?? `Product ${group}`,
  variantTitle,
  sku: o.sku ?? null,
  qty,
  unitCost: "unitCost" in o ? o.unitCost : 10,
  supplierCode: o.supplierCode ?? null,
});

describe("sizes", () => {
  it("recognises letter, number, waist/leg, regional, baby and one-size values — not colours", () => {
    for (const v of ["XS", "s", "M", "XL", "2XL", "XXXL", "36", "8.5", "10½", "32/34", "EU 38", "US 8", "0-3M", "One size", "OS"]) expect(isSizeValue(v), v).toBe(true);
    for (const v of ["Black", "Navy blue", "Cotton", "", "Large print"]) expect(isSizeValue(v), v).toBe(false);
  });

  it("orders one size, then letters XS → 5XL, then numbers", () => {
    expect(["XL", "S", "2XL", "M", "XS", "L"].sort(compareSizes)).toEqual(["XS", "S", "M", "L", "XL", "2XL"]);
    expect(["42", "38", "40", "36.5"].sort(compareSizes)).toEqual(["36.5", "38", "40", "42"]);
    expect(["32/34", "30/32", "32/32"].sort(compareSizes)).toEqual(["30/32", "32/32", "32/34"]);
  });

  it("finds the size position in a product's variant titles; none when no position is all sizes", () => {
    expect(sizePosition(["Black / S", "Black / M", "White / S"])).toBe(1);
    expect(sizePosition(["S / Black", "M / Black"])).toBe(0);
    expect(sizePosition(["38", "39", "40"])).toBe(0);
    expect(sizePosition(["Black", "White"])).toBeNull();
    // One size only (every value the same): no grid.
    expect(sizePosition(["Black / M", "White / M"])).toBeNull();
    expect(sizePosition(["Default Title"])).toBeNull();
    // Mixed shapes: no grid.
    expect(sizePosition(["Black / M", "L"])).toBeNull();
  });
});

describe("style code", () => {
  it("the common SKU prefix cut at a separator, at least 3 characters; else none", () => {
    expect(skuPrefix(["TS-100-BLK-S", "TS-100-BLK-M", "TS-100-WHT-S"])).toBe("TS-100");
    expect(skuPrefix(["JK2201-38", "JK2201-40"])).toBe("JK2201");
    expect(skuPrefix(["AB-1", "AB-2"])).toBeNull();
    expect(skuPrefix(["TS-100-S", null])).toBeNull();
    expect(skuPrefix(["X1", "Y2"])).toBeNull();
    expect(skuPrefix(["ONE-SKU"])).toBeNull();
  });

  it("a supplier code typed on the product page: trimmed, at most 64 printable characters", () => {
    expect(readSupplierCode("  ART 4410  ")).toEqual({ ok: true, code: "ART 4410" });
    expect(readSupplierCode("")).toEqual({ ok: true, code: null });
    expect(readSupplierCode(null)).toEqual({ ok: true, code: null });
    expect(readSupplierCode("x".repeat(65))).toEqual({ ok: false });
    expect(readSupplierCode("a\u0007b")).toEqual({ ok: false });
    expect(readSupplierCode(12)).toEqual({ ok: false });
  });
});

describe("buildPoGrid", () => {
  const lines = [
    line("g1", "Black / M", 6, { productTitle: "Tee", sku: "TS-100-BLK-M" }),
    line("g1", "Black / S", 4, { productTitle: "Tee", sku: "TS-100-BLK-S" }),
    line("g1", "White / L", 2, { productTitle: "Tee", sku: "TS-100-WHT-L" }),
    line("g2", "38", 3, { productTitle: "Boot", supplierCode: "ART-77", unitCost: 40 }),
    line("g2", "40", 5, { productTitle: "Boot", supplierCode: "ART-77", unitCost: 40 }),
    line("g3", "Default Title", 10, { productTitle: "Tote", sku: "TOTE-1" }),
  ];

  it("one row per style and colour, sizes as columns in size order, totals per row and column", () => {
    const g = buildPoGrid(lines, false);
    expect(g.units).toBe(30);
    expect(g.blocks.map((b) => b.sizes)).toEqual([
      ["S", "M", "L"],
      ["38", "40"],
    ]);
    const tee = g.blocks[0]!;
    expect(tee.rows).toEqual([
      { styleCode: "TS-100", productTitle: "Tee", label: "Black", qty: [4, 6, 0], units: 10, cost: 100 },
      { styleCode: "TS-100", productTitle: "Tee", label: "White", qty: [0, 0, 2], units: 2, cost: 20 },
    ]);
    expect(tee).toMatchObject({ columnTotals: [4, 6, 2], units: 12, cost: 120 });
    // The product's own supplier code wins; a size-only product has no label.
    expect(g.blocks[1]!.rows).toEqual([{ styleCode: "ART-77", productTitle: "Boot", label: "", qty: [3, 5], units: 8, cost: 320 }]);
    // No size dimension: the flat list, with its style code when known.
    expect(g.flat).toEqual([{ productTitle: "Tote", variantTitle: "Default Title", sku: "TOTE-1", qty: 10, unitCost: 10, styleCode: null }]);
  });

  it("prices hidden: no money anywhere; a missing cost makes the row's money unknown (never 0)", () => {
    const hidden = buildPoGrid(
      lines.map(({ unitCost: _u, ...l }) => l as GridLine),
      true,
    );
    expect(hidden.blocks[0]!.rows.every((r) => r.cost === null)).toBe(true);
    expect(hidden.blocks[0]!.cost).toBeNull();
    expect("unitCost" in hidden.flat[0]!).toBe(false);
    const missing = buildPoGrid([line("g1", "Black / M", 1, { unitCost: null }), line("g1", "Black / L", 1)], false);
    expect(missing.blocks[0]!.rows[0]!.cost).toBeNull();
    expect(missing.blocks[0]!.cost).toBeNull();
  });

  it(`more than ${MAX_SIZE_COLUMNS} sizes, or a single variant: the flat list`, () => {
    const many = Array.from({ length: MAX_SIZE_COLUMNS + 1 }, (_, i) => line("g1", String(30 + i), 1));
    expect(buildPoGrid(many, false)).toMatchObject({ blocks: [], units: MAX_SIZE_COLUMNS + 1 });
    expect(buildPoGrid([line("g1", "Black / M", 2)], false).flat).toHaveLength(1);
  });

  it("the grid CSV: a header per size run, rows, a Totals row, then the flat lines; prices only when shown", () => {
    const csv = poGridCsv(buildPoGrid(lines, false), t, { hidePrices: false, currency: "EUR" });
    const rows = csv.replace(/^﻿/, "").split("\r\n");
    expect(csv.match(/﻿/g)).toHaveLength(1);
    expect(rows.slice(0, 4)).toEqual([
      "Style code,Product,Variant,S,M,L,Total units,Line total,Currency",
      "TS-100,Tee,Black,4,6,,10,100,EUR",
      "TS-100,Tee,White,,,2,2,20,EUR",
      "Totals,,,4,6,2,12,120,EUR",
    ]);
    expect(rows).toContain("Style code,SKU,Product,Variant,Quantity,Unit cost,Line total,Currency");
    expect(rows).toContain(",TOTE-1,Tote,,10,10,100,EUR");
    const hidden = poGridCsv(buildPoGrid(lines, true), t, { hidePrices: true, currency: "EUR" });
    expect(hidden).not.toMatch(/Line total|Unit cost|EUR/);
    expect(hidden).toContain("TS-100,Tee,Black,4,6,,10");
    // An empty order still has a header.
    expect(poGridCsv(buildPoGrid([], false), t, { hidePrices: false, currency: "EUR" })).toContain("Style code,SKU,Product");
  });
});
