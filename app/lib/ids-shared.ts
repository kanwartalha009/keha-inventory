/**
 * The one place where the app's ids meet the compact fact tables' integers (DB scale "before
 * 1,000 stores"). Models and services keep speaking GIDs, location keys and channel names; the
 * facts store (services/facts-store.server) converts at the boundary with these helpers:
 *
 *  - variant: gid://shopify/ProductVariant/<n> ⇄ <n> (bigint in the table; kept as a decimal
 *    string here so no id ever goes through a float).
 *  - shop: Shop.domain ⇄ Shop.num (looked up once per process, the number never changes).
 *  - string keys (location ids, "online", "all", "pos:<name>", channel names, traffic types) ⇄
 *    FactKey.num, one append-only dictionary; "all" = 0 and "online" = 1 are fixed.
 * Pure: no database access (the store owns the lookups and caches).
 */

export const VARIANT_GID_PREFIX = "gid://shopify/ProductVariant/";

/** FactKey numbers fixed by the migration. */
export const KEY_ALL = 0;
export const KEY_ONLINE = 1;
export const FIXED_KEYS: ReadonlyMap<string, number> = new Map([
  ["all", KEY_ALL],
  ["online", KEY_ONLINE],
]);

const DIGITS = /^[0-9]{1,19}$/;
const MAX_INT8 = 9223372036854775807n;

/**
 * The number of a variant GID as a decimal string (what the bigint column holds), or null when
 * the id is not a ProductVariant GID with a numeric id (it can never be in the facts).
 */
export function variantNum(gid: string): string | null {
  if (typeof gid !== "string" || !gid.startsWith(VARIANT_GID_PREFIX)) return null;
  const n = gid.slice(VARIANT_GID_PREFIX.length);
  if (!DIGITS.test(n)) return null;
  const v = BigInt(n);
  if (v > MAX_INT8) return null;
  return v.toString();
}

/** The GID of a stored variant number (bigint, number or decimal string). */
export function variantGid(num: unknown): string {
  return VARIANT_GID_PREFIX + intString(num);
}

/** A database integer (bigint / number / string / Decimal-like) as a canonical decimal string. */
export function intString(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new RangeError(`not a safe integer: ${v}`);
    return String(v);
  }
  if (typeof v === "string" && /^-?[0-9]+$/.test(v)) return BigInt(v).toString();
  if (v && typeof v === "object" && "toString" in v) {
    const s = String(v);
    if (/^-?[0-9]+$/.test(s)) return BigInt(s).toString();
  }
  throw new TypeError(`not an integer: ${String(v)}`);
}

/** A database number (bigint, Decimal, string, number, null) → number | null. */
export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return v === "" ? null : Number(v);
  if (typeof v === "object" && v && "toNumber" in v && typeof (v as { toNumber: unknown }).toNumber === "function") return (v as { toNumber: () => number }).toNumber();
  return Number(v);
}

/** Cents (integer, any database type) → currency units, exactly as Number("12.34") would give. */
export function centsToAmount(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = intString(v);
  const neg = s.startsWith("-");
  const digits = (neg ? s.slice(1) : s).padStart(3, "0");
  return Number(`${neg ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`);
}

/** Currency units (already rounded to cents) → integer cents. */
export function amountToCents(amount: number): string {
  if (!Number.isFinite(amount)) throw new RangeError(`not a finite amount: ${amount}`);
  return String(Math.round(amount * 100));
}

/** A YYYY-MM-DD day from a Date (UTC) or a date string. */
export function dayString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  throw new TypeError(`not a day: ${String(v)}`);
}

/** UTC midnight Date of a day (what Prisma returns for a `@db.Date` column). */
export function dayAsDate(v: unknown): Date {
  return new Date(`${dayString(v)}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// Months (stock rows and partitions are per calendar month)
// ---------------------------------------------------------------------------

/** First day of the day's month, YYYY-MM-01. */
export function monthOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Day of month, 1–31. */
export function dayOfMonth(day: string): number {
  return Number(day.slice(8, 10));
}

/** The month `n` months after `month` (YYYY-MM-01; n may be negative). */
export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${String(yy).padStart(4, "0")}-${String(mm + 1).padStart(2, "0")}-01`;
}

/** Days in the month of `month` (28–31). */
export function daysInMonth(month: string): number {
  const next = new Date(`${addMonths(month, 1)}T00:00:00Z`).getTime();
  const cur = new Date(`${monthOf(month)}T00:00:00Z`).getTime();
  return Math.round((next - cur) / 86_400_000);
}

/** The day `d` (1–31) of `month`, YYYY-MM-DD. */
export function monthDay(month: string, d: number): string {
  return `${month.slice(0, 7)}-${String(d).padStart(2, "0")}`;
}

/** Months from `from` through `to` (both YYYY-MM-01, inclusive). */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = monthOf(from); m <= monthOf(to); m = addMonths(m, 1)) out.push(m);
  return out;
}

/**
 * A day range cut at month ends: each piece lies in one month, with its first / last day of
 * month (what one StockMonth write covers).
 */
export function monthSegments(since: string, until: string): { month: string; since: string; until: string; a: number; b: number }[] {
  const out: { month: string; since: string; until: string; a: number; b: number }[] = [];
  if (since > until) return out;
  for (const month of monthsBetween(since, until)) {
    const first = month;
    const last = monthDay(month, daysInMonth(month));
    const s = since > first ? since : first;
    const u = until < last ? until : last;
    out.push({ month, since: s, until: u, a: dayOfMonth(s), b: dayOfMonth(u) });
  }
  return out;
}
