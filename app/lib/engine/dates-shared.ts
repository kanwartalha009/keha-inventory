/**
 * Day math for the engine (spec §7). Days are UTC date strings "YYYY-MM-DD".
 * Pure: no clock access; callers pass `today`.
 */

/** A UTC calendar day, "YYYY-MM-DD". */
export type DayKey = string;

const MS_PER_DAY = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(T.*)?$/;

/** Days since 1970-01-01 for a DayKey. Throws on a malformed or impossible date. */
export function dayIndex(day: DayKey): number {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`engine: bad day "${day}" (expected YYYY-MM-DD)`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new Error(`engine: impossible day "${day}"`);
  }
  return Math.round(ms / MS_PER_DAY);
}

/** DayKey for a day index (inverse of dayIndex). */
export function fromDayIndex(index: number): DayKey {
  return new Date(index * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(day: DayKey, n: number): DayKey {
  return fromDayIndex(dayIndex(day) + n);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: DayKey, to: DayKey): number {
  return dayIndex(to) - dayIndex(from);
}

/**
 * Normalise "YYYY-MM-DD" or an ISO datetime ("2026-01-02T10:00:00Z") to its
 * DayKey. The date part of an ISO string is taken as-is (assumed UTC).
 */
export function toDayKey(value: string): DayKey {
  const m = DAY_PREFIX_RE.exec(value);
  if (!m) throw new Error(`engine: bad date "${value}"`);
  const day = m[1]!;
  dayIndex(day); // validate
  return day;
}

/** Day of week, 0 = Sunday … 6 = Saturday. */
export function weekday(day: DayKey): number {
  return new Date(`${toDayKey(day)}T00:00:00Z`).getUTCDay();
}

/** Monday of the ISO week a day falls in. */
export function weekStart(day: DayKey): DayKey {
  return addDays(day, -((weekday(day) + 6) % 7));
}

/** ISO week label "2026-W46" (the ISO year is the year of the week's Thursday). */
export function isoWeek(day: DayKey): string {
  const thursday = addDays(weekStart(day), 3);
  const year = thursday.slice(0, 4);
  const week = Math.floor(daysBetween(`${year}-01-01`, thursday) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}
