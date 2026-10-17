/**
 * Weekly sales re-check (owner 2026-10-18) — the pure part. The nightly run re-reads only the
 * last 3 days of sales (nightly.server REREAD_DAYS), but Shopify keeps changing older order days:
 * a refund, a cancellation or an edited order lands on its ORDER day, weeks later. Once a week
 * per shop the re-check reads the store's daily units total for the last RECHECK_DAYS days (one
 * cheap ShopifyQL totals query, the same reconciliation total storeSales uses), compares it with
 * the stored daily units (the channel view, locationKey "all"), and re-reads + rewrites ONLY the
 * days that differ through the normal idempotent sales write (facts.server storeHistory: the
 * range's rows become the fresh rows). Never today (I-12: the range ends at yesterday, or
 * earlier when the sales sync is behind).
 *
 * Known limit: units Shopify reports without a variant (custom items, deleted products —
 * shopifyql-shared parseSalesRows "unattributed") are counted in the total but never stored, so
 * such a day differs every week and is re-read every week; the rewrite then changes nothing and
 * is not counted as a correction (`corrected` counts days whose stored units moved).
 *
 * Schedule: hourly tick, each shop in its own hour of the week (recheckSlot, a hash of the shop
 * domain, so shops are spread over the week), at most once every 6 days; a shop whose last
 * re-check is 8+ days old (the instance was down at its slot) runs on the next tick.
 *
 * Merchant notice: nothing, unless the corrections moved the window's units by more than
 * RECHECK_NOTICE_SHARE (Σ |after − before| per day ÷ the window's units before) — then one quiet
 * line in the Dashboard's "Numbers from …" area for RECHECK_NOTICE_MS.
 *
 * The result is kept in Shop.backfillState.weeklyRecheck (JSON, no schema change).
 */
import { addDays, reconcileDailyUnits, type DayRange } from "./shopifyql-shared";
import { fill } from "../i18n";

export const RECHECK_DAYS = 35;
export const HOURS_PER_WEEK = 168;
/** Not again before this (the slot hour comes round once a week). */
export const RECHECK_MIN_GAP_MS = 6 * 24 * 60 * 60 * 1000;
/** Missed its slot (downtime): runs on the next tick. */
export const RECHECK_CATCH_UP_MS = 8 * 24 * 60 * 60 * 1000;
/** Merchant notice only above this share of the window's units. */
export const RECHECK_NOTICE_SHARE = 0.02;
/** The Dashboard line shows this long after the re-check. */
export const RECHECK_NOTICE_MS = 8 * 24 * 60 * 60 * 1000;

export type WeeklyRecheck = {
  /** When it ran (ISO). */
  at: string;
  outcome: "done" | "error";
  since: string | null;
  until: string | null;
  /** Days whose stored units differed from Shopify's total. */
  differing: number;
  /** Days whose stored units changed after the rewrite. */
  corrected: number;
  /** Window units before / after. */
  unitsBefore: number;
  unitsAfter: number;
  /** Σ |after − before| per day. */
  changed: number;
  /** changed ÷ unitsBefore (1 when there were no units before and some now); 0 when nothing changed. */
  share: number;
  error?: string;
};

export function readWeeklyRecheck(backfillState: unknown): WeeklyRecheck | null {
  if (!backfillState || typeof backfillState !== "object") return null;
  const r = (backfillState as { weeklyRecheck?: unknown }).weeklyRecheck;
  if (!r || typeof r !== "object") return null;
  const w = r as Partial<WeeklyRecheck>;
  if (typeof w.at !== "string" || !Number.isFinite(Date.parse(w.at))) return null;
  return w as WeeklyRecheck;
}

/** The shop's hour of the week (0–167, UTC): FNV-1a of the domain, so shops spread evenly. */
export function recheckSlot(shop: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < shop.length; i++) {
    h ^= shop.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % HOURS_PER_WEEK;
}

/** Hours since Sunday 00:00 UTC (0–167). */
export function hourOfWeek(now: Date): number {
  return now.getUTCDay() * 24 + now.getUTCHours();
}

/** Due on its slot hour (not again within 6 days), or at once when the last one is 8+ days old. */
export function isRecheckDue(shop: string, last: WeeklyRecheck | null, now: Date): boolean {
  const age = last ? now.getTime() - Date.parse(last.at) : Infinity;
  if (last && age >= RECHECK_CATCH_UP_MS) return true;
  if (hourOfWeek(now) !== recheckSlot(shop)) return false;
  return !last || age >= RECHECK_MIN_GAP_MS || age < 0;
}

/**
 * The window: the RECHECK_DAYS days ending at yesterday, or at the last day the sales sync stored
 * when that is earlier (days not read yet are the nightly run's job). Null before any sales sync.
 */
export function recheckRange(yesterday: string, salesSyncedThrough: string | null | undefined, days = RECHECK_DAYS): DayRange | null {
  if (!salesSyncedThrough) return null;
  const until = salesSyncedThrough < yesterday ? salesSyncedThrough : yesterday;
  return { since: addDays(until, -(days - 1)), until };
}

/** Days where the stored units and Shopify's total differ (the reconcile rule: ≥ 0.5 apart; a day absent counts as 0). */
export function differingDays(stored: ReadonlyMap<string, number>, shopify: ReadonlyMap<string, number>, range: DayRange): string[] {
  return reconcileDailyUnits(stored, shopify, range).map((m) => m.day);
}

/** Sorted days → contiguous ranges (one re-read per run of days). */
export function dayRuns(days: readonly string[]): DayRange[] {
  const out: DayRange[] = [];
  for (const d of [...new Set(days)].sort()) {
    const last = out[out.length - 1];
    if (last && addDays(last.until, 1) === d) last.until = d;
    else out.push({ since: d, until: d });
  }
  return out;
}

/** What the rewrite changed over the window. */
export function recheckSummary(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  range: DayRange,
): Pick<WeeklyRecheck, "corrected" | "unitsBefore" | "unitsAfter" | "changed" | "share"> {
  let corrected = 0;
  let unitsBefore = 0;
  let unitsAfter = 0;
  let changed = 0;
  for (let d = range.since; d <= range.until; d = addDays(d, 1)) {
    const b = before.get(d) ?? 0;
    const a = after.get(d) ?? 0;
    unitsBefore += b;
    unitsAfter += a;
    const diff = Math.abs(a - b);
    if (diff >= 0.5) {
      corrected++;
      changed += diff;
    }
  }
  const share = changed === 0 ? 0 : unitsBefore > 0 ? changed / unitsBefore : 1;
  return { corrected, unitsBefore, unitsAfter, changed, share };
}

/** The Dashboard line: a finished re-check in the last 8 days whose corrections moved units by more than 2%. */
export function showRecheckNotice(r: WeeklyRecheck | null, now: Date): boolean {
  if (!r || r.outcome !== "done" || !(r.corrected > 0) || !(r.share > RECHECK_NOTICE_SHARE)) return false;
  const age = now.getTime() - Date.parse(r.at);
  return age >= 0 && age <= RECHECK_NOTICE_MS;
}

/** "Shopify updated 3 days of past sales (refunds or order edits). Your numbers include them." */
export function recheckNoticeText(corrected: number, t: (s: string) => string, count: (n: number) => string): string {
  return corrected === 1
    ? t("Shopify updated 1 day of past sales (refunds or order edits). Your numbers include it.")
    : fill(t("Shopify updated {n} days of past sales (refunds or order edits). Your numbers include them."), { n: count(corrected) });
}
