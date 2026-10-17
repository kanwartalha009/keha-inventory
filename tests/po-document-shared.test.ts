/**
 * Purchase-order documents (merchant audit 2026-10-18, lib/po-document-shared): the supplier's PO
 * language, Incoterms, the note, the default ship-to, the document dates and the detail rows the
 * PDF, CSV and email share; the supplier form and the CSV registry carry the language and terms.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../app/lib/i18n";
import {
  DEFAULT_PO_LANGUAGE,
  defaultShipTo,
  detailText,
  parsePoLanguage,
  poDates,
  poDetailRows,
  readIncoterms,
  readPoLanguage,
  readPoNote,
  readShipTo,
  withDetailRows,
  type PoDetails,
} from "../app/lib/po-document-shared";
import { EMPTY_SUPPLIER_FORM, readSupplierForm, supplierToForm, validateSupplierForm } from "../app/lib/suppliers-shared";
import { SUPPLIER_COLUMNS } from "../app/lib/setup-import-shared";
import { poCsv } from "../app/lib/purchase-order-shared";
import { supplierEmail } from "../app/lib/po-email-shared";

const de = (k: string) => translate("de", k);
const en = (k: string) => k;

describe("PO language", () => {
  it("defaults to English, not the store's language", () => {
    expect(DEFAULT_PO_LANGUAGE).toBe("en");
    expect(readPoLanguage(null)).toBe("en");
    expect(readPoLanguage("xx")).toBe("en");
    expect(readPoLanguage("de")).toBe("de");
  });

  it("reads a CSV cell as a code or the language's own name", () => {
    expect(parsePoLanguage("")).toBe("en");
    expect(parsePoLanguage(" DE ")).toBe("de");
    expect(parsePoLanguage("Español")).toBe("es");
    expect(parsePoLanguage("klingon")).toBeNull();
  });
});

describe("Incoterms and the note", () => {
  it("accepts a known Incoterm with an optional place, upper-cases the code", () => {
    expect(readIncoterms("fob  ningbo")).toEqual({ ok: true, value: "FOB ningbo" });
    expect(readIncoterms("DDP")).toEqual({ ok: true, value: "DDP" });
    expect(readIncoterms("  ")).toEqual({ ok: true, value: null });
    expect(readIncoterms("FREE ON BOARD")).toEqual({ ok: false });
    expect(readIncoterms(`EXW ${"x".repeat(60)}`)).toEqual({ ok: false });
  });

  it("keeps the note's lines, trims it, refuses more than 1000 characters", () => {
    expect(readPoNote("  Pack per size\r\nLabel in Spanish ")).toEqual({ ok: true, value: "Pack per size\nLabel in Spanish" });
    expect(readPoNote("")).toEqual({ ok: true, value: null });
    expect(readPoNote("x".repeat(1001))).toEqual({ ok: false });
    expect(readPoNote(12)).toEqual({ ok: false });
  });
});

describe("ship-to", () => {
  const locs = [
    { id: "L3", name: "Zaragoza store", active: true, role: "store", online: false },
    { id: "L2", name: "Madrid warehouse", active: true, role: "warehouse", online: true },
    { id: "L1", name: "Barcelona warehouse", active: false, role: "warehouse", online: true },
  ];

  it("the plan's location, else the first active warehouse, else online, else any active", () => {
    expect(defaultShipTo(locs, "L3")).toBe("L3");
    expect(defaultShipTo(locs, "L1")).toBe("L2"); // inactive scope: not a destination
    expect(defaultShipTo(locs)).toBe("L2");
    expect(defaultShipTo([{ id: "A", name: "Shop", active: true, role: "other", online: true }, { id: "B", name: "A store", active: true, role: "store", online: false }])).toBe("A");
    expect(defaultShipTo([])).toBeNull();
  });

  it("only the store's active locations are accepted from the browser", () => {
    expect(readShipTo("L2", locs)).toBe("L2");
    expect(readShipTo("L1", locs)).toBeNull();
    expect(readShipTo("gid://shopify/Location/999", locs)).toBeNull();
  });
});

describe("document dates", () => {
  it("a draft: arrival as if sent today, ship = arrival − transit", () => {
    expect(poDates({ status: "draft", arrival: null, confirmedShipDate: null, orderDay: "2026-10-18", leadTimeDays: 60, transitDays: 35 })).toEqual({
      ship: "2026-11-12",
      shipConfirmed: false,
      arrival: "2026-12-17",
    });
  });

  it("a confirmed ship date wins; the ship date is never before the order day", () => {
    expect(poDates({ status: "confirmed", arrival: "2026-12-01", confirmedShipDate: "2026-11-01", orderDay: "2026-10-18", leadTimeDays: 60, transitDays: 30 })).toEqual({
      ship: "2026-11-01",
      shipConfirmed: true,
      arrival: "2026-12-01",
    });
    expect(poDates({ status: "sent", arrival: "2026-10-20", confirmedShipDate: null, orderDay: "2026-10-18", leadTimeDays: 10, transitDays: 30 }).ship).toBe("2026-10-18");
    expect(poDates({ status: "sent", arrival: null, confirmedShipDate: null, orderDay: "2026-10-18", leadTimeDays: 10, transitDays: 3 })).toEqual({ ship: null, shipConfirmed: false, arrival: null });
  });
});

const DETAILS: PoDetails = {
  buyer: { name: "Moda Norte SL", lines: ["Calle Mayor 1", "28013 Madrid", "Spain"] },
  shipTo: { name: "Madrid warehouse", lines: ["Polígono Sur 4", "28906 Getafe", "Spain"] },
  terms: { depositPct: 30, balanceDue: "ship", balanceDays: 0 },
  incoterms: "FOB Ningbo",
  shipDate: "2026-11-12",
  shipConfirmed: false,
  arrival: "2026-12-17",
  note: "Pack per size\nLabel cartons with the PO number",
};

describe("detail rows (PDF, CSV and email)", () => {
  it("prints buyer, ship-to, terms, Incoterms, dates and the note, in the supplier's language", () => {
    const rows = poDetailRows(DETAILS, de, (d) => d);
    expect(rows.map((r) => r.label)).toEqual([
      "Käufer",
      "Lieferadresse",
      translate("de", "Payment terms"),
      "Lieferbedingungen (Incoterms)",
      "Voraussichtliches Versanddatum",
      translate("de", "Expected arrival"),
      translate("de", "Note"),
    ]);
    expect(rows[2]!.lines[0]).toBe(translate("de", "{deposit}% deposit, {rest}% at shipment").replace("{deposit}", "30").replace("{rest}", "70"));
    expect(rows[6]!.lines).toEqual(["Pack per size", "Label cartons with the PO number"]);
  });

  it("leaves out what isn't known — no '—' rows to a supplier", () => {
    const rows = poDetailRows({ ...DETAILS, buyer: null, terms: null, incoterms: null, note: null, shipDate: null }, en, (d) => d);
    expect(rows.map((r) => r.label)).toEqual(["Ship to", "Expected arrival"]);
    expect(detailText(rows[0]!)).toBe("Ship to: Madrid warehouse, Polígono Sur 4, 28906 Getafe, Spain");
  });

  it("the CSV carries the rows above the table", () => {
    const table = poCsv([{ productTitle: "Coat", variantTitle: "M", sku: "C-M", qty: 6 }], en, { hidePrices: true, currency: null });
    const csv = withDetailRows(table, poDetailRows(DETAILS, en, (d) => d));
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.match(/﻿/g)).toHaveLength(1);
    expect(lines[0]).toBe('Buyer,"Moda Norte SL, Calle Mayor 1, 28013 Madrid, Spain"');
    expect(lines).toContain("Delivery terms (Incoterms),FOB Ningbo");
    expect(lines).toContain("Expected ship date,2026-11-12");
    const blank = lines.indexOf("");
    expect(lines[blank + 1]).toBe("SKU,Product,Variant,Quantity");
    expect(withDetailRows(table, [])).toBe(table);
  });

  it("the email lists the rows instead of the old ship / arrival line", () => {
    const mail = supplierEmail(
      {
        storeName: "Moda Norte",
        supplierName: "Ningbo Knits",
        number: "PO-0007",
        lines: [{ productTitle: "Coat", variantTitle: "M", sku: "C-M", qty: 6 }],
        currency: null,
        hidePrices: true,
        confirmUrl: "https://x.test/c",
        locale: "en",
        arrival: "2026-12-17",
        details: poDetailRows(DETAILS, en, (d) => d),
      },
      en,
    );
    expect(mail.text).toContain("Ship to: Madrid warehouse, Polígono Sur 4");
    expect(mail.text).toContain("Note: Pack per size, Label cartons with the PO number");
    expect(mail.text).not.toContain("Expected arrival: ~");
    expect(mail.html).toContain("Delivery terms (Incoterms): FOB Ningbo<br>");
  });
});

describe("supplier form and CSV registry", () => {
  it("round-trips the PO language and Incoterms", () => {
    const form = supplierToForm({ name: "Ningbo Knits", email: null, leadTimeDays: 60, minOrder: null, minOrderTotal: null, casePack: null, currency: null, hidePrices: false, vendorMatch: [], poLanguage: "de", incoterms: "FOB Ningbo" });
    expect(form.poLanguage).toBe("de");
    expect(form.incoterms).toBe("FOB Ningbo");
    const v = validateSupplierForm(readSupplierForm({ ...form, incoterms: "fob ningbo" }), [], "EUR");
    expect(v.ok && v.input).toMatchObject({ poLanguage: "de", incoterms: "FOB ningbo" });
    expect(readSupplierForm({ ...EMPTY_SUPPLIER_FORM, poLanguage: "klingon" }).poLanguage).toBe("en");
    const bad = validateSupplierForm({ ...EMPTY_SUPPLIER_FORM, name: "X", incoterms: "cheap" }, [], "EUR");
    expect(!bad.ok && bad.errors.incoterms).toBe("incoterms");
  });

  it("the import / export registry has po_language and incoterms", () => {
    const lang = SUPPLIER_COLUMNS.find((c) => c.header === "po_language")!;
    const inc = SUPPLIER_COLUMNS.find((c) => c.header === "incoterms")!;
    const f = { ...EMPTY_SUPPLIER_FORM };
    expect(lang.apply(f, "Deutsch")).toBeNull();
    expect(f.poLanguage).toBe("de");
    expect(lang.export(f)).toBe("de");
    expect(lang.apply(f, "xx")).toEqual({ code: "language" });
    expect(inc.apply(f, "DDP Madrid")).toBeNull();
    expect(inc.export(f)).toBe("DDP Madrid");
  });
});
