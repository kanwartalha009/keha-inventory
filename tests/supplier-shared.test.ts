/** Supplier assignment, case packs and PO lines (spec §5.3, §5.5). */
import { describe, expect, it } from "vitest";
import { casePackFor, lineRemaining, onOrderByVariant, poArrival, readPoLines, supplierFor, type SupplierLite } from "../app/lib/supplier-shared";

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

describe("arrival, drafts and currency (audit 2026-10-17)", () => {
  it("adds transit days to a confirmed ship date, not to the lead-time estimate", async () => {
    const { poArrival } = await import("../app/lib/supplier-shared");
    const c = new Date("2026-11-01T00:00:00Z");
    const e = new Date("2026-11-10T00:00:00Z");
    expect(poArrival({ confirmedShipDate: c, expectedDate: e }, 35)?.toISOString().slice(0, 10)).toBe("2026-12-06");
    expect(poArrival({ confirmedShipDate: null, expectedDate: e }, 35)).toBe(e);
    expect(poArrival({ confirmedShipDate: c, expectedDate: e }, null)).toBe(c);
  });

  it("stops counting drafts after 14 days; sent and confirmed always count", async () => {
    const { poCountsAsOrdered } = await import("../app/lib/supplier-shared");
    const now = new Date("2026-10-30T00:00:00Z");
    expect(poCountsAsOrdered({ status: "draft", createdAt: new Date("2026-10-20T00:00:00Z") }, now)).toBe(true);
    expect(poCountsAsOrdered({ status: "draft", createdAt: new Date("2026-10-10T00:00:00Z") }, now)).toBe(false);
    expect(poCountsAsOrdered({ status: "sent", createdAt: new Date("2026-01-01T00:00:00Z") }, now)).toBe(true);
    expect(poCountsAsOrdered({ status: "received", createdAt: now }, now)).toBe(false);
  });

  it("converts with the exchange rate, or says unknown", async () => {
    const { toStoreCurrency, toSupplierCurrency } = await import("../app/lib/supplier-shared");
    expect(toStoreCurrency(100, 0.92)).toBeCloseTo(92);
    expect(toSupplierCurrency(92, 0.92)).toBeCloseTo(100);
    expect(toStoreCurrency(100, null)).toBeNull();
    expect(toStoreCurrency(null, 1)).toBeNull();
  });
});

describe("onOrderByVariant: the one on-order rule (integration 2026-10-17)", () => {
  const NOW = new Date("2026-10-17T12:00:00Z");
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
  const day = (s: string) => new Date(`${s}T00:00:00Z`);
  const transit = new Map([["far", 21]]);
  const opts = { now: NOW, transitOf: (id: string) => transit.get(id) };

  it("remaining units of partly received lines, arrival = ship date + transit, stale drafts out", () => {
    const out = onOrderByVariant(
      [
        // Confirmed, ships 20 Oct + 21 days at sea; 4 of 10 already received.
        { status: "confirmed", createdAt: days(30), confirmedShipDate: day("2026-10-20"), expectedDate: day("2026-10-25"), supplierId: "far", lines: [{ variantId: "a", qty: 10, received: 4 }] },
        // Sent, no confirmation: the lead-time estimate; fully received line adds nothing.
        { status: "sent", createdAt: days(5), confirmedShipDate: null, expectedDate: day("2026-11-30"), supplierId: null, lines: [{ variantId: "a", qty: 5 }, { variantId: "b", qty: 3, received: 3 }] },
        // A draft from 3 days ago counts; one from 20 days ago doesn't.
        { status: "draft", createdAt: days(3), confirmedShipDate: null, expectedDate: null, supplierId: null, lines: [{ variantId: "c", qty: 7 }] },
        { status: "draft", createdAt: days(20), confirmedShipDate: null, expectedDate: null, supplierId: null, lines: [{ variantId: "c", qty: 100 }] },
        // Received / cancelled never count.
        { status: "received", createdAt: days(3), confirmedShipDate: null, expectedDate: null, supplierId: null, lines: [{ variantId: "a", qty: 50 }] },
      ],
      opts,
    );
    expect(out.get("a")).toEqual({ qty: 11, arrival: "2026-11-10" });
    expect(out.has("b")).toBe(false);
    expect(out.get("c")).toEqual({ qty: 7, arrival: null });
  });

  it("filters to the wanted variants", () => {
    const po = { status: "sent", createdAt: NOW, confirmedShipDate: null, expectedDate: null, supplierId: null, lines: [{ variantId: "a", qty: 2 }, { variantId: "b", qty: 3 }] };
    expect([...onOrderByVariant([po], { ...opts, variantIds: new Set(["b"]) }).keys()]).toEqual(["b"]);
  });

  it("lineRemaining never goes below zero", () => {
    expect(lineRemaining({ qty: 3, received: 5 })).toBe(0);
    expect(lineRemaining({ qty: 3 })).toBe(3);
  });
});
