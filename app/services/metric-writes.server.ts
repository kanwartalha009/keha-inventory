/**
 * VariantMetric writes for compute and compute-locations (DB scale "before 1,000 stores"): no
 * nightly delete + rewrite of every row. Per batch of METRIC_WRITE_BATCH variants of one scope:
 * the stored content hashes are read, and only the rows whose content changed (or are new) are
 * replaced — one transaction of deleteMany + createMany for those. Unchanged rows are not touched
 * (no dead tuples, no index churn, no WAL); their computedAt stays at the run that last changed
 * them. The stored inputs are slimmed first (lib/metric-store-shared): only what readers use.
 *
 * A run is identified by (shop, scope, computedAt = the run's start). Every variant written or
 * confirmed by the run is remembered; sweepVariantMetrics(shop, scope, startedAt) — called where
 * the old "computedAt < startedAt" sweep was — removes the rows of variants the run no longer
 * computes, and MetricRun records the run (started, finished, rows confirmed, rows changed): the
 * freshness checks and the order-plan cache read MetricRun (latestMetricRun), not computedAt.
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { metricContentText, slimInputs } from "../lib/metric-store-shared";
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

type RunState = { ids: Set<string>; rows: number; changed: number };
const g = globalThis as unknown as { __kehaMetricRuns?: Map<string, RunState> };
/** Runs in progress in this process: shop|scope|startedAt → what they confirmed. */
const runs: Map<string, RunState> = (g.__kehaMetricRuns ??= new Map());
const runKey = (shop: string, scope: string, startedAt: Date) => `${shop}|${scope}|${startedAt.getTime()}`;

/** sha1 of the content text, 16 hex characters. */
function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

async function recordRun(shop: string, scope: string, startedAt: Date, state: RunState, finishedAt: Date | null): Promise<void> {
  const data = { startedAt, finishedAt, rows: state.rows, changed: state.changed };
  await prisma.metricRun.upsert({ where: { shop_scope: { shop, scope } }, create: { shop, scope, ...data }, update: data });
}

/** Writes one scope's rows of a run (all rows share computedAt = the run's start). Returns the rows changed. */
export async function writeVariantMetrics(shop: string, scope: string, rows: readonly MetricData[]): Promise<number> {
  if (!rows.length) return 0;
  let changedTotal = 0;
  for (let i = 0; i < rows.length; i += METRIC_WRITE_BATCH) {
    const batch = rows.slice(i, i + METRIC_WRITE_BATCH).map((r) => {
      const inputs = slimInputs(r.inputs) as Prisma.InputJsonValue;
      return { ...r, inputs, contentHash: hashOf(metricContentText({ ...r, inputs })) };
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
    const startedAt = batch[0]!.computedAt;
    const key = runKey(shop, scope, startedAt);
    const state = runs.get(key) ?? runs.set(key, { ids: new Set(), rows: 0, changed: 0 }).get(key)!;
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
  const state = runs.get(key) ?? { ids: new Set<string>(), rows: 0, changed: 0 };
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
