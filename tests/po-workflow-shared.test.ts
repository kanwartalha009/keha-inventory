/**
 * Purchase-order workflow fixes (merchant audit 2026-10-17), pure logic: draft edits, partial
 * receiving / close as short, re-opening within 30 days, supplier-currency prices, the order
 * minimums, the Open orders rows, and the ship date / arrival in the supplier email.
 */
import { describe, expect, it } from "vitest";
import {
  REOPEN_DAYS,
  applyDraftEdit,
  applyReceipt,
  convertCost,
  lineRemaining,
  openOrderRows,
  orderMinimums,
  partiallyReceived,
  poPricing,
  poProgress,
  poStatusBadge,
  reopenTarget,
  reopenedLines,
  shortUnits,
  supplierLines,
  wasAutoReceived,
  type OpenOrderInput,
} from "../app/lib/purchase-order-shared";
import { poCountsAsOrdered, readPoLines, type PoLine } from "../app/lib/supplier-shared";
import { supplierEmail } from "../app/lib/po-email-shared";

const line = (n: number, qty: number, unitCost: number | null, over: Partial<PoLine> = {}): PoLine => ({
  variantId: `v${n}`,
  qty,
  unitCost,
  productTitle: `Shirt ${n}`,
  variantTitle: "M",
  sku: `S-${n}`,
  ...over,
});
const t = (s: string) => s;

describe("draft edits", () => {
  const lines = [line(1, 12, 2.5), line(2, 6, 1), line(3, 4, null)];

  it("changes quantities and removes lines set to 0; snapshots and prices stay", () => {
    const r = applyDraftEdit(lines, [20, 0, "4"]);
    expect(r).toEqual({ ok: true, lines: [{ ...lines[0], qty: 20 }, lines[2]] });
  });

  it("refuses a missing / extra / non-whole quantity and an empty draft", () => {
    expect(applyDraftEdit(lines, [1, 2])).toEqual({ ok: false, error: "invalid" });
    expect(applyDraftEdit(lines, [1, 2, 1.5])).toEqual({ ok: false, error: "invalid" });
    expect(applyDraftEdit(lines, [1, -1, 3])).toEqual({ ok: false, error: "invalid" });
    expect(applyDraftEdit(lines, "12")).toEqual({ ok: false, error: "invalid" });
    expect(applyDraftEdit(lines, [0, 0, 0])).toEqual({ ok: false, error: "empty" });
  });
});

describe("partial receiving", () => {
  const lines = [line(1, 100, 2), line(2, 50, 1)];

  it("records a part delivery: the order stays open and only the rest counts as to come", () => {
    const r = applyReceipt(lines, [60, 0], false);
    expect(r.ok && r.close).toBe(false);
    if (!r.ok) throw new Error("expected ok");
    expect(r.lines.map((l) => l.received)).toEqual([60, undefined]);
    expect(poProgress(r.lines)).toEqual({ ordered: 150, received: 60, remaining: 90 });
    expect(r.lines.every((l) => l.reopenReceived === undefined)).toBe(true);
    expect(partiallyReceived({ status: "sent", lines: r.lines })).toBe(true);
    expect(poStatusBadge({ status: "confirmed", lines: r.lines }, t)).toEqual({ label: "Partially received", tone: "info" });
    // A second delivery is capped at what's left; everything in → it closes.
    const r2 = applyReceipt(r.lines, [999, 50], false);
    if (!r2.ok) throw new Error("expected ok");
    expect(r2.close).toBe(true);
    expect(r2.lines.map((l) => [l.received, l.reopenReceived])).toEqual([
      [100, 60],
      [50, 0],
    ]);
  });

  it("closes the rest as short", () => {
    const r = applyReceipt(lines, [80, 50], true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.close).toBe(true);
    expect(shortUnits({ status: "received", lines: r.lines })).toBe(20);
    expect(lineRemaining(r.lines[0]!)).toBe(20);
    // Closed with units missing reads "Closed", not "Received" (derived, the status stays received).
    expect(poStatusBadge({ status: "received", lines: r.lines }, t)).toEqual({ label: "Closed", tone: "neutral" });
    const full = applyReceipt(lines, [100, 50], false);
    if (!full.ok) throw new Error("expected ok");
    expect(poStatusBadge({ status: "received", lines: full.lines }, t)).toEqual({ label: "Received", tone: "success" });
    // Close without receiving anything more (the supplier won't ship the rest).
    expect(applyReceipt(lines, [0, 0], true)).toMatchObject({ ok: true, close: true });
  });

  it("refuses nothing to record and bad numbers", () => {
    expect(applyReceipt(lines, [0, 0], false)).toEqual({ ok: false, error: "nothing" });
    expect(applyReceipt(lines, [1], false)).toEqual({ ok: false, error: "invalid" });
    expect(applyReceipt(lines, [-1, 0], false)).toEqual({ ok: false, error: "invalid" });
  });
});

describe("re-opening", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  const base = { source: "keha", sentAt: "2026-09-01T00:00:00Z", confirmedShipDate: null, receivedAt: null, cancelledAt: null };

  it("received → sent / confirmed, cancelled → its status before, within 30 days", () => {
    expect(reopenTarget({ ...base, status: "received", receivedAt: "2026-10-10T00:00:00Z" }, now)).toBe("sent");
    expect(reopenTarget({ ...base, status: "received", receivedAt: "2026-10-10T00:00:00Z", confirmedShipDate: "2026-10-01" }, now)).toBe("confirmed");
    expect(reopenTarget({ ...base, status: "cancelled", cancelledAt: "2026-10-10T00:00:00Z" }, now)).toBe("sent");
    expect(reopenTarget({ ...base, sentAt: null, status: "cancelled", cancelledAt: "2026-10-10T00:00:00Z" }, now)).toBe("draft");
    expect(REOPEN_DAYS).toBe(30);
  });

  it("not after 30 days, not open orders, not Shopify orders", () => {
    expect(reopenTarget({ ...base, status: "received", receivedAt: "2026-09-16T11:00:00Z" }, now)).toBeNull();
    expect(reopenTarget({ ...base, status: "sent" }, now)).toBeNull();
    expect(reopenTarget({ ...base, source: "shopify", status: "received", receivedAt: "2026-10-10T00:00:00Z" }, now)).toBeNull();
  });

  it("restores received units from before the order closed and drops the auto mark", () => {
    const closed = [line(1, 100, 2, { received: 95, autoReceived: 95, reopenReceived: 0 }), line(2, 50, 1, { received: 50, reopenReceived: 20 })];
    expect(wasAutoReceived({ status: "received", lines: closed })).toBe(true);
    expect(shortUnits({ status: "received", lines: closed })).toBe(0); // auto: not "closed short"
    const at = new Date("2026-10-17T09:00:00Z");
    const open = reopenedLines(closed, "received", at);
    // Re-opened after receiving: marked so auto-receive leaves it to the merchant (H1).
    expect(open[0]).toEqual(line(1, 100, 2, { reopenedAt: at.toISOString() }));
    expect(open[1]).toEqual(line(2, 50, 1, { received: 20, reopenedAt: at.toISOString() }));
    expect(readPoLines(JSON.parse(JSON.stringify(open)))[0]).toMatchObject({ reopenedAt: at.toISOString() });
    // The JSON round-trip keeps the marks (lines live in PurchaseOrder.lines).
    expect(readPoLines(JSON.parse(JSON.stringify(closed)))[0]).toMatchObject({ autoReceived: 95, reopenReceived: 0 });
    // A cancelled order keeps its received units.
    expect(reopenedLines([line(1, 10, 1, { received: 4 })], "cancelled")[0]!.received).toBe(4);
    // A cancelled order isn't marked: nothing was received, auto-receive still watches it.
    expect(reopenedLines([line(1, 10, 1)], "cancelled")[0]!.reopenedAt).toBeUndefined();
  });
});

describe("supplier-currency prices", () => {
  it("converts store-currency costs with the supplier's exchange rate", () => {
    // 1 USD = 0.92 EUR: €9.20 → $10.00.
    const p = poPricing({ linesCurrency: "EUR", storeCurrency: "EUR", supplierCurrency: "usd", exchangeRate: 0.92 });
    expect(p).toEqual({ currency: "USD", factor: 1 / 0.92, converted: true, noRate: false });
    expect(convertCost(9.2, p.factor)).toBe(10);
    expect(supplierLines([line(1, 3, 9.2)], false, p.factor)[0]!.unitCost).toBe(10);
    expect("unitCost" in supplierLines([line(1, 3, 9.2)], true, p.factor)[0]!).toBe(false);
  });

  it("without a rate: store-currency prices, labelled (never '—' for the whole order)", () => {
    expect(poPricing({ linesCurrency: "EUR", storeCurrency: "EUR", supplierCurrency: "USD", exchangeRate: null })).toEqual({
      currency: "EUR",
      factor: 1,
      converted: false,
      noRate: true,
    });
    expect(poPricing({ linesCurrency: null, storeCurrency: "EUR", supplierCurrency: null, exchangeRate: null })).toMatchObject({ currency: "EUR", noRate: false });
    // Older orders stored in the supplier's currency show as stored.
    expect(poPricing({ linesCurrency: "USD", storeCurrency: "EUR", supplierCurrency: "USD", exchangeRate: 0.92 })).toMatchObject({ currency: "USD", factor: 1 });
    expect(convertCost(null, 2)).toBeNull();
  });
});

describe("order minimums", () => {
  const sup = { minOrder: null, minOrderTotal: null, minOrderValue: null, minOrderScope: "variant", currency: null };
  const same = poPricing({ linesCurrency: "EUR", storeCurrency: "EUR", supplierCurrency: null, exchangeRate: null });

  it("warns below the unit total, per item, and per product", () => {
    const lines = [line(1, 6, 2), line(2, 4, 2, { productTitle: "Shirt 1" })];
    expect(orderMinimums(lines, { ...sup, minOrderTotal: 20 }, same, "EUR").total).toEqual({ min: 20, units: 10 });
    expect(orderMinimums(lines, { ...sup, minOrder: 6 }, same, "EUR").items).toEqual({ min: 6, count: 1, perProduct: false });
    // Per product: 6 + 4 of "Shirt 1" = 10 ≥ 6.
    expect(orderMinimums(lines, { ...sup, minOrder: 6, minOrderScope: "product" }, same, "EUR").items).toBeNull();
    expect(orderMinimums(lines, null, same, "EUR")).toEqual({ total: null, items: null, value: null, valueUnknown: null });
  });

  it("checks the money minimum in the supplier's currency when the rate is known", () => {
    const usd = poPricing({ linesCurrency: "EUR", storeCurrency: "EUR", supplierCurrency: "USD", exchangeRate: 0.5 });
    const lines = [line(1, 10, 20)]; // €200 → $400
    expect(orderMinimums(lines, { ...sup, currency: "USD", minOrderValue: 500 }, usd, "EUR").value).toEqual({ min: 500, amount: 400, currency: "USD" });
    expect(orderMinimums(lines, { ...sup, currency: "USD", minOrderValue: 300 }, usd, "EUR").value).toBeNull();
    // No rate: can't check — say so instead of guessing.
    const noRate = poPricing({ linesCurrency: "EUR", storeCurrency: "EUR", supplierCurrency: "USD", exchangeRate: null });
    expect(orderMinimums(lines, { ...sup, currency: "USD", minOrderValue: 500 }, noRate, "EUR").valueUnknown).toEqual({ min: 500, currency: "USD" });
    // Same currency as the store.
    expect(orderMinimums(lines, { ...sup, minOrderValue: 250 }, same, "EUR").value).toEqual({ min: 250, amount: 200, currency: "EUR" });
  });
});

describe("Open orders rows", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  const o = (over: Partial<OpenOrderInput>): OpenOrderInput => ({
    id: "x",
    number: "PO-0001",
    source: "keha",
    status: "sent",
    supplierName: "Acme",
    lines: [line(1, 10, 2)],
    currency: "EUR",
    confirmedShipDate: null,
    arrival: null,
    createdAt: "2026-10-01T00:00:00Z",
    sentAt: "2026-10-02T00:00:00Z",
    ...over,
  });

  it("sorted by arrival (undated last); remaining units, age, stale drafts, overdue arrivals", () => {
    const rows = openOrderRows(
      [
        o({ id: "late", arrival: "2026-10-12" }),
        o({ id: "draft", status: "draft", createdAt: "2026-09-30T00:00:00Z", sentAt: null }),
        o({ id: "part", status: "confirmed", confirmedShipDate: "2026-11-01", arrival: "2026-12-06", lines: [line(1, 10, 2, { received: 4 })] }),
        o({ id: "soon", arrival: "2026-10-20" }),
      ],
      { now, today: "2026-10-17", counts: poCountsAsOrdered },
    );
    expect(rows.map((r) => r.id)).toEqual(["late", "soon", "part", "draft"]);
    const [late, soon, part, draft] = rows;
    expect(late).toMatchObject({ overdue: true, ageDays: 15, remaining: 10, units: 10, cost: 20 });
    expect(soon!.overdue).toBe(false);
    expect(part).toMatchObject({ partial: true, remaining: 6, units: 10, ships: "2026-11-01", arrival: "2026-12-06" });
    expect(draft).toMatchObject({ stale: true, overdue: false, ageDays: 17 });
  });

  it("a fresh draft still counts; a draft is never overdue", () => {
    const [d] = openOrderRows([o({ status: "draft", createdAt: "2026-10-10T00:00:00Z", sentAt: null, arrival: "2026-10-01" })], {
      now,
      today: "2026-10-17",
      counts: poCountsAsOrdered,
    });
    expect(d).toMatchObject({ stale: false, overdue: false });
  });
});

describe("supplier email dates", () => {
  it("shows the confirmed ship date and the arrival", () => {
    const input = {
      storeName: "Acme",
      supplierName: "Zeta",
      number: "PO-0001",
      lines: [{ productTitle: "Shirt", variantTitle: "M", sku: null, qty: 2, unitCost: 10 }],
      currency: "USD",
      hidePrices: false,
      confirmUrl: "https://x.test/supplier/confirm/a",
      locale: "en",
    };
    const m = supplierEmail({ ...input, shipDate: "2026-11-01", arrival: "2026-12-06" }, t);
    expect(m.text).toContain("Ship date: Nov 1, 2026 · Expected arrival: ~Dec 6, 2026");
    expect(m.html).toContain("Expected arrival: ~Dec 6, 2026");
    expect(m.text).toContain("Total cost: $20.00");
    expect(supplierEmail(input, t).text).not.toContain("Expected arrival");
  });
});

describe("netting after a partial receipt (compute's landed estimate)", () => {
  it("units already recorded as received aren't subtracted twice", async () => {
    const { withLandedEstimate, kehaOpenUnits } = await import("../app/lib/compute-shared");
    const facts = (onHand: number) => ({ onHand: new Map([["a", onHand]]), baseline: () => undefined, soldSince: () => 0 });
    // 100 ordered, 10 on hand at send; 50 arrived and were recorded → on hand 60, 50 still to come.
    const pos = [{ source: "keha", arrival: "2026-11-30", sentDay: "2026-10-01", lines: [{ variantId: "a", qty: 100, baseOnHand: 10, received: 50 }] }];
    expect(kehaOpenUnits(withLandedEstimate(pos, facts(60))).get("a")).toBe(50);
    // 20 more landed but weren't recorded yet → 30 still to come.
    expect(kehaOpenUnits(withLandedEstimate(pos, facts(80))).get("a")).toBe(30);
    // Two orders of one variant: the older one's receipt doesn't eat the newer one's units.
    const two = [
      { source: "keha", arrival: "2026-11-01", sentDay: "2026-10-01", lines: [{ variantId: "a", qty: 40, baseOnHand: 10, received: 40 }] },
      { source: "keha", arrival: "2026-11-30", sentDay: "2026-10-05", lines: [{ variantId: "a", qty: 30, baseOnHand: 50, received: 0 }] },
    ];
    expect(kehaOpenUnits(withLandedEstimate(two, facts(50))).get("a")).toBe(30);
  });
});
