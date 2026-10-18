/**
 * VariantBacktest / BacktestRun reads and writes for compute (perf 2026-10-18,
 * lib/backtest-cache-shared). A cache: compute treats every failure here as "no cache" (it reads
 * the facts and runs the backtest as before), never as a failed run.
 */
import prisma from "../db.server";
import type { AbcRole } from "../lib/engine/index-shared";
import type { BacktestCache } from "../lib/backtest-cache-shared";
import { slices } from "../lib/concurrency-shared";
import { dayDate } from "../lib/sync/facts-shared";

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const WRITE_BATCH = 500;

export type BacktestRow = BacktestCache & { variantId: string };

/** The cache rows of `ids` (missing = none). */
export async function readBacktests(shop: string, ids: readonly string[]): Promise<Map<string, BacktestCache>> {
  const out = new Map<string, BacktestCache>();
  for (const part of slices(ids, 1000)) {
    const rows = await prisma.variantBacktest.findMany({ where: { shop, variantId: { in: part } } });
    for (const r of rows)
      out.set(r.variantId, {
        day: dayKey(r.day),
        horizon: r.horizon,
        scopeKey: r.scopeKey,
        backtested: r.backtested,
        ratio: r.ratio,
        windows: r.windows,
        samples: r.samples,
        bias: r.bias,
        history: r.history,
      });
  }
  return out;
}

/** Every stored backtest ratio of a shop (no history rows): the roles' pooled ratios (item 6). */
export async function storedBacktestRatios(shop: string): Promise<Map<string, Pick<BacktestCache, "day" | "horizon" | "scopeKey" | "backtested" | "ratio">>> {
  const rows = await prisma.variantBacktest.findMany({
    where: { shop },
    select: { variantId: true, day: true, horizon: true, scopeKey: true, backtested: true, ratio: true },
  });
  return new Map(rows.map((r) => [r.variantId, { day: dayKey(r.day), horizon: r.horizon, scopeKey: r.scopeKey, backtested: r.backtested, ratio: r.ratio }]));
}

/** Replaces the rows of these variants (one transaction per WRITE_BATCH). */
export async function writeBacktests(shop: string, rows: readonly BacktestRow[]): Promise<void> {
  for (const part of slices(rows, WRITE_BATCH)) {
    await prisma.$transaction([
      prisma.variantBacktest.deleteMany({ where: { shop, variantId: { in: part.map((r) => r.variantId) } } }),
      prisma.variantBacktest.createMany({
        data: part.map((r) => ({
          shop,
          variantId: r.variantId,
          day: dayDate(r.day),
          horizon: r.horizon,
          scopeKey: r.scopeKey,
          backtested: r.backtested,
          ratio: r.ratio,
          windows: r.windows,
          samples: r.samples,
          bias: r.bias,
          history: r.history,
        })),
        skipDuplicates: true,
      }),
    ]);
  }
}

export type BacktestRunRow = { day: string; scopeKey: string; priors: Map<AbcRole, number> };

export async function readBacktestRun(shop: string): Promise<BacktestRunRow | null> {
  const r = await prisma.backtestRun.findUnique({ where: { shop } });
  if (!r) return null;
  return { day: dayKey(r.day), scopeKey: r.scopeKey, priors: new Map<AbcRole, number>([["A", r.priorA], ["B", r.priorB], ["C", r.priorC]]) };
}

export async function writeBacktestRun(shop: string, run: BacktestRunRow): Promise<void> {
  const data = { day: dayDate(run.day), scopeKey: run.scopeKey, priorA: run.priors.get("A") ?? 1, priorB: run.priors.get("B") ?? 1, priorC: run.priors.get("C") ?? 1 };
  await prisma.backtestRun.upsert({ where: { shop }, create: { shop, ...data }, update: data });
}
