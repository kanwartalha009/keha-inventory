/** Post-approval backlog C4: the PO PDF embeds a Unicode font, so Polish (ł, ą, ż) prints as written. */
import { describe, expect, it } from "vitest";
import { pdfFonts, renderPoPdf, type PoPdfInput } from "../app/services/po-pdf.server";

const input: PoPdfInput = {
  locale: "pl",
  storeName: "Sklep Łódź",
  number: "PO-0007",
  supplierName: "Zakład Żółw",
  orderDate: "2026-10-20",
  expectedDate: "2026-11-20",
  confirmedShipDate: null,
  currency: "PLN",
  hidePrices: false,
  lines: [{ productTitle: "Koszula lniana", variantTitle: "Średnia", sku: "KL-1", qty: 12, unitCost: 25, supplierCode: null } as never],
  confirmUrl: null,
};

describe("PO PDF font", () => {
  it("embeds Liberation Sans from app/assets/fonts", async () => {
    const fonts = pdfFonts();
    expect(fonts.unicode).toBe(true);
    const pdf = (await renderPoPdf(input)).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf).toContain("LiberationSans");
    expect(pdf).toContain("/FontFile2");
  });
  it("falls back to Helvetica when the font files are missing", async () => {
    const fonts = pdfFonts("/nowhere");
    expect(fonts).toMatchObject({ regular: "Helvetica", bold: "Helvetica-Bold", unicode: false });
    const pdf = (await renderPoPdf(input, fonts)).toString("latin1");
    expect(pdf).toContain("Helvetica");
    expect(pdf).not.toContain("/FontFile2");
  });
});
