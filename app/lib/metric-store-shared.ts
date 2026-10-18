/**
 * What VariantMetric stores (DB scale "before 1,000 stores"). Pure.
 *
 * Compute writes a row only when its content changed (services/metric-writes.server): the content
 * hash covers every stored column but computedAt. For that to skip anything, the stored `inputs`
 * must not change every day by itself — so the fields that no reader uses AND that move with the
 * calendar (or are bulky) are not stored (STORED_INPUTS_OMIT); everything a screen, the order
 * plan, alerts, the planner, transfers or accuracy reads is kept as is. `today` is kept only with
 * a seasonal curve (the forward plan offsets the curve by the days since it; without a curve it
 * reads nothing from it).
 *
 * Perf 2026-10-18 (hash-skip audit: 83–100 % of rows changed day over day): floats are stored at
 * STORED_DIGITS significant digits (`storedNumber`), so the last-bit noise of sums taken in another
 * order or over a window that moved by a day no longer changes the hash. 12 digits is far below
 * anything a reader shows or rounds (the order plan recomputes quantities from the stored rate,
 * safety and curve: a relative change of 1e-12 never moves a whole unit in practice). inputs.error
 * keeps what the product page and Why this quantity show (ERROR_KEEP): the backtest internals
 * (model, prior, windows, bias) moved every night and no reader uses them.
 *
 * Readers checked 2026-10-18 (grep of every `inputs` access outside the engine): products-shared
 * readForecastInputs + the product page, engine/forward-plan-shared forwardInputFromMetric,
 * keha-since-run-shared, order-plan.server, planner.server, alerts.server / flow-shared,
 * reorder.server, transfers-shared, compute-locations, accuracy naiveRateOf, products season source.
 */
import { addDays } from "./sync/shopifyql-shared";

/** Top-level inputs keys no reader uses that change by themselves day to day. */
export const STORED_INPUTS_OMIT = [
  "productAgeDays", // + 1 every day — stored as productCreatedDay (the same fact, fixed)
  "noSaleDays", // + 1 every in-stock day without a sale
  "noSaleCalendarDays", // + 1 every day without a sale
  "coverDays", // stock ÷ pace, moves with both
  "soldLastYearAhead", // last year's window slides every day
  "dataDays", // grows until the window is full; nothing reads it (historyDays is shown)
  "outOfStockDays", // nothing reads it (inStockDays is shown)
] as const;

/** inputs.season keys kept (the source and the applied / measured flags); the rest are day-relative spans and raws. */
export const SEASON_KEEP = [
  "level",
  "collectionId",
  "productType",
  "seasonalApplied",
  "seasonalReason",
  "seasonalYears",
  "seasonalWeight",
  "horizonDays",
  "trendApplied",
  "trendReason",
  "trendMeasured",
  "trendMode",
  "trendNote",
  "label",
] as const;

/**
 * inputs.error keys kept: what the product page (fill target, ± error over P days, ratio) and Why
 * this quantity (forward-plan-shared safetyBasisWhy) read, plus the ratio used and k behind safety.
 */
export const ERROR_KEEP = ["horizonDays", "sigma", "fill", "ratio", "samples", "used", "k"] as const;

/** Significant digits a stored float keeps (see the module header). */
export const STORED_DIGITS = 12;

/** A float at STORED_DIGITS significant digits; integers and non-finite values unchanged. */
export function storedNumber(n: number): number {
  return Number.isFinite(n) && !Number.isInteger(n) ? Number(n.toPrecision(STORED_DIGITS)) : n;
}

/** Every number inside `v` (objects, arrays) at storedNumber precision; a new value, `v` untouched. */
export function roundDeep(v: unknown): unknown {
  if (typeof v === "number") return storedNumber(v);
  if (Array.isArray(v)) return v.map(roundDeep);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = roundDeep(x);
    return out;
  }
  return v;
}

/** inputs.windows[] keys kept (the product page's rate table, accuracy's naive rate). */
export const WINDOW_KEEP = ["days", "weight", "inStockDays", "rate", "used"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The inputs as stored: what readers use, nothing that only moves with the calendar. */
export function slimInputs(inputs: unknown): unknown {
  if (!isObj(inputs)) return inputs;
  const out: Record<string, unknown> = {};
  const omit = new Set<string>(STORED_INPUTS_OMIT);
  const hasCurve = Array.isArray(inputs.seasonCurve) && inputs.seasonCurve.length > 0;
  for (const [k, v] of Object.entries(inputs)) {
    if (k === "productAgeDays" && typeof v === "number" && Number.isInteger(v) && typeof inputs.today === "string") {
      // The day the product was created (store-local): what the age is counted from, fixed.
      out.productCreatedDay = addDays(inputs.today, -v);
      continue;
    }
    if (omit.has(k)) continue;
    if (k === "today" && !hasCurve) continue;
    if (k === "season" && isObj(v)) {
      const s: Record<string, unknown> = {};
      for (const key of SEASON_KEEP) if (key in v) s[key] = v[key];
      out[k] = s;
      continue;
    }
    if (k === "error" && isObj(v)) {
      const e: Record<string, unknown> = {};
      for (const key of ERROR_KEEP) if (key in v) e[key] = v[key];
      out[k] = e;
      continue;
    }
    if (k === "windows" && Array.isArray(v)) {
      out[k] = v.map((w) => {
        if (!isObj(w)) return w;
        const o: Record<string, unknown> = {};
        for (const key of WINDOW_KEEP) if (key in w) o[key] = w[key];
        return o;
      });
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** The inputs exactly as stored: slim (slimInputs), floats at STORED_DIGITS. */
export function storedInputs(inputs: unknown): unknown {
  return roundDeep(slimInputs(inputs));
}

const roundCol = (n: number | null): number | null => (n === null ? null : storedNumber(n));

/** A metric row's stored columns: rate, σ and days left at STORED_DIGITS, inputs as storedInputs. */
export function storedMetric<M extends { rate: number | null; sigma: number | null; daysLeft: number | null; inputs: unknown }>(m: M): M {
  return { ...m, rate: roundCol(m.rate), sigma: roundCol(m.sigma), daysLeft: roundCol(m.daysLeft), inputs: storedInputs(m.inputs) };
}

/** JSON with object keys sorted (the hash must not depend on key order). */
export function stableJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

export type MetricContent = {
  rate: number | null;
  sigma: number | null;
  daysLeft: number | null;
  neverRunsOut: boolean;
  status: string;
  role: string;
  orderQty: number | null;
  orderBy: Date | null;
  inputs: unknown;
};

/** The text hashed for a metric row's content: every stored column but computedAt (inputs already slim). */
export function metricContentText(m: MetricContent): string {
  return stableJson([m.rate, m.sigma, m.daysLeft, m.neverRunsOut, m.status, m.role, m.orderQty, m.orderBy ? m.orderBy.toISOString().slice(0, 10) : null, m.inputs]);
}
