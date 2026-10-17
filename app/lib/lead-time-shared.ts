/**
 * Lead-time reliability per supplier (supplier module, Kanwar 2026-10-17). Pure, client-safe; the
 * database part is models/suppliers.server.ts refreshLeadStats.
 *
 * One delivery = one received purchase order with both dates:
 *  - Keha orders: sent → received (store-local days). Promised = the expected arrival stamped when it
 *    was sent (sent + the supplier's lead time then), else the supplier's lead time now.
 *  - Shopify purchase orders: ordered → received, only when Keha saw the order open before it was
 *    received (its received date is then the sync that saw it change, within a day); one first read
 *    already received has no real date and is left out. Promised = the supplier's lead time.
 * Orders received before they were sent, or more than MAX_LEAD_DAYS after, are left out.
 *
 * Measured: deliveries, average promised and actual days, average delay (actual − promised; > 0
 * late), the standard deviation of the actual lead time (sample, n − 1) and the share on time
 * (arrived on or before the promised day). With MIN_SAMPLES deliveries or more, safety stock uses
 * the variability: z × √(P × σd² + d² × σL²) (engine/order-shared safetyStockWithLead).
 */
import { daysBetween, type DayKey } from "./engine/dates-shared";
import { fill } from "./i18n";

type T = (s: string) => string;

/** Deliveries needed before the measured variability feeds safety stock (and "Usually late" is said). */
export const MIN_SAMPLES = 3;
/** A lead time above this is a data error, not a delivery. */
export const MAX_LEAD_DAYS = 730;
/** The most recent deliveries measured per supplier. */
export const MAX_SAMPLES = 50;

export type Delivery = { promised: number; actual: number; receivedDay: DayKey };

export type LeadStats = {
  samples: number;
  promisedAvg: number;
  actualAvg: number;
  /** actual − promised, averaged (> 0: late). */
  delayAvg: number;
  /** Standard deviation of the actual lead time (days); 0 with one delivery. */
  sigma: number;
  /** Share delivered on or before the promised day (0–1). */
  onTimeShare: number;
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** One received order as a delivery; null when it can't be measured. */
export function deliveryOf(po: {
  source: string;
  sentDay: DayKey | null;
  receivedDay: DayKey | null;
  /** Keha: the expected arrival stamped when sent. */
  expectedDay?: DayKey | null;
  /** Shopify: the day Keha first read the order. */
  firstSeenDay?: DayKey | null;
  /** The supplier's lead time now (promised when the order has none of its own). */
  leadTimeDays: number;
}): Delivery | null {
  if (!po.sentDay || !po.receivedDay) return null;
  const actual = daysBetween(po.sentDay, po.receivedDay);
  if (!(actual >= 0) || actual > MAX_LEAD_DAYS) return null;
  if (po.source === "shopify") {
    // Read already received: its received date is the first read, not the delivery.
    if (!po.firstSeenDay || po.firstSeenDay >= po.receivedDay) return null;
  }
  const own = po.source === "keha" && po.expectedDay ? daysBetween(po.sentDay, po.expectedDay) : null;
  const promised = own !== null && own >= 0 ? own : Math.max(0, Math.round(finite(po.leadTimeDays) ? po.leadTimeDays : 0));
  return { promised, actual, receivedDay: po.receivedDay };
}

/** Stats over the most recent deliveries (null with none). */
export function leadStats(deliveries: readonly Delivery[], max: number = MAX_SAMPLES): LeadStats | null {
  const list = [...deliveries].sort((a, b) => (a.receivedDay < b.receivedDay ? 1 : a.receivedDay > b.receivedDay ? -1 : 0)).slice(0, max);
  const n = list.length;
  if (!n) return null;
  const mean = (f: (d: Delivery) => number) => list.reduce((a, d) => a + f(d), 0) / n;
  const actualAvg = mean((d) => d.actual);
  const variance = n > 1 ? list.reduce((a, d) => a + (d.actual - actualAvg) ** 2, 0) / (n - 1) : 0;
  return {
    samples: n,
    promisedAvg: r2(mean((d) => d.promised)),
    actualAvg: r2(actualAvg),
    delayAvg: r2(mean((d) => d.actual - d.promised)),
    sigma: r2(Math.sqrt(variance)),
    onTimeShare: r2(list.filter((d) => d.actual <= d.promised).length / n),
  };
}

/** The stored columns (Supplier.lead*) as stats; null when nothing was measured. */
export function readLeadStats(row: {
  leadSamples?: number | null;
  leadPromisedDays?: number | null;
  leadActualDays?: number | null;
  leadDelayDays?: number | null;
  leadSigmaDays?: number | null;
  leadOnTimeShare?: number | null;
} | null | undefined): LeadStats | null {
  if (!row || !finite(row.leadSamples) || row.leadSamples < 1) return null;
  if (![row.leadPromisedDays, row.leadActualDays, row.leadDelayDays, row.leadSigmaDays, row.leadOnTimeShare].every(finite)) return null;
  return {
    samples: row.leadSamples,
    promisedAvg: row.leadPromisedDays!,
    actualAvg: row.leadActualDays!,
    delayAvg: row.leadDelayDays!,
    sigma: row.leadSigmaDays!,
    onTimeShare: row.leadOnTimeShare!,
  };
}

/** The lead-time σ (days) safety stock uses: only with enough deliveries measured; else null (today's formula). */
export function leadSigmaForSafety(stats: LeadStats | null | undefined): number | null {
  return stats && stats.samples >= MIN_SAMPLES && stats.sigma > 0 ? stats.sigma : null;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Which supplier a received order belongs to: its supplierId (Keha orders), else (Shopify orders,
 * which carry only the supplier's name) the supplier with that name or that vendor name in its
 * vendor match, case-insensitive. null = none.
 */
export function supplierOfOrder<S extends { id: string; name: string; vendorMatch: readonly string[] }>(
  po: { supplierId: string | null; supplierName: string | null },
  suppliers: readonly S[],
): S | null {
  if (po.supplierId) return suppliers.find((s) => s.id === po.supplierId) ?? null;
  const name = norm(po.supplierName);
  if (!name) return null;
  const sorted = [...suppliers].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  return sorted.find((s) => norm(s.name) === name) ?? sorted.find((s) => s.vendorMatch.some((v) => norm(v) === name)) ?? null;
}

/** Stored stats differ from new ones (only then the row is written). */
export function statsChanged(a: LeadStats | null, b: LeadStats | null): boolean {
  if (!a || !b) return !!a !== !!b;
  return (["samples", "promisedAvg", "actualAvg", "delayAvg", "sigma", "onTimeShare"] as const).some((k) => Math.abs(a[k] - b[k]) > 1e-9);
}

/** The σ safety stock uses for a supplier row (Supplier.leadSamples / leadSigmaDays); null = today's formula. */
export function supplierLeadSigma(s: { leadSamples?: number | null; leadSigmaDays?: number | null } | null | undefined): number | null {
  if (!s || !finite(s.leadSamples) || s.leadSamples < MIN_SAMPLES || !finite(s.leadSigmaDays) || !(s.leadSigmaDays > 0)) return null;
  return s.leadSigmaDays;
}

/**
 * One short line: "Usually 6 days late", "Usually 2 days early", "Usually on time" (with MIN_SAMPLES
 * deliveries), else "1 delivery measured" / "2 deliveries measured"; "" with none.
 */
export function reliabilityText(stats: LeadStats | null | undefined, t: T, count: (n: number) => string): string {
  if (!stats) return "";
  if (stats.samples < MIN_SAMPLES) return fill(stats.samples === 1 ? t("1 delivery measured") : t("{n} deliveries measured"), { n: count(stats.samples) });
  const d = Math.round(stats.delayAvg);
  if (d >= 1) return fill(d === 1 ? t("Usually 1 day late") : t("Usually {n} days late"), { n: count(d) });
  if (d <= -1) return fill(d === -1 ? t("Usually 1 day early") : t("Usually {n} days early"), { n: count(-d) });
  return t("Usually on time");
}

/** "On time 60% · ± 4 days · 5 deliveries" (details under the line above). */
export function reliabilityDetail(stats: LeadStats | null | undefined, t: T, f: { count: (n: number) => string; percent: (x: number) => string }): string {
  if (!stats || stats.samples < MIN_SAMPLES) return "";
  return fill(t("On time {pct} · ± {sigma} days · {n} deliveries"), {
    pct: f.percent(stats.onTimeShare),
    sigma: f.count(Math.round(stats.sigma * 10) / 10),
    n: f.count(stats.samples),
  });
}
