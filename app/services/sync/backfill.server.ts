/**
 * Backfill (spec §4 J1, §6.2, §6.6; task 1.4b): on install and resumable from the scheduler.
 *
 *   ensureShop → catalog → locations → stock now  (dataset "products")
 *   → history: HISTORY_MONTHS calendar months ending YESTERDAY in the store's time zone,
 *     month by month NEWEST FIRST, each month stock → sales (+ store totals) → visits.
 *
 * Shop.backfillState is written after every step (durable progress: done / total /
 * doneThrough / lastError per dataset), so a restart, a throttle or an error resumes at the
 * exact step. The history window is fixed when the backfill starts (state.range).
 * first90Ready flips once the newest 3 months of stock + sales are stored; finishedAt when
 * everything is. A ShopifyQL throttle stops the run ("throttled") until the next tick.
 *
 * Never throws: kickoffBackfill (afterAuth) and the scheduler only log the outcome.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import type { AdminGraphqlClient } from "../../models/shop.server";
import { ensureShop, syncCatalog, syncLocations, syncStockNow, type SyncDeps } from "./catalog.server";
import { createShopifyqlClient, monthChunks, type ShopifyqlClient } from "./shopifyql.server";
import { loadLocations, storeHistory } from "./facts.server";
import {
  completeStep,
  failStep,
  nextBackfillStep,
  readBackfillState,
  type BackfillState,
  type BackfillStep,
} from "../../lib/sync/backfill-shared";
import { historyRange, localDate, localYesterday, safeTimeZone } from "../../lib/sync/store-time-shared";
import { ShopifyqlThrottledError } from "../../lib/sync/shopifyql-shared";

export type DataJobDeps = SyncDeps & {
  /** Admin client for the shop (offline session). The scheduler / afterAuth pass unauthenticated.admin. */
  getAdmin: (shop: string) => Promise<AdminGraphqlClient>;
  /** ShopifyQL client factory (tests inject a fake). */
  shopifyql?: (admin: AdminGraphqlClient) => ShopifyqlClient;
  /** Runs after data changed and the first 90 days are ready (compute; wired in task 1.5). */
  afterSync?: (shop: string) => Promise<void>;
  /** Stop after this many steps (tests, and to bound one tick). Default: unbounded. */
  maxSteps?: number;
};

export type BackfillOutcome = "done" | "progress" | "throttled" | "error" | "skipped";

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

async function saveState(shop: string, state: BackfillState): Promise<void> {
  await prisma.shop.update({ where: { domain: shop }, data: { backfillState: state as Prisma.InputJsonValue } });
}

/** Runs (or resumes) the backfill for one shop. */
export async function runBackfill(shop: string, deps: DataJobDeps): Promise<BackfillOutcome> {
  const now = deps.now ?? Date.now;
  const nowIso = () => new Date(now()).toISOString();
  let admin: AdminGraphqlClient;
  let tz: string;
  try {
    admin = await deps.getAdmin(shop);
    const info = await ensureShop(admin, shop);
    tz = safeTimeZone(info.timezone);
  } catch (e) {
    console.error(`[sync/backfill] ${shop}: shop read failed`, e);
    return "error";
  }

  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { backfillState: true, uninstalledAt: true } });
  if (!row || row.uninstalledAt) return "skipped";
  let state = readBackfillState(row.backfillState);
  if (state.finishedAt) return "done";
  if (!state.startedAt) state = { ...state, startedAt: nowIso() };
  if (!state.range) state = { ...state, range: historyRange(localYesterday(new Date(now()), tz)) };
  await saveState(shop, state);

  const chunks = monthChunks(state.range!.from, state.range!.until);
  const ql = (deps.shopifyql ?? ((a) => createShopifyqlClient(a, { sleep: deps.sleep, now: deps.now })))(admin);
  const wasReady = !!state.first90Ready;
  let steps = 0;
  let changed = false;
  let outcome: BackfillOutcome = "progress";

  for (;;) {
    const step: BackfillStep = nextBackfillStep(state, chunks);
    if (step.kind === "done") {
      outcome = "done";
      break;
    }
    if (deps.maxSteps !== undefined && steps >= deps.maxSteps) break;
    const dataset = step.kind === "products" ? "products" : step.dataset;
    try {
      if (step.kind === "products") {
        await syncCatalog(admin, shop, deps);
        await syncLocations(admin, shop);
        await syncStockNow(admin, shop, deps);
      } else {
        const today = localDate(new Date(now()), tz);
        const r = await storeHistory(step.dataset, shop, ql, step.range, today, await loadLocations(shop));
        if (r.unmapped.length) {
          console.warn(`[sync/backfill] ${shop} ${step.dataset} ${step.range.since}: unmatched location name(s): ${r.unmapped.join(", ")}`);
        }
      }
      state = completeStep(state, step, chunks, nowIso());
      changed = true;
      steps++;
      await saveState(shop, state);
    } catch (e) {
      state = failStep(state, dataset, errorMessage(e), nowIso());
      await saveState(shop, state).catch((err) => console.error(`[sync/backfill] ${shop}: state save failed`, err));
      outcome = e instanceof ShopifyqlThrottledError ? "throttled" : "error";
      if (outcome === "error") console.error(`[sync/backfill] ${shop} ${dataset}`, e);
      else console.warn(`[sync/backfill] ${shop}: ShopifyQL throttled, resuming on the next tick`);
      break;
    }
  }

  // First numbers as soon as the newest months are in, then again when everything is.
  if (deps.afterSync && state.first90Ready && changed && (!wasReady || outcome === "done")) {
    try {
      await deps.afterSync(shop);
    } catch (e) {
      console.error(`[sync/backfill] ${shop}: compute failed`, e);
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Install kickoff (afterAuth): non-blocking, one run per shop at a time.
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __kehaInvDataRunning?: Set<string> };
/** Shops with a data job in flight in this process (shared with the scheduler's dataTick). */
export const runningShops: Set<string> = (g.__kehaInvDataRunning ??= new Set<string>());

/** Runs `job` unless one is already running for the shop. Never throws. */
export async function withShopLock<T>(shop: string, job: () => Promise<T>): Promise<T | "busy"> {
  if (runningShops.has(shop)) return "busy";
  runningShops.add(shop);
  try {
    return await job();
  } finally {
    runningShops.delete(shop);
  }
}

/** Starts the backfill in the background (install must not wait for it). Never throws. */
export function kickoffBackfill(shop: string, deps: DataJobDeps): void {
  void withShopLock(shop, () => runBackfill(shop, deps))
    .then((r) => console.log(`[sync/backfill] ${shop}: ${r}`))
    .catch((e) => console.error(`[sync/backfill] ${shop}: kickoff failed`, e));
}
