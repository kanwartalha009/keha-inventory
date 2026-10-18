/**
 * Action wording for people (spec §7.7 "Why", §12 copy rules, §13): pure and client-safe.
 *
 *  - `formatReasonParams` turns an action's `reason.params` into display strings for `fill()`:
 *    ISO days → "12 Nov" in the target language, numbers with the locale's separators. Home,
 *    the Monday email and Slack all use it, so a sentence reads the same everywhere.
 *  - `FACT_DEFS` maps every `reason.facts` key the engine writes (engine/actions-rules-shared.ts,
 *    all 8 kinds) to a plain-words English label (a translation key, area i18n-facts.ts) and a
 *    value type. Internal keys are hidden; codes become words. `factLines` formats them for the
 *    "Why" dialog. A key with no entry is never shown (no raw code names on screen);
 *    tests/action-facts.test.ts fails when the engine writes a key that has no entry.
 */
import { fill, plural } from "./i18n";
import type { ReasonParams } from "./actions-shared";

type T = (key: string) => string;

export type FactValue = string | number | null;

/** How a fact's value is shown. */
export type FactKind =
  /** A whole or decimal number (units, visits, variants). */
  | "number"
  /** "14 days" */
  | "days"
  /** Store currency. */
  | "money"
  /** A value already in percent (2.5 → "2.5%"). */
  | "percent"
  /** A ratio (0.2 → "20%"). */
  | "ratio"
  /** "× 1.2" */
  | "multiplier"
  /** A multiplier shown as a change: 1.2 → "+20%". */
  | "change"
  /** ISO day → "12 Nov". */
  | "date"
  /** A number of days ahead → "Next 28 days". */
  | "next"
  /** A number of days back → "Last 28 days". */
  | "last";

export type FactDef =
  | { label: string; kind: FactKind }
  | { label: string; kind: "enum"; values: Record<string, string> }
  | { kind: "hidden" };

/**
 * Every fact key the engine writes, by rule:
 *  reorder      variants rate seasonal trend daysLeft leadTimeDays orderBy orderQty onHand incoming price horizonDays
 *  bridge       variants rate seasonal trend daysLeft gapDays arrival arrivalSource orderBy incoming incomingDated
 *               units28 sessionsPerWeek price
 *  push         variants trend conversionPct storeMedianPct sessions28 share horizonDays
 *  fix_falling  revenue28 revenue28LastYear rankLastYear windowDays
 *  fix_sizes    soldOut variants units28 estimatedFromSiblings siblingRate horizonDays
 *  fix_page     sessions28 checkouts28 peers price aov windowDays basis
 *  fix_returns  unitsSold returned thresholdPct windowDays
 *  clear        variants dead tooMuch units costBasis coverDays
 * `arrivalDate` is the older name of `arrival` (read by arrivalOf in action-list-shared.ts).
 */
export const FACT_DEFS: Record<string, FactDef> = {
  variants: { label: "Variants affected", kind: "number" },
  rate: { label: "Sales per day while in stock", kind: "number" },
  seasonal: { label: "Seasonal change", kind: "multiplier" },
  trend: { label: "Trend vs last year", kind: "change" },
  daysLeft: { label: "Days of stock left", kind: "number" },
  leadTimeDays: { label: "Supplier lead time", kind: "days" },
  orderBy: { label: "Order by", kind: "date" },
  orderQty: { label: "Units to order", kind: "number" },
  onHand: { label: "In stock", kind: "number" },
  incoming: { label: "Incoming", kind: "number" },
  price: { label: "Price", kind: "money" },
  horizonDays: { label: "Period", kind: "next" },
  gapDays: { label: "Days without stock", kind: "number" },
  arrival: { label: "New stock arrives", kind: "date" },
  arrivalDate: { label: "New stock arrives", kind: "date" },
  arrivalSource: {
    label: "Arrival date based on",
    kind: "enum",
    values: { purchase_order: "An open purchase order", lead_time: "The lead time, if you order today" },
  },
  incomingDated: { label: "Units on purchase orders", kind: "number" },
  units28: { label: "Units sold, last 28 days", kind: "number" },
  sessionsPerWeek: { label: "Page visits per week", kind: "number" },
  conversionPct: { label: "Visitors who buy", kind: "percent" },
  storeMedianPct: { label: "Store median", kind: "percent" },
  sessions28: { label: "Page visits, last 28 days", kind: "number" },
  share: { label: "Extra sales if featured", kind: "ratio" },
  revenue28: { label: "Sales, last 28 days", kind: "money" },
  revenue28LastYear: { label: "Sales, same weeks last year", kind: "money" },
  rankLastYear: { label: "Rank by sales last year", kind: "number" },
  windowDays: { label: "Period", kind: "last" },
  soldOut: { label: "Variants sold out", kind: "number" },
  estimatedFromSiblings: { label: "Variants estimated from the other variants", kind: "number" },
  siblingRate: { label: "Sales per day of the other variants", kind: "number" },
  checkouts28: { label: "Visits that bought, last 28 days", kind: "number" },
  peers: { label: "Products at a similar price", kind: "number" },
  aov: { label: "Average order value", kind: "money" },
  basis: { label: "Visits counted", kind: "enum", values: { "landing sessions": "Visits that started on this page" } },
  unitsSold: { label: "Units sold", kind: "number" },
  returned: { label: "Units returned", kind: "number" },
  thresholdPct: { label: "Return rate that counts as high", kind: "percent" },
  dead: { label: "Variants with no recent sales", kind: "number" },
  tooMuch: { label: "Variants with too much stock", kind: "number" },
  units: { label: "Units to clear", kind: "number" },
  costBasis: { label: "Valued at", kind: "enum", values: { cost: "Cost price", retail: "Retail price" } },
  coverDays: { label: "Stock you need", kind: "days" },
};

/** Every English string FACT_DEFS can show (registered in tests/i18n-coverage.test.ts). */
export function factStrings(): string[] {
  const out = new Set<string>();
  for (const d of Object.values(FACT_DEFS)) {
    if (d.kind === "hidden") continue;
    out.add(d.label);
    if (d.kind === "enum") for (const v of Object.values(d.values)) out.add(v);
  }
  return [...out];
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Plain "en" reads day-month ("12 Nov"), as the copy rules write it. */
const dateLocale = (locale: string) => (locale === "en" ? "en-GB" : locale);

/** "2026-11-12" → "12 Nov" (de "12. Nov.", fr "12 nov."); anything else as is. */
export function shortDay(iso: string, locale: string): string {
  if (!ISO_DAY.test(iso)) return iso;
  try {
    return new Intl.DateTimeFormat(dateLocale(locale), { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
  } catch {
    return iso;
  }
}

function num(v: number, locale: string, maxFrac = 1): string {
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: maxFrac }).format(v);
  } catch {
    return String(v);
  }
}

function pctOf(ratio: number, locale: string, sign = false): string {
  try {
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1, ...(sign ? { signDisplay: "exceptZero" as const } : {}) }).format(ratio);
  } catch {
    const p = Math.round(ratio * 1000) / 10;
    return `${sign && p > 0 ? "+" : ""}${p}%`;
  }
}

function money(v: number, currency: string, locale: string): string {
  const digits = Number.isInteger(v) ? 0 : 2;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  } catch {
    return `${v.toFixed(digits)} ${currency}`;
  }
}

/**
 * Reason params ready for `fill()` in `locale`: ISO days → "12 Nov", numbers with the locale's
 * separators (1 decimal at most). No reason param is money today; `money` lists the ones that
 * are, formatted in `currency`.
 */
export function formatReasonParams(
  params: ReasonParams,
  locale: string,
  opts: { currency?: string; money?: readonly string[] } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "number") {
      out[k] = opts.currency && opts.money?.includes(k) ? money(v, opts.currency, locale) : num(v, locale);
    } else out[k] = ISO_DAY.test(v) ? shortDay(v, locale) : String(v);
  }
  return out;
}

/**
 * An action sentence: the (already translated) template filled with its params for `locale`.
 * A date abbreviation ending a sentence ("… bis 12. Nov.", "… le 12 nov.") keeps one full stop.
 */
export function reasonSentence(template: string, params: ReasonParams, locale: string): string {
  return fill(template, formatReasonParams(params, locale)).replace(/(?<!\.)\.\.(?!\.)(?=\s|$)/g, ".");
}

/** One fact's value in words; null when the fact is not shown (hidden, unknown key or code). */
export function factValueText(key: string, value: FactValue, ctx: { t: T; locale: string; currency: string }): string | null {
  const def = FACT_DEFS[key];
  if (!def || def.kind === "hidden") return null;
  if (value === null || value === undefined) return "—";
  const { t, locale } = ctx;
  if (def.kind === "enum") return typeof value === "string" && value in def.values ? t(def.values[value]) : null;
  if (def.kind === "date") return typeof value === "string" && ISO_DAY.test(value) ? shortDay(value, locale) : "—";
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  switch (def.kind) {
    case "number":
      return num(value, locale);
    case "days":
      return fill(plural(value, t("1 day"), t("{n} days")), { n: num(value, locale) });
    case "money":
      return money(value, ctx.currency, locale);
    case "percent":
      return pctOf(value / 100, locale);
    case "ratio":
      return pctOf(value, locale);
    case "multiplier":
      return `× ${num(value, locale, 2)}`;
    case "change":
      return pctOf(value - 1, locale, true);
    case "next":
      return fill(t("Next {n} days"), { n: num(value, locale, 0) });
    case "last":
      return fill(t("Last {n} days"), { n: num(value, locale, 0) });
  }
}

/** The "Based on: …" lines of the Why dialog, in the engine's order, translated. */
export function factLines(
  facts: ReadonlyArray<{ label: string; value: FactValue }>,
  ctx: { t: T; locale: string; currency: string },
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const f of facts) {
    const def = FACT_DEFS[f.label];
    const value = factValueText(f.label, f.value, ctx);
    if (!def || def.kind === "hidden" || value === null) continue;
    out.push({ label: ctx.t(def.label), value });
  }
  return out;
}
