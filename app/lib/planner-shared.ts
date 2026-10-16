/**
 * Planner (spec §4 J6, §5.4, §7.3, §7.4; task 2.5): season / growth scenarios, collection goals
 * and the accuracy scorecard. Pure, client-safe; the server part is services/planner.server.ts.
 * The planner only reads: nothing here changes the store.
 *
 * Scenario maths, per variant (online stock pool, the latest VariantMetric run):
 *  - Period: [start, end] in the store's calendar. A period already under way is planned from
 *    today ("effective start" = max(start, today)); a period that has ended is refused.
 *  - Rate: VariantMetric.rate (sales per day while in stock, sell-out corrected, spec §7.2) and
 *    its σ and z — the same numbers Products and Reorder show. No advice (fewer than 14 in-stock
 *    days, no rate or no σ) → the variant has no demand ("—") and no order line.
 *  - Seasonal index for the period (spec §7.3, at store or collection level as the engine
 *    chooses — chooseSeasonSource): units/day over the same calendar dates in the most recent
 *    year they are fully in the past (one year back; two when the period is more than a year
 *    away) ÷ units/day over the engine's base window (the 28 days ending yesterday, one year
 *    back), clamped 0.2–5.0, with the engine's requirements (≥ 13 months of history, ≥ 80 %
 *    covered days in both spans, base sold > 0); otherwise 1.0.
 *  - Trend: the engine's trendFactor at the same level.
 *  - Plan multiplier (planMultiplier): keep pace 1; grow X % 1 + X/100; revenue target =
 *    target ÷ baseline revenue, where baseline revenue = Σ baseline units × price.
 *  - demand(period) = rate × seasonal(period) × trend × plan × days.
 *  - Stock at the period start = max(0, onHand + incoming − rate × seasonal(today → start) ×
 *    trend × days until the start); plan 1 before the period. Never below 0: sales lost before
 *    the period are the Reorder screen's job, not the season order's.
 *  - Units needed = demand + safety (z × σ × √lead time) − stock at start; rounded up to the case
 *    pack and the per-variant minimum exactly as Reorder (lineQuantity). ≤ 0 → no line. Then
 *    the supplier's order-total minimum: a group below it is topped up exactly as Reorder
 *    (topUpToMinimum, weights = sales per day), before cash per week is summed.
 *  - Order by = start − lead time − safety days (orderByDate with 0 days left); before today →
 *    "Late — order now".
 *  - Cash: unit cost × qty in the store currency (cost in another currency is not converted);
 *    no cost → retail price, labelled "at retail price"; neither → "—". Summed by the ISO week
 *    (Monday) of the order-by date; late lines count in the current week.
 *  - Demand per collection: a variant counts in every collection it belongs to, so collection
 *    totals overlap; the store total counts each variant once.
 */
import { addDays, daysBetween, toDayKey, type DayKey } from "./engine/dates-shared";
import { orderByDate, resolveLeadTime, safetyStock } from "./engine/order-shared";
import { resolveSettings } from "./engine/types-shared";
import {
  SEASON,
  chooseSeasonSource,
  monthsEarlier,
  planMultiplier,
  seasonalIndex,
  shiftYears,
  spanStats,
  trendFactor,
  type Coverage,
  type SeasonalReason,
  type SeasonalResult,
  type SpanStats,
  type TrendResult,
  type UnitsSeries,
} from "./engine/season-shared";
import { absPctError, ACCURACY_TOP, nextMonthStart, STORE_ROW } from "./engine/accuracy-shared";
import { lineQuantity, supplierGroupKey, topUpToMinimum, unitCostIn, vendorGroupKey } from "./reorder-shared";
import { casePackFor, supplierFor, type SupplierLite } from "./supplier-shared";

type T = (s: string) => string;

// ---------------------------------------------------------------------------
// Scenario fields
// ---------------------------------------------------------------------------

export const SCENARIO_EVENTS = ["black_friday", "christmas", "custom"] as const;
export type ScenarioEvent = (typeof SCENARIO_EVENTS)[number];

export const TARGET_TYPES = ["growth", "revenue", "keep_pace"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

/** Scenario.result format; bump when the shape changes (older results ask for a recalculation). */
export const RESULT_VERSION = 1;

export const SCENARIO_BOUNDS = {
  nameMax: 80,
  /** Longest period. */
  maxPeriodDays: 365,
  /** Furthest start date from today. */
  maxDaysAhead: 730,
  growthPct: { min: -90, max: 1000 },
  revenue: { min: 1, max: 1_000_000_000 },
} as const;

export const isScenarioEvent = (v: unknown): v is ScenarioEvent => SCENARIO_EVENTS.includes(v as ScenarioEvent);
export const isTargetType = (v: unknown): v is TargetType => TARGET_TYPES.includes(v as TargetType);

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A valid "YYYY-MM-DD", else null. */
export function readDay(v: unknown): DayKey | null {
  if (typeof v !== "string" || !DAY_RE.test(v.trim())) return null;
  try {
    return toDayKey(v.trim());
  } catch {
    return null;
  }
}

/** Day of week, 0 = Sunday … 6 = Saturday. */
export function weekday(day: DayKey): number {
  return new Date(`${toDayKey(day)}T00:00:00Z`).getUTCDay();
}

/** Black Friday: the Friday after the 4th Thursday of November. */
export function blackFriday(year: number): DayKey {
  const nov1 = `${String(year).padStart(4, "0")}-11-01`;
  const firstThursday = addDays(nov1, (4 - weekday(nov1) + 7) % 7);
  return addDays(firstThursday, 21 + 1);
}

/**
 * Default period for an event: Black Friday → Thursday to Monday of that week (Thanksgiving to
 * Cyber Monday); Christmas → 1–24 December. The next one that hasn't ended. Custom → null.
 */
export function eventPeriod(event: ScenarioEvent, today: DayKey): { start: DayKey; end: DayKey } | null {
  const year = Number(toDayKey(today).slice(0, 4));
  const make = (y: number) => {
    if (event === "black_friday") {
      const bf = blackFriday(y);
      return { start: addDays(bf, -1), end: addDays(bf, 3) };
    }
    if (event === "christmas") return { start: `${y}-12-01`, end: `${y}-12-24` };
    return null;
  };
  const p = make(year);
  if (!p) return null;
  return p.end >= today ? p : make(year + 1);
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

/** The part of a period still ahead: from max(start, today). */
export function effectiveStart(start: DayKey, today: DayKey): DayKey {
  return start > today ? start : today;
}

/**
 * The same calendar dates in the most recent year they are fully in the past: one year back,
 * or more when the period ends more than a year from today (at most 3 years back).
 */
export function lastYearSpan(today: DayKey, start: DayKey, end: DayKey): { from: DayKey; to: DayKey; yearsBack: number } {
  let k = 1;
  while (k < 3 && shiftYears(end, -k) >= today) k++;
  return { from: shiftYears(start, -k), to: shiftYears(end, -k), yearsBack: k };
}

/** ≥ 13 months of sales history (seasonality and last year's numbers are available). */
export function hasSeasonHistory(coverage: Coverage, today: DayKey): boolean {
  return !!coverage.from && coverage.from <= monthsEarlier(today, SEASON.minHistoryMonths);
}

// ---------------------------------------------------------------------------
// Scenario form
// ---------------------------------------------------------------------------

export type ScenarioForm = {
  name: string;
  event: ScenarioEvent;
  start: string;
  end: string;
  targetType: TargetType;
  /** Growth % or revenue target; ignored for keep pace. A string so half-typed input round-trips. */
  targetValue: string;
};

export type ScenarioInput = {
  name: string;
  event: ScenarioEvent;
  start: DayKey;
  end: DayKey;
  targetType: TargetType;
  /** 0 for keep pace. */
  targetValue: number;
};

export type ScenarioErrorCode =
  | "name"
  | "nameLong"
  | "date"
  | "endBeforeStart"
  | "ended"
  | "tooLong"
  | "tooFar"
  | "growth"
  | "revenue";
export type ScenarioErrors = Partial<Record<keyof ScenarioForm, ScenarioErrorCode>>;

/** A new scenario: Black Friday's next period, grow 20 %. */
export function newScenarioForm(today: DayKey): ScenarioForm {
  const p = eventPeriod("black_friday", today)!;
  return { name: "Black Friday", event: "black_friday", start: p.start, end: p.end, targetType: "growth", targetValue: "20" };
}

export function scenarioToForm(s: { name: string; event: string; start: DayKey; end: DayKey; targetType: string; targetValue: number }): ScenarioForm {
  return {
    name: s.name,
    event: isScenarioEvent(s.event) ? s.event : "custom",
    start: s.start,
    end: s.end,
    targetType: isTargetType(s.targetType) ? s.targetType : "keep_pace",
    targetValue: s.targetType === "keep_pace" ? "" : String(s.targetValue),
  };
}

/** Untrusted JSON → a form (unknown fields dropped, wrong types emptied). */
export function readScenarioForm(raw: unknown): ScenarioForm {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
  return {
    name: s(r.name).slice(0, 500),
    event: isScenarioEvent(r.event) ? r.event : "custom",
    start: s(r.start).trim(),
    end: s(r.end).trim(),
    targetType: isTargetType(r.targetType) ? r.targetType : "keep_pace",
    targetValue: s(r.targetValue).trim(),
  };
}

const NUM_RE = /^-?\d+(?:[.,]\d+)?$/;

export function validateScenario(
  form: ScenarioForm,
  today: DayKey,
): { ok: true; input: ScenarioInput } | { ok: false; errors: ScenarioErrors } {
  const errors: ScenarioErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = "name";
  else if (name.length > SCENARIO_BOUNDS.nameMax) errors.name = "nameLong";
  const start = readDay(form.start);
  const end = readDay(form.end);
  if (!start) errors.start = "date";
  if (!end) errors.end = "date";
  if (start && end) {
    if (end < start) errors.end = "endBeforeStart";
    else if (end < today) errors.end = "ended";
    else if (daysBetween(start, end) + 1 > SCENARIO_BOUNDS.maxPeriodDays) errors.end = "tooLong";
    if (daysBetween(today, start) > SCENARIO_BOUNDS.maxDaysAhead) errors.start = "tooFar";
  }
  let value = 0;
  if (form.targetType !== "keep_pace") {
    const raw = form.targetValue.replace(/\s/g, "");
    const n = NUM_RE.test(raw) ? Number(raw.replace(",", ".")) : NaN;
    if (form.targetType === "growth") {
      if (!Number.isFinite(n) || n < SCENARIO_BOUNDS.growthPct.min || n > SCENARIO_BOUNDS.growthPct.max) errors.targetValue = "growth";
    } else if (!Number.isFinite(n) || n < SCENARIO_BOUNDS.revenue.min || n > SCENARIO_BOUNDS.revenue.max) {
      errors.targetValue = "revenue";
    }
    value = Math.round(n * 100) / 100;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { name, event: form.event, start: start!, end: end!, targetType: form.targetType, targetValue: value } };
}

export function scenarioErrorText(code: ScenarioErrorCode, t: T): string {
  switch (code) {
    case "name":
      return t("Give the scenario a name.");
    case "nameLong":
      return t("Use up to 80 characters.");
    case "date":
      return t("Enter a date.");
    case "endBeforeStart":
      return t("The end date is before the start date.");
    case "ended":
      return t("This period has already ended. Pick a current or future period.");
    case "tooLong":
      return t("A period can be at most 365 days long.");
    case "tooFar":
      return t("Start within the next 2 years.");
    case "growth":
      return t("Enter a growth from -90% to 1000%.");
    case "revenue":
      return t("Enter a revenue target above 0.");
  }
}

export function eventLabel(e: ScenarioEvent, t: T): string {
  switch (e) {
    case "black_friday":
      return t("Black Friday");
    case "christmas":
      return t("Christmas");
    case "custom":
      return t("Custom dates");
  }
}

export function targetTypeLabel(tt: TargetType, t: T): string {
  switch (tt) {
    case "growth":
      return t("Grow by a percentage");
    case "revenue":
      return t("Reach a revenue target");
    case "keep_pace":
      return t("Keep pace");
  }
}

// ---------------------------------------------------------------------------
// Seasonality for a period
// ---------------------------------------------------------------------------

export interface PeriodSeasonal {
  value: number;
  applied: boolean;
  reason: SeasonalReason;
  raw: number | null;
  /** Years back the comparison span was taken from (1, or 2 when the period is > 1 year away). */
  yearsBack: number;
  span: SpanStats;
  base: SpanStats;
}

/**
 * units/day over the period's dates in the most recent past year ÷ units/day over the engine's
 * base window (28 days ending yesterday, one year back); clamped 0.2–5.0; else 1.0.
 */
export function periodSeasonalIndex(s: UnitsSeries, today: DayKey, start: DayKey, end: DayKey): PeriodSeasonal {
  const t = toDayKey(today);
  const ly = lastYearSpan(t, start, end);
  const span = spanStats(s, ly.from, ly.to);
  const baseTo = shiftYears(addDays(t, -1), -1);
  const base = spanStats(s, addDays(baseTo, -(SEASON.baseDays - 1)), baseTo);
  const out = (reason: SeasonalReason, raw: number | null = null): PeriodSeasonal => ({
    value: reason === "ok" && raw !== null ? Math.min(SEASON.seasonalMax, Math.max(SEASON.seasonalMin, raw)) : 1,
    applied: reason === "ok",
    reason,
    raw,
    yearsBack: ly.yearsBack,
    span,
    base,
  });
  if (!hasSeasonHistory(s.coverage, t)) return out("short_history");
  if (span.coverage < SEASON.minCoverage || base.coverage < SEASON.minCoverage) return out("low_coverage");
  if (!base.unitsPerDay || base.unitsPerDay <= 0) return out("no_base_sales");
  return out("ok", (span.unitsPerDay ?? 0) / base.unitsPerDay);
}

export interface VariantPeriodSeason {
  level: "store" | "collection";
  collectionId: string | null;
  period: PeriodSeasonal;
  /** Seasonal index for today → the period start (engine seasonalIndex); null when it starts today. */
  gap: SeasonalResult | null;
  trend: TrendResult;
}

/**
 * The planner's season context. Same level rule as the engine (createSeasonContext): a variant
 * in a collection that sold ≥ 2,000 units in the last 12 months uses that collection's index
 * (the most specific one) when the collection's period index can be computed; otherwise the
 * store's. Period, gap and trend always come from one level.
 */
export function createPlannerSeason(input: {
  today: DayKey;
  start: DayKey;
  end: DayKey;
  store: UnitsSeries;
  collections: ReadonlyMap<string, UnitsSeries>;
  units12m: ReadonlyMap<string, number>;
}) {
  const today = toDayKey(input.today);
  const from = effectiveStart(input.start, today);
  const gapDays = daysBetween(today, from);
  const memo = new Map<string, VariantPeriodSeason | null>();
  const build = (id: string | null): VariantPeriodSeason | null => {
    const key = id ?? "";
    if (memo.has(key)) return memo.get(key)!;
    const s = id === null ? input.store : input.collections.get(id);
    const r = s
      ? {
          level: (id === null ? "store" : "collection") as "store" | "collection",
          collectionId: id,
          period: periodSeasonalIndex(s, today, from, input.end),
          gap: gapDays > 0 ? seasonalIndex(s, today, gapDays) : null,
          trend: trendFactor(s, today),
        }
      : null;
    memo.set(key, r);
    return r;
  };
  return {
    gapDays,
    effectiveStart: from,
    store: () => build(null)!,
    forVariant(collections: readonly string[]): VariantPeriodSeason {
      const choice = chooseSeasonSource(collections, input.units12m);
      if (choice.level === "collection") {
        const c = build(choice.collectionId);
        if (c && c.period.applied) return c;
      }
      return build(null)!;
    },
  };
}

export type PlannerSeason = ReturnType<typeof createPlannerSeason>;

// ---------------------------------------------------------------------------
// Scenario result
// ---------------------------------------------------------------------------

export interface PlannerVariant {
  id: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  image: string | null;
  vendor: string | null;
  supplierId: string | null;
  collections: string[];
  caseQty: number | null;
  /** Unit cost and its currency (Shopify's cost field). */
  cost: number | null;
  costCurrency: string | null;
  /** Catalog price, store currency. */
  price: number | null;
  /** VariantMetric (online pool): sales per day while in stock, σ, z. */
  rate: number | null;
  sigma: number | null;
  z: number | null;
  /** ≥ 14 in-stock days (VariantMetric.inputs.enoughData). */
  enoughData: boolean;
  /** Σ over the online pool now. */
  onHand: number;
  /** Shopify's incoming + units on sent / confirmed Keha orders. */
  incoming: number;
}

export type PlannerSupplier = SupplierLite & { currency: string | null };

export interface PlannerInput {
  today: DayKey;
  start: DayKey;
  end: DayKey;
  targetType: TargetType;
  targetValue: number;
  currency: string;
  defaultLeadTimeDays: number;
  variants: readonly PlannerVariant[];
  suppliers: readonly PlannerSupplier[];
  season: PlannerSeason;
  coverage: Coverage;
  /** Channel view, all channels, over lastYearSpan(); null figures when not covered. */
  lastYear: LastYearFigures;
  computedAt: string;
}

export interface LastYearFigures {
  from: DayKey;
  to: DayKey;
  units: number | null;
  revenue: number | null;
  coverage: number;
}

export type ValueBasis = "cost" | "retail" | null;

export interface PlannerLine {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  image: string | null;
  /** Units expected in the period (after the plan multiplier). */
  demand: number;
  safety: number;
  /** Expected stock when the period starts (≥ 0). */
  stockAtStart: number;
  onHand: number;
  incoming: number;
  gapDemand: number;
  qty: number;
  pack: number | null;
  moq: number | null;
  leadTimeDays: number;
  leadTimeSource: "supplier" | "default";
  safetyDays: number;
  orderBy: DayKey;
  late: boolean;
  /** Per unit, store currency: cost, else retail price; null when neither is known. */
  unitValue: number | null;
  valueBasis: ValueBasis;
  lineValue: number | null;
}

export interface PlannerGroup {
  key: string;
  kind: "supplier" | "vendor";
  supplierId: string | null;
  name: string;
  leadTimeDays: number;
  leadTimeSource: "supplier" | "default";
  /** The supplier's minimum total units per order (null = none); lines are topped up to it. */
  minOrderTotal?: number | null;
  /** Lines were raised to reach the supplier's order minimum. */
  toppedUp?: boolean;
  orderBy: DayKey | null;
  late: boolean;
  units: number;
  /** Known line values summed; `missing` lines have neither cost nor price. */
  value: number | null;
  missing: number;
  retail: number;
  lines: PlannerLine[];
}

export interface CashWeek {
  /** Monday of the week. */
  weekStart: DayKey;
  week: string;
  amount: number;
  lines: number;
  /** Lines valued at retail price (no cost). */
  retail: number;
  /** Lines with neither cost nor price (not in the amount). */
  missing: number;
  /** The week holds late lines (order-by already past). */
  late: boolean;
}

export interface CollectionDemand {
  collectionId: string;
  units: number;
  /** null when no variant in it has a price. */
  revenue: number | null;
  variants: number;
  missingPrice: number;
}

export interface SeasonSummary {
  level: "store";
  applied: boolean;
  reason: SeasonalReason;
  value: number;
  raw: number | null;
  yearsBack: number;
  spanFrom: DayKey;
  spanTo: DayKey;
  spanPerDay: number | null;
  baseFrom: DayKey;
  baseTo: DayKey;
  basePerDay: number | null;
  trend: number;
  trendApplied: boolean;
  /** Variants that used their collection's index instead of the store's. */
  collectionVariants: number;
}

export type ResultStatus = "ok" | "no_data" | "no_baseline";

export interface ScenarioResult {
  version: typeof RESULT_VERSION;
  status: ResultStatus;
  computedAt: string;
  today: DayKey;
  period: { start: DayKey; end: DayKey; effectiveStart: DayKey; days: number; daysUntilStart: number };
  currency: string;
  plan: { type: TargetType; value: number; multiplier: number | null; baselineUnits: number | null; baselineRevenue: number | null };
  history: { enough: boolean; from: DayKey | null };
  season: SeasonSummary;
  totals: {
    /** Store total, each variant once. */
    units: number | null;
    revenue: number | null;
    /** Variants with demand. */
    variants: number;
    /** Variants without enough sales to advise. */
    noData: number;
    missingPrice: number;
  };
  collections: CollectionDemand[];
  groups: PlannerGroup[];
  order: { lines: number; units: number; late: number };
  cash: { weeks: CashWeek[]; total: number | null; retail: number; missing: number };
  lastYear: LastYearFigures;
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const round2 = (v: number) => Math.round(v * 100) / 100;
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Per-unit value in the store currency: cost when it is in the store currency, else retail price. */
export function unitValueOf(v: Pick<PlannerVariant, "cost" | "costCurrency" | "price">, currency: string): { value: number | null; basis: ValueBasis } {
  const cost = unitCostIn(v.cost, v.costCurrency, currency, currency);
  if (cost !== null && cost > 0) return { value: cost, basis: "cost" };
  if (finite(v.price) && v.price > 0) return { value: v.price, basis: "retail" };
  return { value: null, basis: null };
}

/** Cash per ISO week of the order-by date; late lines count in this week. Gaps are real zeros. */
export function cashByWeek(lines: readonly Pick<PlannerLine, "orderBy" | "late" | "lineValue" | "valueBasis">[], today: DayKey): CashWeek[] {
  if (!lines.length) return [];
  const thisWeek = weekStart(today);
  const byWeek = new Map<DayKey, CashWeek>();
  for (const l of lines) {
    const ws = l.late ? thisWeek : weekStart(l.orderBy);
    const w = byWeek.get(ws) ?? { weekStart: ws, week: isoWeek(ws), amount: 0, lines: 0, retail: 0, missing: 0, late: false };
    w.lines++;
    if (l.late) w.late = true;
    if (l.lineValue === null) w.missing++;
    else {
      w.amount += l.lineValue;
      if (l.valueBasis === "retail") w.retail++;
    }
    byWeek.set(ws, w);
  }
  const keys = [...byWeek.keys()].sort();
  const out: CashWeek[] = [];
  for (let ws = keys[0]!; ws <= keys[keys.length - 1]!; ws = addDays(ws, 7)) {
    const w = byWeek.get(ws) ?? { weekStart: ws, week: isoWeek(ws), amount: 0, lines: 0, retail: 0, missing: 0, late: false };
    out.push({ ...w, amount: round2(w.amount) });
  }
  return out;
}

/** The scenario's order list, demand per collection and cash per week. */
export function computeScenario(input: PlannerInput): ScenarioResult {
  const today = toDayKey(input.today);
  const season = input.season;
  const from = season.effectiveStart;
  const days = daysBetween(from, input.end) + 1;
  const store = season.store();
  const settings = resolveSettings({ leadTimeDays: input.defaultLeadTimeDays });

  // Baseline (plan 1) per variant with advice.
  type Row = { v: PlannerVariant; s: VariantPeriodSeason; base: number; gapDemand: number };
  const rows: Row[] = [];
  let noData = 0;
  for (const v of input.variants) {
    if (!v.enoughData || !finite(v.rate) || v.rate < 0 || !finite(v.sigma)) {
      noData++;
      continue;
    }
    const s = season.forVariant(v.collections ?? []);
    const base = v.rate * s.period.value * s.trend.value * days;
    const gapDemand = s.gap ? v.rate * s.gap.value * s.trend.value * season.gapDays : 0;
    rows.push({ v, s, base, gapDemand });
  }
  let baselineUnits = 0;
  let baselineRevenue = 0;
  let priced = 0;
  for (const r of rows) {
    baselineUnits += r.base;
    if (finite(r.v.price) && r.v.price > 0) {
      baselineRevenue += r.base * r.v.price;
      priced++;
    }
  }
  const multiplier =
    input.targetType === "keep_pace"
      ? planMultiplier({ type: "keep_pace" })
      : input.targetType === "growth"
        ? planMultiplier({ type: "growth", pct: input.targetValue })
        : planMultiplier({ type: "revenue", target: input.targetValue, baselineRevenue: priced ? baselineRevenue : null });

  const status: ResultStatus = !rows.length ? "no_data" : multiplier === null ? "no_baseline" : "ok";
  const plan = multiplier ?? 0;

  // Demand per collection and in total.
  const collections = new Map<string, CollectionDemand>();
  let totalUnits = 0;
  let totalRevenue = 0;
  let missingPrice = 0;
  const groups = new Map<string, PlannerGroup>();
  /** Forecast sales per day per ordered variant: the top-up weight (as Reorder). */
  const weightOf = new Map<string, number>();
  if (status === "ok") {
    for (const r of rows) {
      const demand = r.base * plan;
      const hasPrice = finite(r.v.price) && r.v.price > 0;
      totalUnits += demand;
      if (hasPrice) totalRevenue += demand * r.v.price!;
      else missingPrice++;
      for (const c of new Set(r.v.collections ?? [])) {
        const cd = collections.get(c) ?? { collectionId: c, units: 0, revenue: null, variants: 0, missingPrice: 0 };
        cd.units += demand;
        cd.variants++;
        if (hasPrice) cd.revenue = (cd.revenue ?? 0) + demand * r.v.price!;
        else cd.missingPrice++;
        collections.set(c, cd);
      }

      // Order line.
      const supplier = supplierFor(r.v, input.suppliers);
      const lead = resolveLeadTime(supplier?.leadTimeDays ?? null, settings);
      const safety = safetyStock(finite(r.v.z) ? r.v.z : 0, r.v.sigma!, lead.days);
      const sDays = r.v.rate! > 0 ? safety / r.v.rate! : 0;
      const stockAtStart = Math.max(0, r.v.onHand + Math.max(0, r.v.incoming) - r.gapDemand);
      const pack = casePackFor(r.v.caseQty, supplier);
      const moq = supplier?.minOrder ?? null;
      const qty = lineQuantity(demand + safety - stockAtStart, pack, moq);
      if (!(qty > 0)) continue;
      weightOf.set(r.v.id, r.v.rate!);
      const orderBy = orderByDate(from, 0, lead.days, sDays)!;
      const late = orderBy < today;
      const value = unitValueOf(r.v, input.currency);
      const line: PlannerLine = {
        variantId: r.v.id,
        productId: r.v.productId,
        productTitle: r.v.productTitle,
        variantTitle: r.v.variantTitle,
        sku: r.v.sku,
        image: r.v.image,
        demand: round1(demand),
        safety: round1(safety),
        stockAtStart: round1(stockAtStart),
        onHand: r.v.onHand,
        incoming: Math.max(0, r.v.incoming),
        gapDemand: round1(r.gapDemand),
        qty,
        pack,
        moq,
        leadTimeDays: lead.days,
        leadTimeSource: lead.source,
        safetyDays: round1(sDays),
        orderBy,
        late,
        unitValue: value.value,
        valueBasis: value.basis,
        lineValue: value.value === null ? null : round2(value.value * qty),
      };
      const key = supplier ? supplierGroupKey(supplier.id) : vendorGroupKey(r.v.vendor);
      const g =
        groups.get(key) ??
        groups
          .set(key, {
            key,
            kind: supplier ? "supplier" : "vendor",
            supplierId: supplier?.id ?? null,
            name: supplier ? supplier.name : (r.v.vendor ?? "").trim(),
            leadTimeDays: lead.days,
            leadTimeSource: lead.source,
            minOrderTotal: supplier?.minOrderTotal ?? null,
            toppedUp: false,
            orderBy: null,
            late: false,
            units: 0,
            value: null,
            missing: 0,
            retail: 0,
            lines: [],
          })
          .get(key)!;
      g.lines.push(line);
      g.units += qty;
      if (line.lineValue === null) g.missing++;
      else g.value = round2((g.value ?? 0) + line.lineValue);
      if (line.valueBasis === "retail") g.retail++;
      if (!g.orderBy || orderBy < g.orderBy) g.orderBy = orderBy;
      if (late) g.late = true;
    }
  }

  const groupList = [...groups.values()];
  for (const g of groupList) {
    g.lines.sort(
      (a, b) =>
        a.orderBy.localeCompare(b.orderBy) ||
        a.productTitle.localeCompare(b.productTitle) ||
        a.variantTitle.localeCompare(b.variantTitle) ||
        (a.variantId < b.variantId ? -1 : 1),
    );
    // The supplier's order-total minimum, topped up exactly as Reorder does (review fix).
    const top = topUpToMinimum(
      g.lines.map((l) => ({ qty: l.qty, pack: l.pack, weight: weightOf.get(l.variantId) ?? 0 })),
      g.minOrderTotal ?? null,
    );
    if (top.toppedUp) {
      g.toppedUp = true;
      g.units = 0;
      g.value = null;
      g.lines.forEach((l, i) => {
        l.qty = top.qtys[i]!;
        l.lineValue = l.unitValue === null ? null : round2(l.unitValue * l.qty);
        g.units += l.qty;
        if (l.lineValue !== null) g.value = round2((g.value ?? 0) + l.lineValue);
      });
    }
  }
  groupList.sort(
    (a, b) => (a.orderBy ?? "9999").localeCompare(b.orderBy ?? "9999") || Number(a.kind === "vendor") - Number(b.kind === "vendor") || a.name.localeCompare(b.name),
  );
  const allLines = groupList.flatMap((g) => g.lines);
  const weeks = cashByWeek(allLines, today);
  const known = allLines.filter((l) => l.lineValue !== null);

  const storePeriod = store.period;
  return {
    version: RESULT_VERSION,
    status,
    computedAt: input.computedAt,
    today,
    period: { start: input.start, end: input.end, effectiveStart: from, days, daysUntilStart: season.gapDays },
    currency: input.currency,
    plan: {
      type: input.targetType,
      value: input.targetValue,
      multiplier: multiplier === null ? null : Math.round(multiplier * 10000) / 10000,
      baselineUnits: rows.length ? round1(baselineUnits) : null,
      baselineRevenue: priced ? round2(baselineRevenue) : null,
    },
    history: { enough: hasSeasonHistory(input.coverage, today), from: input.coverage.from },
    season: {
      level: "store",
      applied: storePeriod.applied,
      reason: storePeriod.reason,
      value: storePeriod.value,
      raw: storePeriod.raw,
      yearsBack: storePeriod.yearsBack,
      spanFrom: storePeriod.span.from,
      spanTo: storePeriod.span.to,
      spanPerDay: storePeriod.span.unitsPerDay,
      baseFrom: storePeriod.base.from,
      baseTo: storePeriod.base.to,
      basePerDay: storePeriod.base.unitsPerDay,
      trend: store.trend.value,
      trendApplied: store.trend.applied,
      collectionVariants: rows.filter((r) => r.s.level === "collection").length,
    },
    totals: {
      units: status === "ok" ? round1(totalUnits) : null,
      revenue: status === "ok" && rows.length > missingPrice ? round2(totalRevenue) : null,
      variants: status === "ok" ? rows.length : 0,
      noData,
      missingPrice,
    },
    collections: [...collections.values()]
      .map((c) => ({ ...c, units: round1(c.units), revenue: c.revenue === null ? null : round2(c.revenue) }))
      .sort((a, b) => (b.revenue ?? -1) - (a.revenue ?? -1) || b.units - a.units || (a.collectionId < b.collectionId ? -1 : 1)),
    groups: groupList,
    order: { lines: allLines.length, units: allLines.reduce((a, l) => a + l.qty, 0), late: allLines.filter((l) => l.late).length },
    cash: {
      weeks,
      total: known.length ? round2(known.reduce((a, l) => a + l.lineValue!, 0)) : null,
      retail: allLines.filter((l) => l.valueBasis === "retail").length,
      missing: allLines.filter((l) => l.lineValue === null).length,
    },
    lastYear: input.lastYear,
  };
}

/** A stored Scenario.result, or null when absent, malformed or an older version (recalculate). */
export function readScenarioResult(raw: unknown): ScenarioResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ScenarioResult>;
  if (r.version !== RESULT_VERSION || !Array.isArray(r.groups) || !r.cash || !Array.isArray(r.cash.weeks) || !r.period || !r.totals) return null;
  return r as ScenarioResult;
}

/**
 * `/app/reorder?variants=…` for the scenario's order lines (numeric ids, at most 250 — Reorder's
 * cap). Lines with a planned quantity are written `id:qty` so Reorder starts them at
 * max(planned, its everyday suggestion) (review fix: the planned quantities used to be lost).
 */
export function reorderLink(lines: readonly (string | { variantId: string; qty?: number | null })[]): string {
  const qtyOf = new Map<string, number | null>();
  for (const l of lines) {
    const id = /(\d+)$/.exec(typeof l === "string" ? l : l.variantId)?.[1];
    if (!id) continue;
    const q = typeof l === "string" ? null : l.qty;
    const qty = typeof q === "number" && Number.isInteger(q) && q > 0 ? q : null;
    const cur = qtyOf.get(id);
    qtyOf.set(id, cur == null ? qty : qty == null ? cur : Math.max(cur, qty));
  }
  const parts = [...qtyOf].slice(0, 250).map(([id, q]) => (q == null ? id : `${id}:${q}`));
  return parts.length ? `/app/reorder?variants=${parts.join(",")}` : "/app/reorder";
}

// ---------------------------------------------------------------------------
// Cash chart geometry (inline SVG, spec §13)
// ---------------------------------------------------------------------------

export interface BarGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  week: CashWeek;
}

/** Bars for an SVG of `width` × `height` with `pad` px for the axis labels; the tallest bar fills the plot. */
export function cashBars(weeks: readonly CashWeek[], width: number, height: number, pad = 24): BarGeometry[] {
  if (!weeks.length) return [];
  const max = Math.max(...weeks.map((w) => w.amount), 0);
  const plotH = height - pad;
  const slot = width / weeks.length;
  const barW = Math.max(2, Math.min(48, slot * 0.7));
  return weeks.map((w, i) => {
    const h = max > 0 ? Math.max(w.amount > 0 ? 2 : 0, (w.amount / max) * (plotH - 4)) : 0;
    return { x: i * slot + (slot - barW) / 2, y: plotH - h, width: barW, height: h, week: w };
  });
}

// ---------------------------------------------------------------------------
// Collection goals (spec §5.4)
// ---------------------------------------------------------------------------

export const GOAL_BOUNDS = { min: 0, max: 100 } as const;
export const MAX_GOALS = 50;
/** Look-back for the actual share (channel view, store revenue as the denominator). */
export const GOAL_WINDOW_DAYS = 90;
export const HOLDING_BACK_MAX = 3;

export type GoalErrorCode = "collection" | "pct" | "limit";

export function readGoalPct(v: unknown): number | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(",", ".") : "";
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= GOAL_BOUNDS.min && n <= GOAL_BOUNDS.max ? Math.round(n * 10) / 10 : null;
}

/** A goal to save: the collection must be one of the store's; 0–100 %; at most MAX_GOALS goals. */
export function validateGoal(
  raw: { collectionId: unknown; goalPct: unknown },
  ctx: { collectionIds: ReadonlySet<string>; existing: readonly string[] },
): { ok: true; collectionId: string; goalPct: number } | { ok: false; error: GoalErrorCode } {
  const id = typeof raw.collectionId === "string" ? raw.collectionId : "";
  if (!ctx.collectionIds.has(id)) return { ok: false, error: "collection" };
  const pct = readGoalPct(raw.goalPct);
  if (pct === null) return { ok: false, error: "pct" };
  if (!ctx.existing.includes(id) && ctx.existing.length >= MAX_GOALS) return { ok: false, error: "limit" };
  return { ok: true, collectionId: id, goalPct: pct };
}

export function goalErrorText(code: GoalErrorCode, t: T): string {
  switch (code) {
    case "collection":
      return t("Pick a collection.");
    case "pct":
      return t("Enter a share from 0% to 100%.");
    case "limit":
      return t("You can set up to 50 collection goals.");
  }
}

export interface GoalProduct {
  productId: string;
  title: string;
  /** Σ open Reorder / Bridge action figures (sales at risk); null when none. */
  atRisk: number | null;
  out: number;
  low: number;
}

export interface GoalRow {
  collectionId: string;
  title: string | null;
  goalPct: number;
  /** Share of store revenue over the last 90 days, 0–1; null when store revenue is unknown or 0. */
  actualShare: number | null;
  revenue: number | null;
  /** goal − actual, in percentage points; null when the actual is unknown. */
  gapPts: number | null;
  holdingBack: GoalProduct[];
}

export interface GoalInput {
  goals: readonly { collectionId: string; goalPct: number }[];
  titles: ReadonlyMap<string, string>;
  variants: readonly { id: string; productId: string; productTitle: string; collections: readonly string[] }[];
  /** Gross revenue per variant over the window (channel view). */
  revenue: ReadonlyMap<string, number>;
  /** Σ gross over the window for the whole store (channel view, every variant); null when no data. */
  storeRevenue: number | null;
  /** VariantMetric status per variant (online pool). */
  status: ReadonlyMap<string, string>;
  /** Open action figures per product (Reorder / Bridge). */
  atRisk: ReadonlyMap<string, number>;
}

/** Actual share, gap and the products holding each collection back (most at risk / out first). */
export function goalRows(input: GoalInput): GoalRow[] {
  const members = new Map<string, typeof input.variants[number][]>();
  for (const v of input.variants) for (const c of new Set(v.collections)) (members.get(c) ?? members.set(c, []).get(c)!).push(v);
  return input.goals.map((g) => {
    const vs = members.get(g.collectionId) ?? [];
    const rev = vs.reduce((a, v) => a + (input.revenue.get(v.id) ?? 0), 0);
    const share = input.storeRevenue && input.storeRevenue > 0 ? rev / input.storeRevenue : null;
    const products = new Map<string, GoalProduct & { revenue: number }>();
    for (const v of vs) {
      const p =
        products.get(v.productId) ??
        products.set(v.productId, { productId: v.productId, title: v.productTitle, atRisk: input.atRisk.get(v.productId) ?? null, out: 0, low: 0, revenue: 0 }).get(v.productId)!;
      const st = input.status.get(v.id);
      if (st === "out") p.out++;
      if (st === "running_low") p.low++;
      p.revenue += input.revenue.get(v.id) ?? 0;
    }
    const holdingBack = [...products.values()]
      .filter((p) => (p.atRisk ?? 0) > 0 || p.out > 0 || p.low > 0)
      .sort((a, b) => (b.atRisk ?? 0) - (a.atRisk ?? 0) || b.out - a.out || b.low - a.low || b.revenue - a.revenue || (a.productId < b.productId ? -1 : 1))
      .slice(0, HOLDING_BACK_MAX)
      .map(({ revenue: _r, ...p }) => p);
    return {
      collectionId: g.collectionId,
      title: input.titles.get(g.collectionId) || null,
      goalPct: g.goalPct,
      actualShare: share,
      revenue: input.storeRevenue === null ? null : round2(rev),
      gapPts: share === null ? null : round1(g.goalPct - share * 100),
      holdingBack,
    };
  });
}

/** Σ goal %; above 100 is allowed (collections overlap). */
export function goalsTotal(goals: readonly { goalPct: number }[]): number {
  return round1(goals.reduce((a, g) => a + g.goalPct, 0));
}

// ---------------------------------------------------------------------------
// Accuracy scorecard (spec §7.8)
// ---------------------------------------------------------------------------

export interface ScorecardRow {
  variantId: string;
  productTitle: string | null;
  variantTitle: string | null;
  predicted: number;
  actual: number | null;
  errorPct: number | null;
}

/**
 * The top-20 rows behind a graded month: the snapshotted variants ranked by revenue (> 0) over
 * rankingWindow(month) — the month before, as gradeMonth ranked them. The error is "—" when the
 * actual is not > 0.
 */
export function scorecardRows(
  snapshot: readonly { variantId: string; predicted: number; actual: number | null }[],
  revenue: ReadonlyMap<string, number>,
  titles: ReadonlyMap<string, { productTitle: string; variantTitle: string }>,
): ScorecardRow[] {
  return snapshot
    .filter((r) => r.variantId !== STORE_ROW && (revenue.get(r.variantId) ?? 0) > 0)
    .sort((a, b) => (revenue.get(b.variantId) ?? 0) - (revenue.get(a.variantId) ?? 0) || (a.variantId < b.variantId ? -1 : 1))
    .slice(0, ACCURACY_TOP)
    .map((r) => ({
      variantId: r.variantId,
      productTitle: titles.get(r.variantId)?.productTitle ?? null,
      variantTitle: titles.get(r.variantId)?.variantTitle ?? null,
      predicted: round1(r.predicted),
      actual: r.actual,
      errorPct: r.actual === null ? null : absPctError(r.predicted, r.actual),
    }));
}

/**
 * When the first scorecard arrives: the 1st of the month after the first snapshotted month.
 * No snapshot yet → the next 1st takes it, and the 1st after that grades it.
 */
export function firstScorecardDate(today: DayKey, snapshotMonth: DayKey | null): DayKey {
  return snapshotMonth ? nextMonthStart(snapshotMonth) : nextMonthStart(nextMonthStart(today));
}

// ---------------------------------------------------------------------------
// Data windows (the server reads only the days the maths needs)
// ---------------------------------------------------------------------------

export type DayRange = { from: DayKey; to: DayKey };

/** Sorted, overlapping or touching ranges merged; empty ranges (from > to) dropped. */
export function mergeDayRanges(ranges: readonly DayRange[]): DayRange[] {
  const list = ranges.filter((r) => r.from <= r.to).sort((a, b) => a.from.localeCompare(b.from));
  const out: DayRange[] = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r.from <= addDays(last.to, 1)) {
      if (r.to > last.to) last.to = r.to;
    } else out.push({ ...r });
  }
  return out;
}

/**
 * Every day the period maths reads, up to yesterday: the period's dates last year, today →
 * start last year (gap), the engine's base window and both trend windows.
 */
export function seasonWindows(today: DayKey, start: DayKey, end: DayKey): DayRange[] {
  const t = toDayKey(today);
  const yesterday = addDays(t, -1);
  const from = effectiveStart(start, t);
  const gap = daysBetween(t, from);
  const baseTo = shiftYears(yesterday, -1);
  const ly = lastYearSpan(t, from, end);
  const ranges: DayRange[] = [
    { from: addDays(baseTo, -(SEASON.baseDays - 1)), to: baseTo },
    { from: addDays(t, -SEASON.trendDays), to: yesterday },
    { from: addDays(t, -SEASON.trendDays - SEASON.trendShiftDays), to: addDays(yesterday, -SEASON.trendShiftDays) },
    { from: ly.from, to: ly.to },
  ];
  if (gap > 0) {
    const lyToday = shiftYears(t, -1);
    ranges.push({ from: lyToday, to: addDays(lyToday, Math.min(SEASON.maxHorizonDays, gap) - 1) });
  }
  return mergeDayRanges(ranges.map((r) => ({ from: r.from, to: r.to > yesterday ? yesterday : r.to })));
}
