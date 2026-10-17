/**
 * Weekly sales re-check (owner 2026-10-18; the rules and the pure logic are in
 * lib/sync/weekly-recheck-shared). One `recheck` job per shop per week on the job queue:
 *
 *   ShopifyQL daily units total for the last 35 days (one cheap query) → the stored daily units
 *   (channel view) → the days that differ → each run of such days re-read and rewritten with the
 *   normal idempotent sales write (facts.server storeHistory "sales": reconciled, the range's
 *   rows replaced, stored first / last sale days kept current) → compute queued when a day
 *   changed → the summary kept in Shop.backfillState.weeklyRecheck and logged.
 *
 * Only after the backfill has finished; never today; a throttle stops the run (the job is queued
 * again in five minutes, nothing recorded); any other failure is recorded and logged, never
 * thrown. `recheckTick` (hourly, from the scheduler) queues the shops whose hour has come.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { facts } from "../facts-store.server";
import { createShopifyqlClient } from "./shopifyql.server";
import { loadLocations, storeHistory } from "./facts.server";
import type { DataJobDeps } from "./backfill.server";
import { isBackfillDone, readBackfillState } from "../../lib/sync/backfill-shared";
import { localDate, localYesterday, safeTimeZone } from "../../lib/sync/store-time-shared";
import { ALL, dayDate } from "../../lib/sync/facts-shared";
import type { DayRange } from "../../lib/sync/shopifyql-shared";
import { isThrottle, syncErrorCode } from "../../lib/sync/errors-shared";
import { createSleepBudget, THROTTLE_BUDGET_MS } from "../../lib/sync/budget-shared";
import { NIGHTLY_THROTTLED_RETRY_MS } from "../../lib/jobs-shared";
import { slices } from "../../lib/concurrency-shared";
import {
  dayRuns,
  differingDays,
  isRecheckDue,
  readWeeklyRecheck,
  recheckRange,
  recheckSummary,
  type WeeklyRecheck,
} from "../../lib/sync/weekly-recheck-shared";
import { enqueueJob } from "../jobs/queue.server";
import type { JobHandler } from "../jobs/worker.server";

export type RecheckOutcome = "skipped" | "unchanged" | `corrected:${number}` | "throttled" | "error";

const dayKey = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Stored units per day in the range (channel view, the one reconciled against the total). */
export async function storedDailyUnits(shop: string, range: DayRange): Promise<Map<string, number>> {
  const rows = await facts.salesDaily.groupBy({
    by: ["day"],
    where: { shop, locationKey: ALL, day: { gte: dayDate(range.since), lte: dayDate(range.until) } },
    _sum: { sold: true },
  });
  const out = new Map<string, number>();
  for (const r of rows) out.set(dayKey(r.day), Number(r._sum.sold ?? 0));
  return out;
}

async function record(shop: string, state: unknown, r: WeeklyRecheck): Promise<void> {
  await prisma.shop.update({
    where: { domain: shop },
    data: { backfillState: { ...(readBackfillState(state) as object), weeklyRecheck: r } as Prisma.InputJsonValue },
  });
}

export async function runWeeklyRecheck(shop: string, deps: DataJobDeps): Promise<RecheckOutcome> {
  const at = new Date((deps.now ?? Date.now)());
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { timezone: true, backfillState: true, uninstalledAt: true } });
  if (!row || row.uninstalledAt) return "skipped";
  const state = readBackfillState(row.backfillState);
  if (!isBackfillDone(state)) return "skipped";
  const tz = safeTimeZone(row.timezone);
  const today = localDate(at, tz);
  const range = recheckRange(localYesterday(at, tz), state.datasets?.sales?.syncedThrough ?? state.syncedThrough);
  if (!range) return "skipped";
  const base = { at: at.toISOString(), since: range.since, until: range.until };
  try {
    const admin = await deps.getAdmin(shop);
    const ql = (deps.shopifyql ?? ((a) => createShopifyqlClient(a, { sleep: deps.throttleSleep ?? deps.sleep, now: deps.now })))(admin);
    const totals = await ql.salesTotalsDaily(range, today);
    const shopify = new Map<string, number>();
    for (const t of totals.rows) shopify.set(t.day, (shopify.get(t.day) ?? 0) + t.sold);
    const before = await storedDailyUnits(shop, range);
    const differ = differingDays(before, shopify, range);
    if (!differ.length) {
      await record(shop, row.backfillState, { ...base, outcome: "done", differing: 0, ...recheckSummary(before, before, range) });
      return "unchanged";
    }
    const locations = await loadLocations(shop);
    for (const run of dayRuns(differ)) await storeHistory("sales", shop, ql, run, today, locations);
    const after = await storedDailyUnits(shop, range);
    const summary = recheckSummary(before, after, range);
    await record(shop, row.backfillState, { ...base, outcome: "done", differing: differ.length, ...summary });
    console.log(
      `[sync/recheck] ${shop} ${range.since}..${range.until}: ${differ.length} day(s) differed from Shopify, ${summary.corrected} corrected ` +
        `(units ${summary.unitsBefore} → ${summary.unitsAfter}, ${(summary.share * 100).toFixed(1)}% changed)`,
    );
    if (summary.corrected > 0 && deps.afterSync) await deps.afterSync(shop);
    return `corrected:${summary.corrected}`;
  } catch (e) {
    if (isThrottle(e)) {
      console.warn(`[sync/recheck] ${shop}: throttled, retrying later`);
      return "throttled";
    }
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[sync/recheck] ${shop} (${syncErrorCode(e)}): ${msg}`);
    await record(shop, row.backfillState, {
      ...base,
      outcome: "error",
      differing: 0,
      corrected: 0,
      unitsBefore: 0,
      unitsAfter: 0,
      changed: 0,
      share: 0,
      error: msg.slice(0, 200),
    }).catch(() => {});
    return "error";
  }
}

/** The job handler (jobs/handlers.server): throttle-wait budget, compute queued, throttled → again in 5 min. */
export function recheckJob(base: Pick<DataJobDeps, "getAdmin" | "shopifyql" | "now"> & { sleep?: (ms: number) => Promise<void> }): JobHandler {
  return async (job) => {
    const sleep = base.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const out = await runWeeklyRecheck(job.shop, {
      ...base,
      sleep,
      throttleSleep: createSleepBudget(sleep, THROTTLE_BUDGET_MS).sleep,
      afterSync: async (shop) => void (await enqueueJob(shop, "compute")),
    });
    if (out === "throttled") await enqueueJob(job.shop, "recheck", NIGHTLY_THROTTLED_RETRY_MS);
    return out;
  };
}

/** Hourly: queues `recheck` for every installed, fully read shop whose hour of the week has come. Never throws. */
export async function recheckTick(now: Date = new Date()): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const add = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  try {
    const shops = (await prisma.session.findMany({ distinct: ["shop"], select: { shop: true } })).map((s) => s.shop);
    for (const chunk of slices(shops, 5000)) {
      const rows = await prisma.shop.findMany({ where: { domain: { in: chunk } }, select: { domain: true, backfillState: true, uninstalledAt: true } });
      for (const r of rows) {
        if (r.uninstalledAt || !isBackfillDone(readBackfillState(r.backfillState))) add("skipped");
        else if (!isRecheckDue(r.domain, readWeeklyRecheck(r.backfillState), now)) add("not_due");
        else add((await enqueueJob(r.domain, "recheck")) ? "queued" : "error");
      }
    }
  } catch (e) {
    add("error");
    console.error("[scheduler/recheck]", e);
  }
  if (counts.queued || counts.error) console.log(`[scheduler/recheck] ${JSON.stringify(counts)}`);
  return counts;
}
