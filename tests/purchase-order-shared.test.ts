/** Keha purchase orders (spec §5.3, J3, §14): numbers, transitions, dates, CSV, confirm link, auto-receive. */
import { describe, expect, it } from "vitest";
import {
  ARRIVAL_WINDOW_DAYS,
  AUTO_RECEIVE_SHARE,
  arrivalWindowStart,
  autoReceiveDecision,
  autoReceivedLines,
  canTransition,
  confirmLinkOpen,
  formatPoNumber,
  nextPoNumber,
  poCsv,
  poFileName,
  poTotals,
  sentDates,
  validShipDate,
  type AutoReceiveInput,
} from "../app/lib/purchase-order-shared";
import type { PoLine } from "../app/lib/supplier-shared";
import { confirmUrl, supplierEmail } from "../app/lib/po-email-shared";

describe("PO numbers", () => {
  it("formats and continues per shop, ignoring other formats", () => {
    expect(formatPoNumber(1)).toBe("PO-0001");
    expect(formatPoNumber(12345)).toBe("PO-12345");
    expect(nextPoNumber([])).toBe("PO-0001");
    expect(nextPoNumber(["PO-0001", "PO-0009", "#PO12", "PO-0003"])).toBe("PO-0010");
  });
});

describe("status transitions", () => {
  it("follows draft → sent → confirmed → received, cancel from any open status", () => {
    expect(canTransition("draft", "sent")).toBe(true);
    expect(canTransition("draft", "confirmed")).toBe(false);
    expect(canTransition("sent", "confirmed")).toBe(true);
    expect(canTransition("sent", "received")).toBe(true);
    expect(canTransition("confirmed", "received")).toBe(true);
    expect(canTransition("confirmed", "cancelled")).toBe(true);
    expect(canTransition("received", "cancelled")).toBe(false);
    expect(canTransition("cancelled", "draft")).toBe(false);
    expect(canTransition("sent", "bogus")).toBe(false);
  });
  it("never changes an order read from Shopify", () => {
    expect(canTransition("sent", "received", "shopify")).toBe(false);
  });
});

describe("dates and the confirm link", () => {
  const sent = new Date("2026-10-16T10:00:00Z");
  it("expects arrival after the lead time and closes the link after 60 days", () => {
    const d = sentDates(sent, 21);
    expect(d.expectedDate).toBe("2026-11-06");
    expect(d.confirmExpiresAt.toISOString()).toBe("2026-12-15T10:00:00.000Z");
  });
  it("opens only for sent / confirmed Keha orders before expiry", () => {
    const po = { source: "keha", status: "sent", confirmExpiresAt: new Date("2026-12-15T10:00:00Z") };
    expect(confirmLinkOpen(po, new Date("2026-12-15T09:59:00Z"))).toBe(true);
    expect(confirmLinkOpen(po, new Date("2026-12-15T10:00:00Z"))).toBe(false);
    expect(confirmLinkOpen({ ...po, status: "confirmed" }, sent)).toBe(true);
    expect(confirmLinkOpen({ ...po, status: "draft" }, sent)).toBe(false);
    expect(confirmLinkOpen({ ...po, status: "cancelled" }, sent)).toBe(false);
    expect(confirmLinkOpen({ ...po, status: "received" }, sent)).toBe(false);
    expect(confirmLinkOpen({ ...po, source: "shopify" }, sent)).toBe(false);
    expect(confirmLinkOpen({ ...po, confirmExpiresAt: null }, sent)).toBe(false);
    expect(confirmLinkOpen(null, sent)).toBe(false);
  });
  it("accepts ship dates from today to a year ahead", () => {
    expect(validShipDate("2026-10-16", "2026-10-16")).toBe("2026-10-16");
    expect(validShipDate("2026-10-15", "2026-10-16")).toBeNull();
    expect(validShipDate("2027-10-17", "2026-10-16")).toBe("2027-10-17");
    expect(validShipDate("2027-10-18", "2026-10-16")).toBeNull();
    expect(validShipDate("2026-02-30", "2026-01-01")).toBeNull();
    expect(validShipDate(42, "2026-10-16")).toBeNull();
  });
});

const line = (n: number, qty: number, unitCost: number | null, over: Partial<PoLine> = {}): PoLine => ({
  variantId: `v${n}`,
  qty,
  unitCost,
  productTitle: `Shirt ${n}`,
  variantTitle: "M",
  sku: `SKU-${n}`,
  ...over,
});

describe("totals and CSV", () => {
  it("totals units and cost (unknown when any cost is missing)", () => {
    expect(poTotals([line(1, 10, 2.5), line(2, 4, 1)])).toEqual({ units: 14, cost: 29 });
    expect(poTotals([line(1, 10, 2.5), line(2, 4, null)])).toEqual({ units: 14, cost: null });
  });
  it("escapes cells, neutralises formulas and hides prices when asked", () => {
    const lines = [line(1, 10, 2.5, { productTitle: 'Shirt, "big"', sku: "=HYPERLINK(1)" }), line(2, 3, null, { variantTitle: "Default Title" })];
    const csv = poCsv(lines, (s) => s, { hidePrices: false, currency: "EUR" });
    const rows = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(rows[0]).toBe("SKU,Product,Variant,Quantity,Unit cost,Line total,Currency");
    expect(rows[1]).toBe(`'=HYPERLINK(1),"Shirt, ""big""",M,10,2.5,25,EUR`);
    expect(rows[2]).toBe("SKU-2,Shirt 2,,3,,,EUR");
    const hidden = poCsv(lines, (s) => s, { hidePrices: true, currency: "EUR" });
    expect(hidden).not.toContain("Unit cost");
    expect(hidden).not.toContain("2.5");
  });
  it("makes safe file names", () => {
    expect(poFileName("PO-0001", "pdf")).toBe("PO-0001.pdf");
    expect(poFileName("../x y", "csv")).toBe("x-y.csv");
  });
});

describe("auto-receive (tightened, merchant audit 2026-10-17)", () => {
  // Window opened 25 Oct (ship date / expected − 7); baseline = on-hand the day before it opened.
  const base: AutoReceiveInput = {
    status: "sent",
    source: "keha",
    windowStart: "2026-10-25",
    sentDay: "2026-10-01",
    today: "2026-11-02",
    lines: [
      { variantId: "a", qty: 100, baseOnHand: 5 },
      { variantId: "b", qty: 50 },
    ],
    baseline: new Map([
      ["a", 5],
      ["b", 0],
    ]),
    onHand: new Map([
      ["a", 90],
      ["b", 45],
    ]),
    soldSince: new Map([["a", 10]]),
  };

  it("closes when every line landed ≥ 90% inside the arrival window (sales counted back in)", () => {
    const r = autoReceiveDecision(base);
    expect(r.receive).toBe(true);
    if (r.receive) {
      expect(r.received).toEqual({ a: 95, b: 45 });
      expect(r.share).toBeCloseTo(140 / 150);
    }
    expect(AUTO_RECEIVE_SHARE).toBe(0.9);
  });

  it("waits for the arrival window to open", () => {
    expect(autoReceiveDecision({ ...base, today: "2026-10-24" })).toMatchObject({ receive: false, reason: "not_due" });
    expect(autoReceiveDecision({ ...base, windowStart: null })).toMatchObject({ receive: false, reason: "not_due" });
  });

  it("per line: one line short keeps the order open even when the order total is ≥ 90%", () => {
    // a 100/100, b 40/50 (80%) → 93% overall: the old whole-order rule closed this.
    const r = autoReceiveDecision({ ...base, onHand: new Map([["a", 500], ["b", 40]]) });
    expect(r).toMatchObject({ receive: false, reason: "not_landed" });
    expect(r.share).toBeCloseTo(140 / 150);
  });

  it("a stock correction before the window opened doesn't count", () => {
    // On-hand jumped to 95 before 25 Oct (correction): the window baseline is 95, so only +15 landed.
    expect(autoReceiveDecision({ ...base, baseline: new Map([["a", 95], ["b", 0]]), onHand: new Map([["a", 100], ["b", 45]]) })).toMatchObject({
      receive: false,
      reason: "not_landed",
    });
  });

  it("uses the on-hand at send only when the window opened on the send day; unknown baseline stays open", () => {
    const fromSend = { ...base, windowStart: "2026-10-01", baseline: new Map([["b", 0]]) };
    expect(autoReceiveDecision(fromSend).receive).toBe(true);
    // Later window: baseOnHand (at send) isn't the baseline; without StockDaily for that day we can't tell.
    expect(autoReceiveDecision({ ...base, baseline: new Map([["b", 0]]) })).toMatchObject({ receive: false, reason: "no_baseline" });
  });

  it("leaves partly hand-received orders to the merchant; fully received lines are skipped", () => {
    const manual = { ...base, lines: [{ variantId: "a", qty: 100, received: 30 }, { variantId: "b", qty: 50 }] };
    expect(autoReceiveDecision(manual)).toMatchObject({ receive: false, reason: "manual" });
    const done = { ...base, lines: [{ variantId: "a", qty: 100, received: 100 }, { variantId: "b", qty: 50 }], onHand: new Map([["a", 0], ["b", 45]]) };
    expect(autoReceiveDecision(done)).toMatchObject({ receive: true, received: { b: 45 } });
  });

  it("one delivery is never credited to two orders", () => {
    expect(autoReceiveDecision({ ...base, used: new Map([["a", 95]]) })).toMatchObject({ receive: false, reason: "not_landed" });
  });

  it("only applies to sent / confirmed Keha orders (never a draft)", () => {
    expect(autoReceiveDecision({ ...base, status: "draft" })).toMatchObject({ receive: false, reason: "status" });
    expect(autoReceiveDecision({ ...base, source: "shopify" })).toMatchObject({ receive: false, reason: "status" });
    expect(autoReceiveDecision({ ...base, status: "confirmed" }).receive).toBe(true);
  });

  it("the window opens on the ship date, else 7 days before the expected arrival, never before sending", () => {
    expect(arrivalWindowStart({ confirmedShipDate: "2026-11-01", arrival: "2026-12-06", sentDay: "2026-10-01" })).toBe("2026-11-01");
    expect(arrivalWindowStart({ confirmedShipDate: null, arrival: "2026-11-15", sentDay: "2026-10-01" })).toBe("2026-11-08");
    expect(arrivalWindowStart({ confirmedShipDate: null, arrival: "2026-10-05", sentDay: "2026-10-01" })).toBe("2026-10-01");
    expect(arrivalWindowStart({ confirmedShipDate: null, arrival: null, sentDay: "2026-10-01" })).toBeNull();
    expect(ARRIVAL_WINDOW_DAYS).toBe(7);
  });

  it("marks automatically received lines so re-opening restores them", () => {
    const lines: PoLine[] = [line(1, 100, 2), { ...line(2, 50, 1), received: 50 }];
    const out = autoReceivedLines(lines, { v1: 95 });
    expect(out[0]).toMatchObject({ received: 95, autoReceived: 95, reopenReceived: 0 });
    expect(out[1]).toMatchObject({ received: 50, reopenReceived: 50 });
    expect(out[1]!.autoReceived).toBeUndefined();
  });
});

describe("supplier email", () => {
  const input = {
    storeName: "Acme <Store>",
    supplierName: "Zeta",
    number: "PO-0001",
    lines: [line(1, 12, 2.5)],
    currency: "EUR",
    hidePrices: false,
    confirmUrl: "https://inventory.keha.io/supplier/confirm/abc",
    locale: "en",
  };
  it("carries the lines, totals and the supplier-page link; HTML is escaped", () => {
    const m = supplierEmail(input, (s) => s);
    expect(m.subject).toBe("Purchase order PO-0001 from Acme <Store>");
    expect(m.text).toContain("12 × Shirt 1 — M (SKU SKU-1) · €2.50");
    expect(m.text).toContain("Total cost: €30.00");
    expect(m.text).toContain(input.confirmUrl);
    expect(m.html).toContain("Acme &lt;Store&gt;");
    expect(m.html).not.toContain("<Store>");
  });
  it("leaves prices out when hidden, and greets without a name", () => {
    const m = supplierEmail({ ...input, hidePrices: true, supplierName: null }, (s) => s);
    expect(m.text).not.toContain("€");
    expect(m.text.startsWith("Hello,")).toBe(true);
    expect(confirmUrl("https://a.io/", "x y")).toBe("https://a.io/supplier/confirm/x%20y");
  });
});
