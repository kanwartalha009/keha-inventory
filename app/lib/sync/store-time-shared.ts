/**
 * Store-time helpers (spec §6.6: every job runs on the store's clock). Pure: the caller
 * passes the instant; the time zone is applied with Intl.DateTimeFormat, so DST and
 * fractional / extreme offsets (UTC−11 … UTC+14, +05:45, …) come from the platform's tz data.
 *
 * Days are `YYYY-MM-DD` calendar days in the store's time zone. Day arithmetic reuses the
 * ShopifyQL helpers (pure calendar counters).
 */
import { addDays, isDay } from "./shopifyql-shared";
import { HISTORY_MONTHS } from "./backfill-shared";

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The IANA zone if the runtime knows it, else "UTC" (a bad zone must never crash a job). */
export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

export type LocalParts = { date: string; hour: number; minute: number };

/** Wall-clock date and time at `at` in `tz`. */
export function localParts(at: Date, tz: string | null | undefined): LocalParts {
  const parts = formatter(safeTimeZone(tz)).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24; // some runtimes print "24" at midnight even with h23
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour, minute: Number(get("minute")) };
}

/** Today's date in the store. */
export function localDate(at: Date, tz: string | null | undefined): string {
  return localParts(at, tz).date;
}

/** The store's local hour (0–23). */
export function localHour(at: Date, tz: string | null | undefined): number {
  return localParts(at, tz).hour;
}

/** The last whole day in the store (today is partial, invariant I-12). */
export function localYesterday(at: Date, tz: string | null | undefined): string {
  return addDays(localDate(at, tz), -1);
}

/** Same day-of-month `n` months earlier, clamped to the month's length (31 Mar − 1 → 28/29 Feb). */
export function monthsBefore(day: string, n: number): string {
  if (!isDay(day)) throw new RangeError(`bad day ${day}`);
  const [y, m, d] = day.split("-").map(Number);
  const total = y * 12 + (m - 1) - n;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12; // 0-based
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, last);
  return `${String(ny).padStart(4, "0")}-${String(nm + 1).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/**
 * The backfill window: `months` calendar months ending on `yesterday` (yesterday's month,
 * partial, plus the months before it), so monthChunks yields exactly `months` chunks.
 */
export function historyRange(yesterday: string, months: number = HISTORY_MONTHS): { from: string; until: string } {
  if (!isDay(yesterday)) throw new RangeError(`bad day ${yesterday}`);
  const first = `${yesterday.slice(0, 7)}-01`;
  return { from: monthsBefore(first, months - 1), until: yesterday };
}

/** Local hour at or after which the nightly job may run (spec §6.6: 03:00). */
export const NIGHTLY_HOUR = 3;

/** Due when it is ≥ 03:00 in the store and the last run was on an earlier store-local day. */
export function isNightlyDue(now: Date, tz: string | null | undefined, lastNightlyAt: Date | null | undefined): boolean {
  const p = localParts(now, tz);
  if (p.hour < NIGHTLY_HOUR) return false;
  if (!lastNightlyAt) return true;
  return localDate(lastNightlyAt, tz) < p.date;
}

/** Daily facts older than this many months are deleted (spec §8; monthly roll-up is phase 2). */
export const RETENTION_MONTHS = 25;

/** First day still kept: rows with day < this are deleted. */
export function retentionCutoff(today: string, months: number = RETENTION_MONTHS): string {
  return monthsBefore(today, months);
}
