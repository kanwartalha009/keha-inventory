/**
 * VariantMetric writes for compute and compute-locations (DB scale "before 1,000 stores"): no
 * nightly delete + rewrite of every row. Per batch of METRIC_WRITE_BATCH variants of one scope:
 * the stored content hashes are read, and only the rows whose content changed (or are new) are
 * replaced — one transaction of deleteMany + createMany for those. Unchanged rows are not touched
 * (no dead tuples, no index churn, no WAL); their computedAt stays at the run that last changed
 * them. The stored inputs are slimmed first (lib/metric-store-shared): only what readers use, and
 * floats are kept at 12 significant digits (storedMetric) so float noise never counts as a change.
 *
 * A run is identified by (shop, scope, computedAt = the run's start). Every variant written or
 * confirmed by the run is remembered; sweepVariantMetrics(shop, scope, startedAt) — called where
 * the old "computedAt < startedAt" sweep was — removes the rows of variants the run no longer
 * computes, and MetricRun records the run (started, finished, rows confirmed, rows changed): the
 * freshness checks and the order-plan cache read MetricRun (latestMetricRun), not computedAt.
 *
 * Perf 2026-10-18 (#8): each row also gets the order plan's typed columns (lib/plan-columns-shared
 * planColumnsOf, derived from the stored inputs) and MetricRun.curves the run's seasonal curves by
 * key — while a run is being written, the previous run's curves are kept beside them (rows not
 * rewritten yet still point at them); at the sweep exactly this run's remain. The column format's
 * version is part of the content hash, so a new version rewrites every row once.
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { metricContentText, storedMetric } from "../lib/metric-store-shared";
import { PLAN_COLUMNS_VERSION, curveOf, planColumnsOf, readCurves, type PlanCurve } from "../lib/plan-columns-shared";
import { slices } from "../lib/concurrency-shared";

export const METRIC_WRITE_BATCH = 1000;

export type MetricData = {
  variantId: string;
  rate: number | null;
  sigma: number | null;
  daysLeft: number | null;
  neverRunsOut: boolean;
  status: string;
  role: string;
  orderQty: number | null;
  orderBy: Date | null;
  computedAt: Date;
  inputs: Prisma.InputJsonValue;
};

type RunState = {
  ids: Set<string>;
  rows: number;
  changed: number;
  /** This run's curves by key, and the previous run's (kept until the sweep); null = not read yet. */
  curves: Map<string, PlanCurve>;
  prevCurves: Map<string, PlanCurve> | null;
  curvesDirty: boolean;
};
const g = globalThis as unknown as { __kehaMetricRuns?: Map<string, RunState> };
/** Runs in progress in this process: shop|scope|startedAt → what they confirmed. */
const runs: Map<string, RunState> = (g.__kehaMetricRuns ??= new Map());
const runKey = (shop: string, scope: string, startedAt: Date) => `${shop}|${scope}|${startedAt.getTime()}`;

/** sha1 of the content text, 16 hex characters. */
function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

const curvesJson = (...maps: ReadonlyMap<string, PlanCurve>[]) => {
  const out: Record<string, PlanCurve> = {};
  for (const m of maps) for (const [k, v] of m) out[k] = v;
  return out as unknown as Prisma.InputJsonValue;
};

async function recordRun(shop: string, scope: string, startedAt: Date, state: RunState, finishedAt: Date | null): Promise<void> {
  // The curves: written when new ones came in (during the run, with the previous run's) and at the end (this run's only).
  const curves = finishedAt ? { curves: curvesJson(state.curves) } : state.curvesDirty ? { curves: curvesJson(state.prevCurves ?? new Map(), state.curves) } : {};
  state.curvesDirty = false;
  const data = { startedAt, finishedAt, rows: state.rows, changed: state.changed, ...curves };
  await prisma.metricRun.upsert({ where: { shop_scope: { shop, scope } }, create: { shop, scope, ...data }, update: data });
}

const newRun = (): RunState => ({ ids: new Set(), rows: 0, changed: 0, curves: new Map(), prevCurves: null, curvesDirty: false });

/** Writes one scope's rows of a run (all rows share computedAt = the run's start). Returns the rows changed. */
export async function writeVariantMetrics(shop: string, scope: string, rows: readonly MetricData[]): Promise<number> {
  if (!rows.length) return 0;
  let changedTotal = 0;
  const startedAt = rows[0]!.computedAt;
  const key = runKey(shop, scope, startedAt);
  const state = runs.get(key) ?? runs.set(key, newRun()).get(key)!;
  if (state.prevCurves === null) {
    const prev = await prisma.metricRun.findUnique({ where: { shop_scope: { shop, scope } }, select: { startedAt: true, curves: true } });
    state.prevCurves = prev && prev.startedAt.getTime() !== startedAt.getTime() ? readCurves(prev.curves) : new Map();
  }
  for (let i = 0; i < rows.length; i += METRIC_WRITE_BATCH) {
    const batch = rows.slice(i, i + METRIC_WRITE_BATCH).map((r) => {
      // What is stored (slim inputs, floats at STORED_DIGITS) is what is hashed (perf 2026-10-18),
      // with the order plan's columns derived from it (their format version in the hash).
      const s = storedMetric(r);
      const plan = planColumnsOf(s.inputs);
      const c = curveOf(s.inputs);
      if (c && !state.curves.has(c.key)) {
        state.curves.set(c.key, c.curve);
        state.curvesDirty = true;
      }
      const inputs = s.inputs as Prisma.InputJsonValue;
      return { ...s, inputs, ...plan, planExtra: plan.planExtra as Prisma.InputJsonValue, contentHash: hashOf(`p${PLAN_COLUMNS_VERSION}|${metricContentText({ ...s, inputs })}`) };
    });
    const ids = batch.map((r) => r.variantId);
    const stored = await prisma.variantMetric.findMany({ where: { shop, scope, variantId: { in: ids } }, select: { variantId: true, contentHash: true } });
    const have = new Map(stored.map((s) => [s.variantId, s.contentHash]));
    const changed = batch.filter((r) => have.get(r.variantId) !== r.contentHash);
    if (changed.length) {
      await prisma.$transaction([
        prisma.variantMetric.deleteMany({ where: { shop, scope, variantId: { in: changed.map((r) => r.variantId) } } }),
        prisma.variantMetric.createMany({ data: changed.map((r) => ({ shop, scope, ...r })), skipDuplicates: true }),
      ]);
    }
    changedTotal += changed.length;
    // The run: every variant written or confirmed, so the sweep keeps them.
    for (const id of ids) state.ids.add(id);
    state.rows = state.ids.size;
    state.changed += changed.length;
    await recordRun(shop, scope, startedAt, state, null);
  }
  return changedTotal;
}

/**
 * End of a run for one scope: rows of variants it did not write or confirm are removed (no longer
 * tracked, archived, gone), and MetricRun is marked finished. Returns the rows removed.
 */
export async function sweepVariantMetrics(shop: string, scope: string, startedAt: Date, now: Date = new Date()): Promise<number> {
  const key = runKey(shop, scope, startedAt);
  const state = runs.get(key) ?? newRun();
  runs.delete(key);
  const existing = await prisma.variantMetric.findMany({ where: { shop, scope }, select: { variantId: true } });
  const stale = existing.map((r) => r.variantId).filter((id) => !state.ids.has(id));
  let removed = 0;
  for (const chunk of slices(stale, METRIC_WRITE_BATCH)) {
    removed += (await prisma.variantMetric.deleteMany({ where: { shop, scope, variantId: { in: chunk } } })).count;
  }
  // Nothing left in the scope (no variant computed there any more): no run to report either.
  if (state.rows) await recordRun(shop, scope, startedAt, state, now);
  else await prisma.metricRun.deleteMany({ where: { shop, scope } });
  return removed;
}

/**
 * When the latest compute run of a scope started (freshness checks): MetricRun, or — for rows
 * written before it existed — the newest computedAt. null = never computed.
 */
export async function latestMetricRun(shop: string, scope: string): Promise<Date | null> {
  const run = await prisma.metricRun.findUnique({ where: { shop_scope: { shop, scope } }, select: { startedAt: true } });
  if (run?.startedAt) return run.startedAt;
  const agg = await prisma.variantMetric.aggregate({ where: { shop, scope }, _max: { computedAt: true } });
  return agg._max.computedAt ?? null;
}

/** Tests: forget runs in progress. */
export function forgetMetricRuns(): void {
  runs.clear();
}
