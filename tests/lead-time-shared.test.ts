/**
 * Lead-time reliability (lib/lead-time-shared; supplier module, Kanwar 2026-10-17): deliveries
 * from received Keha and Shopify orders, the stats (promised vs actual, delay, σ, on time), the
 * texts, and the σ in safety stock — z × √(P × σd² + d² × σL²) with ≥ 3 deliveries, else
 * today's formula unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  MIN_SAMPLES,
  deliveryOf,
  leadSigmaForSafety,
  leadStats,
  readLeadStats,
  reliabilityDetail,
  reliabilityText,
  statsChanged,
  supplierLeadSigma,
  supplierOfOrder,
} from "../app/lib/lead-time-shared";
import { safetyStock, safetyStockWithLead } from "../app/lib/engine/order-shared";
import { computeVariant } from "../app/lib/engine/index-shared";
import { buildSeries, variantInput } from "./engine/fixtures";

const t = (s: string) => s;
const count = (n: number) => String(n);

describe("deliveries", () => {
  it("Keha: sent → received; promised = the expected arrival stamped when sent, else the lead time now", () => {
    expect(deliveryOf({ source: "keha", sentDay: "2026-09-01", receivedDay: "2026-10-12", expectedDay: "2026-10-06", leadTimeDays: 40 })).toEqual({ promised: 35, actual: 41, receivedDay: "2026-10-12" });
    expect(deliveryOf({ source: "keha", sentDay: "2026-09-01", receivedDay: "2026-10-12", expectedDay: null, leadTimeDays: 40 })).toMatchObject({ promised: 40, actual: 41 });
  });

  it("Shopify: only orders seen open before they were received; data errors are left out", () => {
    expect(deliveryOf({ source: "shopify", sentDay: "2026-09-01", receivedDay: "2026-10-01", firstSeenDay: "2026-09-02", leadTimeDays: 28 })).toMatchObject({ promised: 28, actual: 30 });
    // First read already received: its received day is the read, not the delivery.
    expect(deliveryOf({ source: "shopify", sentDay: "2026-09-01", receivedDay: "2026-10-01", firstSeenDay: "2026-10-01", leadTimeDays: 28 })).toBeNull();
    expect(deliveryOf({ source: "keha", sentDay: "2026-10-01", receivedDay: "2026-09-01", leadTimeDays: 28 })).toBeNull();
    expect(deliveryOf({ source: "keha", sentDay: null, receivedDay: "2026-09-01", leadTimeDays: 28 })).toBeNull();
    expect(deliveryOf({ source: "keha", sentDay: "2020-01-01", receivedDay: "2026-09-01", leadTimeDays: 28 })).toBeNull();
  });

  it("matches a Shopify order to a supplier by name, then by a vendor it matches", () => {
    const suppliers = [
      { id: "s1", name: "Acme Textiles", vendorMatch: ["ACME"] },
      { id: "s2", name: "Beta", vendorMatch: [] },
    ];
    expect(supplierOfOrder({ supplierId: "s2", supplierName: "Acme Textiles" }, suppliers)?.id).toBe("s2");
    expect(supplierOfOrder({ supplierId: null, supplierName: " acme textiles " }, suppliers)?.id).toBe("s1");
    expect(supplierOfOrder({ supplierId: null, supplierName: "acme" }, suppliers)?.id).toBe("s1");
    expect(supplierOfOrder({ supplierId: null, supplierName: "Gamma" }, suppliers)).toBeNull();
    expect(supplierOfOrder({ supplierId: "gone", supplierName: "Beta" }, suppliers)).toBeNull();
  });
});

describe("stats", () => {
  const d = (promised: number, actual: number, day: string) => ({ promised, actual, receivedDay: day });
  const five = [d(30, 36, "2026-01-10"), d(30, 34, "2026-03-10"), d(30, 30, "2026-05-10"), d(30, 40, "2026-07-10"), d(30, 25, "2026-09-10")];

  it("average promised / actual, delay, sample σ of the actual lead time, share on time", () => {
    const s = leadStats(five)!;
    // actual 36, 34, 30, 40, 25 → mean 33; deviations 3, 1, −3, 7, −8 → Σ² 132 / 4 = 33 → σ 5.74.
    expect(s).toEqual({ samples: 5, promisedAvg: 30, actualAvg: 33, delayAvg: 3, sigma: 5.74, onTimeShare: 0.4 });
    expect(leadStats([])).toBeNull();
    expect(leadStats([d(30, 31, "2026-01-01")])).toMatchObject({ samples: 1, sigma: 0 });
    // The most recent deliveries only.
    expect(leadStats(five, 2)).toMatchObject({ samples: 2, actualAvg: 32.5 });
  });

  it("stored columns ↔ stats; a row is written only when they changed", () => {
    const s = leadStats(five)!;
    const row = { leadSamples: 5, leadPromisedDays: 30, leadActualDays: 33, leadDelayDays: 3, leadSigmaDays: 5.74, leadOnTimeShare: 0.4 };
    expect(readLeadStats(row)).toEqual(s);
    expect(readLeadStats({ ...row, leadSigmaDays: null })).toBeNull();
    expect(readLeadStats({ leadSamples: null })).toBeNull();
    expect(statsChanged(readLeadStats(row), s)).toBe(false);
    expect(statsChanged(null, s)).toBe(true);
    expect(statsChanged(s, null)).toBe(true);
    expect(statsChanged(null, null)).toBe(false);
  });

  it("texts: usually late / early / on time from 3 deliveries; before that, how many were measured", () => {
    const s = leadStats(five)!;
    expect(reliabilityText(s, t, count)).toBe("Usually 3 days late");
    expect(reliabilityText({ ...s, delayAvg: 1.2 }, t, count)).toBe("Usually 1 day late");
    expect(reliabilityText({ ...s, delayAvg: -4 }, t, count)).toBe("Usually 4 days early");
    expect(reliabilityText({ ...s, delayAvg: 0.3 }, t, count)).toBe("Usually on time");
    expect(reliabilityText({ ...s, samples: 2 }, t, count)).toBe("2 deliveries measured");
    expect(reliabilityText({ ...s, samples: 1 }, t, count)).toBe("1 delivery measured");
    expect(reliabilityText(null, t, count)).toBe("");
    expect(reliabilityDetail(s, t, { count, percent: (x) => `${Math.round(x * 100)}%` })).toBe("On time 40% · ± 5.7 days · 5 deliveries");
    expect(reliabilityDetail({ ...s, samples: 2 }, t, { count, percent: String })).toBe("");
  });
});

describe("safety stock with lead-time variability", () => {
  it("z × √(P × σd² + d² × σL²); without σL or a forecast: today's formula", () => {
    // z 1.65, σd 1, P 30, d 2/day, σL 5 days → 1.65 × √(30 + 100) = 18.81.
    expect(safetyStockWithLead(1.65, 1, 30, 2, 5)).toBeCloseTo(1.65 * Math.sqrt(130), 12);
    expect(safetyStockWithLead(1.65, 1, 30, 2, null)).toBe(safetyStock(1.65, 1, 30));
    expect(safetyStockWithLead(1.65, 1, 30, 0, 5)).toBe(safetyStock(1.65, 1, 30));
    expect(safetyStockWithLead(1.65, 1, 30, 2, 0)).toBe(safetyStock(1.65, 1, 30));
  });

  it(`only with ${MIN_SAMPLES}+ deliveries measured`, () => {
    expect(supplierLeadSigma({ leadSamples: 3, leadSigmaDays: 4 })).toBe(4);
    expect(supplierLeadSigma({ leadSamples: 2, leadSigmaDays: 4 })).toBeNull();
    expect(supplierLeadSigma({ leadSamples: 5, leadSigmaDays: 0 })).toBeNull();
    expect(supplierLeadSigma(null)).toBeNull();
    expect(leadSigmaForSafety({ samples: 3, promisedAvg: 1, actualAvg: 1, delayAvg: 0, sigma: 2, onTimeShare: 1 })).toBe(2);
    expect(leadSigmaForSafety({ samples: 2, promisedAvg: 1, actualAvg: 1, delayAvg: 0, sigma: 2, onTimeShare: 1 })).toBeNull();
  });

  it("the engine uses it: more safety, an earlier order, the σ kept in inputs; absent = unchanged", () => {
    const series = buildSeries({ days: 90, sold: (k) => (k % 2 ? 1 : 3), price: 25 });
    const base = variantInput({ series, role: "A", onHand: 40, supplierLeadTimeDays: 16 });
    const before = computeVariant(base)!;
    const after = computeVariant({ ...base, leadTimeSigmaDays: 5 })!;
    expect(before.safety).toBeCloseTo(1.65 * Math.sqrt(30), 12);
    expect(before.inputs.leadSigma).toBeUndefined();
    // Daily forecast 2 (rate 2 × season 1 × trend 1): 1.65 × √(30 × 1 + 4 × 25).
    expect(after.safety).toBeCloseTo(1.65 * Math.sqrt(130), 12);
    expect(after.inputs.leadSigma).toBe(5);
    expect(after.orderQty!).toBeGreaterThan(before.orderQty ?? 0);
    expect(computeVariant({ ...base, leadTimeSigmaDays: null })!.safety).toBe(before.safety);
  });
});
