/**
 * Nightly sync (spec §6.6; task 1.4b): at or after 03:00 store-local, once per store-local
 * day (marker: the local date of Shop.lastNightlyAt), only once the backfill has finished.
 *
 *   locations → history from the day after state.syncedThrough up to YESTERDAY (normally one
 *   day; a missed night is caught up, at most CATCH_UP_DAYS) for stock, sales (+ totals) and
 *   visits → catalog bulk refresh → stock now → compute → retention → lastNightlyAt.
 *
 * Throttled or failed: lastNightlyAt is not set, so the next hourly tick retries the same
 * day (every write is idempotent). Never throws.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { syncCatalog, syncLocations, syncStockNow } from "./catalog.server";
import { createShopifyqlClient, monthChunks } from "./shopifyql.server";
import { applyRetention, loadLocations, storeHistory } from "./facts.server";
import type { DataJobDeps } from "./backfill.server";
import {
  HISTORY_DATASETS,
  clearErrors,
  failStep,
  isBackfillDone,
  readBackfillState,
  type BackfillState,
  type Dataset,
} from "../../lib/sync/backfill-shared";
import { isNightlyDue, localDate, localYesterday, safeTimeZone } from "../../lib/sync/store-time-shared";
import { addDays, ShopifyqlThrottledError } from "../../lib/sync/shopifyql-shared";

/** A store offline longer than this restarts its history at yesterday − CATCH_UP_DAYS. */
export const CATCH_UP_DAYS = 62;

export type NightlyOutcome = "not_due" | "skipped" | "done" | "throttled" | "error";

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

  let dataset: Dataset = "products";
  try {
    const admin = await deps.getAdmin(shop);
    const ql = (deps.shopifyql ?? ((a) => createShopifyqlClient(a, { sleep: deps.sleep, now: deps.now })))(admin);
    await syncLocations(admin, shop);

    const range = nightlyRange(state.syncedThrough, yesterday);
    if (range) {
      const locations = await loadLocations(shop);
      for (const chunk of monthChunks(range.since, range.until)) {
        for (const ds of HISTORY_DATASETS) {
          dataset = ds;
          await storeHistory(ds, shop, ql, chunk, today, locations);
        }
      }
      state = { ...state, syncedThrough: range.until };
      await save(state);
    }

    dataset = "products";
    await syncCatalog(admin, shop, deps);
    await syncStockNow(admin, shop, deps);

    if (deps.afterSync) {
      // A compute failure must not re-run the whole sync: it is logged, the facts stay.
      await deps.afterSync(shop).catch((e) => console.error(`[sync/nightly] ${shop}: compute failed`, e));
    }

    const removed = await applyRetention(shop, today);
    if (removed) console.log(`[sync/nightly] ${shop}: retention removed ${removed} row(s)`);
    await prisma.shop.update({
      where: { domain: shop },
      data: { lastNightlyAt: at, backfillState: clearErrors(state) as Prisma.InputJsonValue },
    });
    return "done";
  } catch (e) {
    const throttled = e instanceof ShopifyqlThrottledError;
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    await save(failStep(state, dataset, `nightly: ${msg}`, at.toISOString())).catch(() => {});
    if (throttled) console.warn(`[sync/nightly] ${shop}: ShopifyQL throttled, retrying on the next tick`);
    else console.error(`[sync/nightly] ${shop} ${dataset}`, e);
    return throttled ? "throttled" : "error";
  }
}
