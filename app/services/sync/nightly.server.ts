/**
 * Nightly sync (spec §6.6; task 1.4b, review H3/H4): at or after 03:00 store-local, once per
 * store-local day (marker: the local date of Shop.lastNightlyAt), only once the backfill has
 * finished.
 *
 *   locations → for EACH history dataset (stock, sales, visits, totals) independently: the
 *   days after its own syncedThrough up to YESTERDAY (normally one day; a missed night is
 *   caught up, at most CATCH_UP_DAYS) → catalog bulk refresh → stock now → compute →
 *   retention → lastNightlyAt.
 *
 * A dataset that fails records its error and is retried from its own syncedThrough next
 * night; the others and the rest of the run carry on ("partial"). A throttle (or the tick's
 * throttle-wait budget) stops the run without setting lastNightlyAt, so the next hourly tick
 * retries; every write is idempotent. Never throws.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { syncCatalog, syncLocations, syncStockNow } from "./catalog.server";
import { createShopifyqlClient, monthChunks } from "./shopifyql.server";
import { applyRetention, loadLocations, storeHistory } from "./facts.server";
import type { DataJobDeps } from "./backfill.server";
import {
  HISTORY_DATASETS,
  clearError,
  failStep,
  isBackfillDone,
  readBackfillState,
  type BackfillState,
  type SyncDataset,
} from "../../lib/sync/backfill-shared";
import { isNightlyDue, localDate, localYesterday, safeTimeZone } from "../../lib/sync/store-time-shared";
import { addDays } from "../../lib/sync/shopifyql-shared";
import { isThrottle, syncErrorCode } from "../../lib/sync/errors-shared";

/** A store offline longer than this restarts its history at yesterday − CATCH_UP_DAYS. */
export const CATCH_UP_DAYS = 62;

export type NightlyOutcome = "not_due" | "skipped" | "done" | "partial" | "throttled" | "error";

/** The days the nightly run must fetch: after syncedThrough up to yesterday (capped). */
export function nightlyRange(syncedThrough: string | null | undefined, yesterday: string): { since: string; until: string } | null {
  const floor = addDays(yesterday, -(CATCH_UP_DAYS - 1));
  let since = syncedThrough ? addDays(syncedThrough, 1) : yesterday;
  if (since < floor) since = floor;
  return since > yesterday ? null : { since, until: yesterday };
}

export async function runNightly(shop: string, deps: DataJobDeps): Promise<NightlyOutcome> {
  const now = deps.now ?? Date.now;
  const at = new Date(now());
  const row = await prisma.shop.findUnique({
    where: { domain: shop },
    select: { timezone: true, lastNightlyAt: true, backfillState: true, uninstalledAt: true },
  });
  if (!row || row.uninstalledAt) return "skipped";
  let state: BackfillState = readBackfillState(row.backfillState);
  if (!isBackfillDone(state)) return "skipped";
  const tz = safeTimeZone(row.timezone);
  if (!isNightlyDue(at, tz, row.lastNightlyAt)) return "not_due";

  const today = localDate(at, tz);
  const yesterday = localYesterday(at, tz);
  const save = (s: BackfillState) =>
    prisma.shop.update({ where: { domain: shop }, data: { backfillState: s as Prisma.InputJsonValue } });
  const fail = (dataset: SyncDataset, e: unknown) => {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    state = failStep(state, dataset, `nightly: ${msg}`, at.toISOString(), { countAttempt: !isThrottle(e), code: syncErrorCode(e) }).state;
  };
  const stopThrottled = async (e: unknown): Promise<NightlyOutcome> => {
    await save(state).catch(() => {});
    console.warn(`[sync/nightly] ${shop}: throttled (${e instanceof Error ? e.message : String(e)}), retrying on the next tick`);
    return "throttled";
  };

  let partial = false;
  let admin;
  try {
    admin = await deps.getAdmin(shop);
    await syncLocations(admin, shop);
  } catch (e) {
    fail("products", e);
    await save(state).catch(() => {});
    if (isThrottle(e)) return stopThrottled(e);
    console.error(`[sync/nightly] ${shop}: admin / locations failed`, e);
    return "error";
  }
  const throttleSleep = deps.throttleSleep ?? deps.sleep;
  const ql = (deps.shopifyql ?? ((a) => createShopifyqlClient(a, { sleep: throttleSleep, now: deps.now })))(admin);
  const locations = await loadLocations(shop);

  for (const ds of HISTORY_DATASETS) {
    const p = state.datasets?.[ds];
    const range = nightlyRange(p?.syncedThrough ?? state.syncedThrough, yesterday);
    if (!range) continue;
    try {
      for (const chunk of monthChunks(range.since, range.until)) {
        await storeHistory(ds, shop, ql, chunk, today, locations);
      }
      state = clearError(state, ds);
      state = { ...state, datasets: { ...state.datasets, [ds]: { done: 0, total: 0, ...state.datasets?.[ds], syncedThrough: range.until } } };
      await save(state);
    } catch (e) {
      fail(ds, e);
      if (isThrottle(e)) return stopThrottled(e);
      partial = true;
      await save(state).catch(() => {});
      console.error(`[sync/nightly] ${shop} ${ds} (${syncErrorCode(e)})`, e);
    }
  }
  const allThrough = HISTORY_DATASETS.map((d) => state.datasets?.[d]?.syncedThrough ?? null);
  if (allThrough.every((d) => d !== null)) state = { ...state, syncedThrough: allThrough.reduce((a, b) => (a! < b! ? a : b)) };

  try {
    await syncCatalog(admin, shop, deps);
    await syncStockNow(admin, shop, deps);
    state = clearError(state, "products");
  } catch (e) {
    fail("products", e);
    if (isThrottle(e)) return stopThrottled(e);
    partial = true;
    console.error(`[sync/nightly] ${shop} products (${syncErrorCode(e)})`, e);
  }

  if (deps.afterSync) {
    // A compute failure must not re-run the whole sync: it is logged, the facts stay.
    await deps.afterSync(shop).catch((e) => console.error(`[sync/nightly] ${shop}: compute failed`, e));
  }

  try {
    const removed = await applyRetention(shop, today);
    if (removed) console.log(`[sync/nightly] ${shop}: retention removed ${removed} row(s)`);
  } catch (e) {
    console.error(`[sync/nightly] ${shop}: retention failed`, e);
  }
  await prisma.shop.update({
    where: { domain: shop },
    data: { lastNightlyAt: at, backfillState: state as Prisma.InputJsonValue },
  });
  return partial ? "partial" : "done";
}
