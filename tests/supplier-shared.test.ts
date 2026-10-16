/** Supplier assignment, case packs and PO lines (spec §5.3, §5.5). */
import { describe, expect, it } from "vitest";
import { casePackFor, poArrival, readPoLines, supplierFor, type SupplierLite } from "../app/lib/supplier-shared";

const sup = (id: string, name: string, vendorMatch: string[], extra: Partial<SupplierLite> = {}): SupplierLite => ({
  id,
  name,
  leadTimeDays: 21,
  minOrder: null,
  minOrderTotal: null,
  casePack: null,
  vendorMatch,
  ...extra,
});

describe("supplierFor", () => {
  const list = [sup("s2", "Zeta", ["Acme"]), sup("s1", "Alpha", ["acme ", "Other"])];

  it("prefers an explicit assignment", () => {
    expect(supplierFor({ supplierId: "s2", vendor: "Acme" }, list)?.id).toBe("s2");
  });

  it("matches the vendor case-insensitively, first by supplier name", () => {
    expect(supplierFor({ supplierId: null, vendor: "ACME" }, list)?.id).toBe("s1");
  });

  it("falls back to the vendor when the explicit supplier no longer exists", () => {
    expect(supplierFor({ supplierId: "gone", vendor: "other" }, list)?.id).toBe("s1");
  });

  it("returns null when nothing matches", () => {
    expect(supplierFor({ supplierId: null, vendor: "Nobody" }, list)).toBeNull();
    expect(supplierFor({ supplierId: null, vendor: null }, list)).toBeNull();
  });
});

describe("casePackFor", () => {
  it("uses the variant's own case pack first, then the supplier's", () => {
    expect(casePackFor(6, sup("s", "S", [], { casePack: 12 }))).toBe(6);
    expect(casePackFor(null, sup("s", "S", [], { casePack: 12 }))).toBe(12);
    expect(casePackFor(1, null)).toBeNull();
  });
});

describe("PO lines", () => {
  it("drops malformed entries and floors quantities", () => {
    const lines = readPoLines([
      { variantId: "v1", qty: 5.7, unitCost: 2.5, productTitle: "Tee", variantTitle: "M", sku: "T-M" },
      { variantId: "v2", qty: "x" },
      null,
      { variantId: "v3", qty: -2, unitCost: "?" },
    ]);
    expect(lines.map((l) => [l.variantId, l.qty, l.unitCost])).toEqual([
      ["v1", 5, 2.5],
      ["v3", 0, null],
    ]);
    expect(readPoLines("nope")).toEqual([]);
  });

  it("uses the confirmed date over the estimate", () => {
    const c = new Date("2026-11-01T00:00:00Z");
    const e = new Date("2026-11-10T00:00:00Z");
    expect(poArrival({ confirmedShipDate: c, expectedDate: e })).toBe(c);
    expect(poArrival({ confirmedShipDate: null, expectedDate: e })).toBe(e);
    expect(poArrival({ confirmedShipDate: null, expectedDate: null })).toBeNull();
  });
});
