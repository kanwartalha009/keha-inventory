/**
 * The order plan's inputs as typed VariantMetric columns (perf 2026-10-18, "before 1,000 stores" #8).
 * Pure.
 *
 * The order plan read every metric with something to order AND its inputs JSON (~2 KB, the 53-week
 * seasonal curve the largest part): ~20,000 rows on a 30,000-variant store, ~0.3–0.45 s of
 * database time per load. Now compute also writes, beside `inputs`, exactly the fields the forward
 * plan, the Keha "since the run" rule and the order plan read (planColumnsOf): numbers and dates as
 * columns, the small structured bits (dated arrivals, Keha orders, the Why's figures) as one small
 * JSON, and the seasonal curve once per run and shape (MetricRun.curves, keyed by planCurveKey:
 * every variant of a season group has the same curve). The order plan selects those and rebuilds
 * the subset of `inputs` it reads (planInputsOf) — the same values, so the same plan (tests); rows
 * written before the columns existed (planVersion null) are read the old way. `inputs` stays the
 * full record for the product page and every other reader.
 */
import { stableJson } from "./metric-store-shared";

/** Bump when the columns' meaning changes: rows of an older version are rewritten (content hash) and read the old way meanwhile. */
export const PLAN_COLUMNS_VERSION = 1;

/** The inputs keys the order plan reads (forward-plan-shared forwardInputFromMetric, keha-since-run-shared, order-plan.server). */
export const PLAN_NUMBER_KEYS = {
  planSafety: "safety",
  planSeasonal: "seasonal",
  planTrend: "trend",
  planPlan: "plan",
  planLeadDays: "leadTimeDays",
  planCycleDays: "cycleDays",
  planOnHand: "onHand",
  planIncoming: "incoming",
  planNeed: "orderNeed",
  planZ: "z",
} as const;
type NumberColumn = keyof typeof PLAN_NUMBER_KEYS;

/** inputs keys kept in planExtra as they are (small). */
export const PLAN_EXTRA_KEYS = ["arrivals", "kehaOnOrder", "kehaLanded", "kehaOrders", "pace", "spikes", "planLike", "levelShift", "error"] as const;

export type PlanColumns = { [K in NumberColumn]: number | null } & {
  planOutSince: Date | null;
  planSellsWhenOut: boolean | null;
  planCurveKey: string | null;
  planExtra: Record<string, unknown> | null;
  planVersion: number;
};

/** A run's seasonal curves by key: the day they were computed on (inputs.today) and the weekly shape. */
export type PlanCurve = { today: string; curve: unknown[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** 16 hex characters of FNV-1a ×2 over the text (no crypto: also runs in the browser bundle's tests). */
function shortHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** The curve key of stored inputs (null without a curve): the shape and the day it starts from. */
export function curveOf(inputs: unknown): { key: string; curve: PlanCurve } | null {
  if (!isObj(inputs) || !Array.isArray(inputs.seasonCurve)) return null;
  const today = typeof inputs.today === "string" ? inputs.today : "";
  const curve: PlanCurve = { today, curve: inputs.seasonCurve };
  return { key: shortHash(stableJson(curve)), curve };
}

/** The typed columns for stored inputs (lib/metric-store-shared storedInputs). */
export function planColumnsOf(inputs: unknown): PlanColumns {
  const r = isObj(inputs) ? inputs : {};
  const out = {} as PlanColumns;
  for (const [col, key] of Object.entries(PLAN_NUMBER_KEYS) as [NumberColumn, string][]) out[col] = finiteOrNull(r[key]);
  out.planOutSince = typeof r.outSince === "string" && DAY.test(r.outSince) ? new Date(`${r.outSince}T00:00:00.000Z`) : null;
  out.planSellsWhenOut = typeof r.sellsWhenOut === "boolean" ? r.sellsWhenOut : null;
  out.planCurveKey = curveOf(r)?.key ?? null;
  const extra: Record<string, unknown> = {};
  for (const k of PLAN_EXTRA_KEYS) if (k in r && r[k] !== undefined) extra[k] = r[k];
  out.planExtra = Object.keys(extra).length ? extra : null;
  out.planVersion = PLAN_COLUMNS_VERSION;
  return out;
}

/**
 * The inputs subset the order plan reads, rebuilt from the columns and the run's curves. null when
 * the row was written without them (older version) or its curve is not in `curves` (read inputs).
 */
export function planInputsOf(
  row: { [K in NumberColumn]?: number | null } & { planOutSince?: Date | null; planSellsWhenOut?: boolean | null; planCurveKey?: string | null; planExtra?: unknown; planVersion?: number | null },
  curves: ReadonlyMap<string, PlanCurve>,
): Record<string, unknown> | null {
  if (row.planVersion !== PLAN_COLUMNS_VERSION) return null;
  const out: Record<string, unknown> = {};
  for (const [col, key] of Object.entries(PLAN_NUMBER_KEYS) as [NumberColumn, string][]) {
    const v = row[col];
    if (typeof v === "number") out[key] = v;
  }
  if (row.planOutSince instanceof Date) out.outSince = row.planOutSince.toISOString().slice(0, 10);
  if (typeof row.planSellsWhenOut === "boolean") out.sellsWhenOut = row.planSellsWhenOut;
  if (isObj(row.planExtra)) Object.assign(out, row.planExtra);
  if (row.planCurveKey) {
    const c = curves.get(row.planCurveKey);
    if (!c) return null;
    out.seasonCurve = c.curve;
    if (c.today) out.today = c.today;
  }
  return out;
}

/** MetricRun.curves read defensively. */
export function readCurves(raw: unknown): Map<string, PlanCurve> {
  const out = new Map<string, PlanCurve>();
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (isObj(v) && Array.isArray(v.curve)) out.set(k, { today: typeof v.today === "string" ? v.today : "", curve: v.curve });
  return out;
}
