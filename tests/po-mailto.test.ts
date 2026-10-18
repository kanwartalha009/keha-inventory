/**
 * "Open in your email" (owner decision 2026-10-18: no paid email provider): the purchase order as
 * a mailto link — the length cap, the supplier's PO language, truncation with "+N more lines",
 * RFC 6068 encoding, and addresses that would change the link's meaning.
 */
import { describe, expect, it } from "vitest";
import { MAILTO_MAX, mailtoAddress, mailtoUrl, supplierMailto, type SupplierMailtoInput } from "../app/lib/po-mailto-shared";
import { translate, type Locale } from "../app/lib/i18n";
import type { SupplierLine } from "../app/lib/purchase-order-shared";

const LINK = "https://inventory.keha.io/supplier/confirm/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd";

const line = (n: number, over: Partial<SupplierLine> = {}): SupplierLine => ({
  productTitle: `Merino crew jumper ${n}`,
  variantTitle: "Navy / M",
  sku: `KNIT-${n}-M`,
  qty: 12,
  unitCost: 20,
  ...over,
});

const input = (over: Partial<SupplierMailtoInput> = {}): SupplierMailtoInput => ({
  to: "orders@porto-knit.example",
  storeName: "Nordic Wool Co",
  supplierName: "Porto Knitwear Lda.",
  number: "PO-0012",
  lines: [line(1), line(2)],
  currency: "EUR",
  hidePrices: false,
  confirmUrl: LINK,
  locale: "en",
  details: [
    { label: "Ship to", lines: ["Main warehouse", "Storgatan 1", "Stockholm"] },
    { label: "Payment terms", lines: ["30% deposit, 70% before shipping"] },
    { label: "Delivery terms (Incoterms)", lines: ["FOB Porto"] },
    { label: "Expected arrival", lines: ["Nov 15, 2026"] },
  ],
  ...over,
});

const tr = (l: Locale) => (k: string) => translate(l, k);
const decode = (url: string) => {
  const q = new URL(url.replace(/^mailto:/, "mailto://x/")).searchParams;
  return { subject: q.get("subject"), body: q.get("body") };
};

describe("mailto link", () => {
  it("subject, greeting, ship-to, terms, Incoterms, dates, lines, the supplier link and the PDF/CSV note", () => {
    const m = supplierMailto(input(), tr("en"));
    expect(m.to).toBe("orders@porto-knit.example");
    expect(m.subject).toBe("Purchase order PO-0012 from Nordic Wool Co");
    expect(m.body).toContain("Hello Porto Knitwear Lda.,");
    expect(m.body).toContain("Nordic Wool Co would like to order the items below.");
    expect(m.body).toContain("- 12 × Merino crew jumper 1 — Navy / M (SKU KNIT-1-M) · €20.00");
    expect(m.body).toContain("Total units: 24 · Total cost: €480.00");
    expect(m.body).toContain("Ship to: Main warehouse, Storgatan 1, Stockholm");
    expect(m.body).toContain("Payment terms: 30% deposit, 70% before shipping");
    expect(m.body).toContain("Delivery terms (Incoterms): FOB Porto");
    expect(m.body).toContain("Expected arrival: Nov 15, 2026");
    expect(m.body).toContain("You can also download the order there as a PDF or CSV:");
    expect(m.body).toContain(LINK);
    expect(m.body.trimEnd().endsWith("Thank you,\nNordic Wool Co")).toBe(true);
    expect(m.shownLines).toBe(2);
    expect(m.moreLines).toBe(0);
    expect(m.url.startsWith("mailto:orders@porto-knit.example?subject=")).toBe(true);
    expect(decode(m.url)).toEqual({ subject: m.subject, body: m.body.replace(/\n/g, "\r\n") });
  });

  it("no prices when the supplier sees none", () => {
    const m = supplierMailto(input({ hidePrices: true, lines: [line(1, { unitCost: undefined })] }), tr("en"));
    expect(m.body).toContain("- 12 × Merino crew jumper 1 — Navy / M (SKU KNIT-1-M)\n");
    expect(m.body).toContain("Total units: 12\n");
    expect(m.body).not.toContain("€");
  });

  it("is written in the supplier's PO language (formal), not the merchant's", () => {
    const m = supplierMailto(input({ locale: "de" }), tr("de"));
    expect(m.subject).toBe(translate("de", "Purchase order {number} from {store}").replace("{number}", "PO-0012").replace("{store}", "Nordic Wool Co"));
    expect(m.body).toContain("Guten Tag Porto Knitwear Lda.,");
    expect(m.body).toContain("Bitte bestätigen Sie das Versanddatum über diesen Link.");
    expect(m.body).toContain("Vielen Dank");
    expect(m.body).toMatch(/20,00\s€/);
  });

  it("encodes per RFC 6068: %20 for spaces (never +), CRLF line breaks, & ? # % = in the text", () => {
    const m = supplierMailto(input({ storeName: "Salt & Pepper? #1 100% = ok" }), tr("en"));
    expect(m.url).not.toContain("+");
    expect(m.url).toContain("%20");
    expect(m.url).toContain("%0D%0A");
    expect(m.url).not.toMatch(/[ \n]/);
    const q = m.url.slice(m.url.indexOf("?") + 1).split("&");
    expect(q).toHaveLength(2); // the "&" in the store name is encoded, never a third parameter
    expect(decode(m.url).subject).toBe("Purchase order PO-0012 from Salt & Pepper? #1 100% = ok");
    expect(mailtoUrl("a@b.co", "x y", "1\n2")).toBe("mailto:a@b.co?subject=x%20y&body=1%0D%0A2");
  });

  it("refuses addresses that would change the link, and leaves To empty instead", () => {
    expect(mailtoAddress("orders@porto-knit.example")).toBe("orders@porto-knit.example");
    expect(mailtoAddress("  orders@porto-knit.example ")).toBe("orders@porto-knit.example");
    for (const bad of ["a@b.co?cc=evil@x.com", "a@b.co&bcc=x@y.z", "a b@c.de", "a@b.co,c@d.ef", "<a@b.co>", "not-an-email", "", null])
      expect(mailtoAddress(bad), String(bad)).toBe("");
    const m = supplierMailto(input({ to: "a@b.co?bcc=evil@x.com" }), tr("en"));
    expect(m.to).toBe("");
    expect(m.url.startsWith("mailto:?subject=")).toBe(true);
  });

  it("stays under the cap: lines are dropped from the end with '+N more lines in the order link'", () => {
    const lines = Array.from({ length: 40 }, (_, i) => line(i + 1));
    const m = supplierMailto(input({ lines }), tr("en"));
    expect(m.url.length).toBeLessThanOrEqual(MAILTO_MAX);
    expect(m.shownLines).toBeGreaterThan(0);
    expect(m.shownLines + m.moreLines).toBe(40);
    expect(m.body).toContain(`+${m.moreLines} more lines in the order link`);
    expect(m.body).toContain(`Merino crew jumper ${m.shownLines} `);
    expect(m.body).not.toContain(`Merino crew jumper ${m.shownLines + 1} `);
    // The link, the totals of the WHOLE order and the sign-off are never cut.
    expect(m.body).toContain(LINK);
    expect(m.body).toContain("Total units: 480");
    expect(m.body).toContain("Nordic Wool Co");
    // One more line would not fit.
    const one = supplierMailto(input({ lines, max: m.url.length }), tr("en"));
    expect(one.shownLines).toBe(m.shownLines);
  });

  it("one line left out says so in the singular; no link → '+1 more line in the attached PDF'", () => {
    const full = supplierMailto(input({ lines: [line(1), line(2), line(3)] }), tr("en"));
    const two = supplierMailto(input({ lines: [line(1), line(2), line(3)], max: full.url.length - 1 }), tr("en"));
    expect(two.moreLines).toBe(1);
    expect(two.body).toContain("+1 more line in the order link");
    const noLink = supplierMailto(input({ confirmUrl: null, lines: [line(1), line(2), line(3)] }), tr("en"));
    expect(noLink.body).toContain("The order is attached as a PDF.");
    expect(noLink.body).not.toContain("download the order there");
    const cut = supplierMailto(input({ confirmUrl: null, lines: [line(1), line(2), line(3)], max: noLink.url.length - 1 }), tr("en"));
    expect(cut.body).toContain("+1 more line in the attached PDF");
  });

  it("a very long note is shortened with … when even no lines fit; the link always stays", () => {
    const note = { label: "Note", lines: Array.from({ length: 40 }, (_, i) => `Pack item ${i} in its own polybag with the size sticker on the outside`) };
    const m = supplierMailto(input({ details: [...input().details!, note] }), tr("en"));
    expect(m.detailsCut).toBe(true);
    expect(m.url.length).toBeLessThanOrEqual(MAILTO_MAX);
    expect(m.body).toContain("…");
    expect(m.body).toContain(LINK);
    expect(m.body).toContain("Ship to: Main warehouse");
    expect(m.moreLines).toBe(2);
  });

  it("non-Latin text is percent-encoded as UTF-8 and counted after encoding", () => {
    const lines = Array.from({ length: 30 }, (_, i) => line(i + 1, { productTitle: `Sweter wełniany źółć ${i + 1}` }));
    const m = supplierMailto(input({ lines, locale: "pl" }), tr("pl"));
    expect(m.url.length).toBeLessThanOrEqual(MAILTO_MAX);
    expect(m.url).toContain("%C5%BA"); // ź
    expect(decode(m.url).body).toContain("Sweter wełniany źółć 1 ");
  });
});
