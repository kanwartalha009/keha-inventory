/**
 * Home screen (spec §5.1, §4 J1): pure mapping from the database rows the
 * loader reads to what the page shows. Client-safe, no clock access (callers
 * pass `now`), no fake numbers: anything unknown stays null and renders "—".
 */
import { MONEY_CARDS, type MoneyBasisJson, type MoneyCardKey, type MoneySnapshot } from "./money-shared";
import { hasFeature, MONEY_REFRESH, type MoneyRefresh, type PlanCode } from "./plan-shared";
import { readSettings } from "./settings-shared";
import {
  DATASETS,
  backfillPercent,
  datasetPercent,
  isBackfillDone,
  isDataLate,
  readBackfillState,
  type Dataset,
} from "./sync/backfill-shared";
import { fill } from "./i18n";

type T = (s: string) => string;

/**
 * ASSUMPTION (spec §4 J1 is silent on the bar): the "Product costs" setup step
 * counts as done once at least 90% of tracked, non-bundle variants have a cost.
 */
export const COSTS_DONE_PCT = 90;

/** Spec §5.1 / §7.2: advice needs at least 14 days of sales. */
export const MIN_SALES_DAYS = 14;

export type HomeState = "syncing" | "noTracked" | "noSales" | "ready";

/** Raw facts the loader reads from the database (dashboard.server.ts). */
export type HomeRaw = {
  shop: {
    domain: string;
    currency: string;
    timezone: string;
    settings: unknown;
    backfillState: unknown;
    lastNightlyAt: Date | string | null;
  } | null;
  /** The latest MoneyAtStake row, amounts already converted to numbers. */
  money: {
    day: Date | string;
    atRisk: number | null;
    lost90: number | null;
    cashStuck: number | null;
    soldOutTraffic: number | null;
    basis: unknown;
  } | null;
  /** Tracked, non-bundle variants. */
  trackedVariants: number;
  /** Tracked, non-bundle variants with a cost. */
  variantsWithCost: number;
  /** Distinct days with at least one SalesDaily row (capped at MIN_SALES_DAYS by the query). */
  salesDays: number;
  /** Suppliers in Settings → Suppliers (setup guide step "Suppliers"); undefined = not read. */
  supplierCount?: number;
  /** Distinct, non-blank vendors in the catalog (Free's "Vendors found"); undefined = not read. */
  vendorCount?: number;
};

export type DatasetBar = { key: Dataset; percent: number; failed: boolean };

export type HomeData = {
  storeName: string;
  timezone: string | null;
  lastNightlyAt: string | null;
  /**
   * When the numbers were last worked out: the later of the last nightly run and the latest
   * money-at-stake computation (the first compute runs before the first nightly). Null = never.
   */
  updatedAt: string | null;
  /** "noSales": the earliest day the first order plan can appear (14 days of sales); else null. */
  noSalesReadyOn: string | null;
  dataLate: boolean;
  state: HomeState;
  refresh: MoneyRefresh;
  money: MoneySnapshot | null;
  /** `percent`: the whole read, 0–100 (mean of the datasets, as /health). */
  sync: { done: boolean; first90Ready: boolean; datasets: DatasetBar[]; percent: number };
  setup: {
    leadTimeDone: boolean;
    leadTimeDays: number;
    /** null = no tracked variants read yet. */
    costPercent: number | null;
    costsDone: boolean;
    mondayEnabled: boolean;
    mondayRecipients: string[];
    /** Growth and Pro keep suppliers; Free plans by vendor. */
    suppliersEnabled: boolean;
    supplierCount: number;
    /** null = the catalog isn't read yet. */
    vendorCount: number | null;
    /** Growth+: at least one supplier. Free: vendors stand in for suppliers, so nothing to do. */
    suppliersDone: boolean;
    allDone: boolean;
  };
};

/** "acme.myshopify.com" → "acme". The Shop row has no display name (spec §8). */
export function storeLabel(domain: string): string {
  return domain.replace(/\.myshopify\.com$/i, "");
}

/** Whole percent of tracked variants with a cost, rounded DOWN (89.9% is not 90%); null when none are tracked. */
export function costPercent(withCost: number, tracked: number): number | null {
  if (!Number.isFinite(tracked) || tracked <= 0) return null;
  const pct = Math.floor((Math.max(0, withCost) / tracked) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** Which body Home shows (spec §5.1 empty states). */
export function homeState(input: {
  hasShop: boolean;
  backfillDone: boolean;
  first90Ready: boolean;
  catalogDone: boolean;
  trackedVariants: number;
  salesDays: number;
}): HomeState {
  if (!input.hasShop) return "syncing";
  if (input.catalogDone && input.trackedVariants === 0) return "noTracked";
  const historyReady = input.first90Ready || input.backfillDone;
  if (!historyReady) return "syncing";
  if (input.salesDays < MIN_SALES_DAYS) return "noSales";
  return "ready";
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function dayKey(v: Date | string): string {
  return typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10);
}

/** Basis JSON with the four card objects, or null when it is malformed. */
export function readMoneyBasis(raw: unknown): MoneyBasisJson | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  for (const k of MONEY_CARDS) if (!b[k] || typeof b[k] !== "object") return null;
  return raw as MoneyBasisJson;
}

export function toMoneySnapshot(row: HomeRaw["money"], fallbackCurrency: string): MoneySnapshot | null {
  if (!row) return null;
  const basis = readMoneyBasis(row.basis);
  return {
    day: dayKey(row.day),
    currency: basis?.currency || fallbackCurrency,
    values: {
      atRisk: num(row.atRisk),
      lost90: num(row.lost90),
      cashStuck: num(row.cashStuck),
      soldOutTraffic: num(row.soldOutTraffic),
    },
    basis,
  };
}

/** The later of two ISO / Date times (either may be missing or invalid). */
function latestIso(...vals: Array<Date | string | null | undefined>): string | null {
  let best: number | null = null;
  for (const v of vals) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

/**
 * The earliest day the first order plan can show: SalesDaily holds yesterday and older
 * (I-12), so each missing day of sales lands the night after — today + the days still
 * missing. Days without any sale push it later (the plan simply appears once 14 days exist).
 */
export function firstPlanDay(today: string, salesDays: number): string {
  const missing = Math.max(1, MIN_SALES_DAYS - Math.max(0, Math.floor(salesDays)));
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + missing);
  return d.toISOString().slice(0, 10);
}

/** Everything Home renders, from the raw database facts. */
export function buildHome(raw: HomeRaw, plan: PlanCode, now: Date): HomeData {
  const settings = readSettings(raw.shop?.settings);
  const backfill = readBackfillState(raw.shop?.backfillState);
  const backfillDone = raw.shop ? isBackfillDone(backfill) : false;
  const first90Ready = !!backfill.first90Ready;
  const catalogDone = datasetPercent(backfill.datasets?.products) === 100 || backfillDone;
  const state = homeState({
    hasShop: !!raw.shop,
    backfillDone,
    first90Ready,
    catalogDone,
    trackedVariants: raw.trackedVariants,
    salesDays: raw.salesDays,
  });
  const pct = costPercent(raw.variantsWithCost, raw.trackedVariants);
  const leadTimeDone = !!settings.leadTimeConfirmedAt;
  const costsDone = pct !== null && pct >= COSTS_DONE_PCT;
  const mondayEnabled = settings.mondayEmail.enabled;
  const suppliersEnabled = hasFeature(plan, "suppliers");
  const supplierCount = raw.supplierCount ?? 0;
  const suppliersDone = suppliersEnabled ? supplierCount > 0 : true;
  const last = raw.shop?.lastNightlyAt ?? null;
  const computedAt = readMoneyBasis(raw.money?.basis)?.computedAt ?? null;
  return {
    storeName: raw.shop ? storeLabel(raw.shop.domain) : "",
    timezone: raw.shop?.timezone || null,
    lastNightlyAt: last ? new Date(last).toISOString() : null,
    updatedAt: raw.shop ? latestIso(last, computedAt) : null,
    noSalesReadyOn: state === "noSales" ? firstPlanDay(todayIn(raw.shop?.timezone, now), raw.salesDays) : null,
    dataLate: isDataLate(last, now),
    state,
    refresh: MONEY_REFRESH[plan],
    money: raw.shop ? toMoneySnapshot(raw.money, raw.shop.currency) : null,
    sync: {
      done: backfillDone,
      first90Ready,
      percent: raw.shop ? backfillPercent(backfill) : 0,
      datasets: DATASETS.map((key) => ({
        key,
        percent: datasetPercent(backfill.datasets?.[key]),
        failed: !!backfill.datasets?.[key]?.lastError,
      })),
    },
    setup: {
      leadTimeDone,
      leadTimeDays: settings.leadTimeDays,
      costPercent: pct,
      costsDone,
      mondayEnabled,
      mondayRecipients: settings.mondayEmail.recipients,
      suppliersEnabled,
      supplierCount,
      vendorCount: raw.vendorCount ?? (catalogDone ? 0 : null),
      suppliersDone,
      allDone: leadTimeDone && suppliersDone && costsDone && mondayEnabled,
    },
  };
}

// ── Order plan readiness (2026-10-17 click-through) ─────────────────────────
//
// The one rule behind every order-plan surface (Dashboard, Order now, Next 90 days, the Monday
// email, Sidekick): while Home isn't "ready" the plan isn't either — say so and why, never
// "nothing to order". Home's own state decides (homeState), so the surfaces can't disagree.

export type PlanNotReady =
  | { ready: false; state: "syncing"; percent: number }
  | { ready: false; state: "noSales"; readyOn: string | null }
  | { ready: false; state: "noTracked" };
export type PlanReadiness = { ready: true } | PlanNotReady;

export function planReadiness(home: Pick<HomeData, "state" | "noSalesReadyOn"> & { sync: Pick<HomeData["sync"], "percent"> }): PlanReadiness {
  switch (home.state) {
    case "ready":
      return { ready: true };
    case "syncing":
      return { ready: false, state: "syncing", percent: Math.max(0, Math.min(100, Math.round(home.sync.percent ?? 0))) };
    case "noSales":
      return { ready: false, state: "noSales", readyOn: home.noSalesReadyOn };
    case "noTracked":
      return { ready: false, state: "noTracked" };
  }
}

/**
 * Why the plan isn't ready, in the merchant's language: "Still reading your store: 43%. …",
 * "Your first order plan needs 14 days of sales — expected on 31 Oct 2026.", or "Turn on
 * 'Track quantity' …". `day` / `percent` format in the admin's (or the email's) locale.
 */
export function notReadyText(r: PlanNotReady, t: T, f: { day: (d: string) => string; percent: (ratio: number) => string }): string {
  switch (r.state) {
    case "syncing":
      return fill(t("Still reading your store: {pct}. Your first order plan appears once your products, stock and sales are read."), { pct: f.percent(r.percent / 100) });
    case "noSales":
      return r.readyOn
        ? fill(t("Your first order plan needs 14 days of sales — expected on {date}."), { date: f.day(r.readyOn) })
        : t("Your first order plan needs 14 days of sales.");
    case "noTracked":
      return t("Turn on 'Track quantity' for your products in Shopify.");
  }
}

// ── Formatting (admin locale, store currency / time zone) ──────────────────

/** Store-currency amount, whole units; null → "—" (never 0, invariant I-5). */
export function formatAmount(value: number | null | undefined, currency: string, locale: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${Math.round(value)} ${currency}`;
  }
}

export function formatCount(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

export function formatPercent(ratio: number | null | undefined, locale: string): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  try {
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(ratio);
  } catch {
    return `${Math.round(ratio * 10000) / 100}%`;
  }
}

/** "YYYY-MM-DD" → localized short date ("12 Nov 2026"). */
export function formatDay(day: string | null | undefined, locale: string): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "—";
  try {
    return new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return day;
  }
}

/** Last nightly sync in the store's time zone ("16 Oct, 06:10"); "—" when it never ran. */
export function formatUpdatedAt(iso: string | null, timeZone: string | null, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: timeZone || "UTC" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en", { ...opts, timeZone: "UTC" }).format(d);
  }
}

/**
 * The Dashboard's quiet header line: "Updated 06:10 today", "Updated 16 Oct, 06:10", or
 * "First sync in progress" before the first nightly run (never a lone dash).
 */
export function updatedLabel(iso: string | null, timeZone: string | null, locale: string, now: Date, t: T): string {
  const d = iso ? new Date(iso) : null;
  if (!d || !Number.isFinite(d.getTime())) return t("First sync in progress");
  if (todayIn(timeZone, d) === todayIn(timeZone, now)) {
    let time: string;
    try {
      time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: timeZone || "UTC" }).format(d);
    } catch {
      time = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(d);
    }
    return fill(t("Updated {time} today"), { time });
  }
  return fill(t("Updated {time}"), { time: formatUpdatedAt(iso, timeZone, locale) });
}

/** Today's calendar day in the store's time zone, "YYYY-MM-DD". */
export function todayIn(timeZone: string | null | undefined, now: Date): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// ── Labels (literal t() calls so the coverage test sees every string) ───────

export function moneyCardTitle(key: MoneyCardKey, t: T): string {
  switch (key) {
    case "atRisk":
      return t("Sales at risk (next 28 days)");
    case "lost90":
      return t("Sales lost to sell-outs (last 90 days)");
    case "cashStuck":
      return t("Cash stuck");
    case "soldOutTraffic":
      return t("Sold-out page visits (last 30 days)");
  }
}

export function datasetLabel(key: Dataset, t: T): string {
  switch (key) {
    case "products":
      return t("Products");
    case "stock":
      return t("Stock history");
    case "sales":
      return t("Sales history");
    case "visits":
      return t("Store visits");
  }
}

export type Fmt = {
  money: (v: number | null | undefined) => string;
  count: (v: number | null | undefined) => string;
  percent: (v: number | null | undefined) => string;
  day: (v: string | null | undefined) => string;
};

/**
 * The "How we got this" lines for one card (spec §2.4, §12): the inputs, then
 * a last line "Based on: …" with the window. Empty when the basis is unknown.
 */
export function basisLines(key: MoneyCardKey, basis: MoneyBasisJson | null, t: T, f: Fmt): string[] {
  if (!basis) return [];
  const card = basis[key];
  const w = card.window;
  const range = w ? fill(t("{from} to {to}"), { from: f.day(w.from), to: f.day(w.to) }) : "—";
  const retail = card.costBasis === "retail" ? [t("Valued at retail price")] : [t("Valued at cost")];
  const lines: string[] = [];
  const add = (text: string, vars: Record<string, string>) => lines.push(fill(text, vars));
  switch (key) {
    case "atRisk": {
      const b = basis.atRisk;
      add(t("Variants running low or out: {n}"), { n: f.count(b.candidates) });
      add(t("Variants counted: {n}"), { n: f.count(b.variantsCounted) });
      if (b.skippedNoRate) add(t("Skipped, no sales rate yet: {n}"), { n: f.count(b.skippedNoRate) });
      if (b.skippedNoPrice) add(t("Skipped, no price: {n}"), { n: f.count(b.skippedNoPrice) });
      if (b.incomingAssumedWithin28) lines.push(t("Assumes stock on order arrives within 28 days"));
      lines.push(...retail);
      add(t("Based on: sales per day while in stock, stock now and stock on order, {range}"), { range });
      break;
    }
    case "lost90": {
      const b = basis.lost90;
      add(t("Variants counted: {n}"), { n: f.count(b.variantsCounted) });
      add(t("Sold-out days: {n}"), { n: f.count(b.outOfStockDays) });
      if (b.skippedNoRate) add(t("Skipped, no sales rate yet: {n}"), { n: f.count(b.skippedNoRate) });
      if (b.skippedNoPrice) add(t("Skipped, no price: {n}"), { n: f.count(b.skippedNoPrice) });
      lines.push(...retail);
      add(t("Based on: sold-out days × sales per day while in stock × price, {range}"), { range });
      break;
    }
    case "cashStuck": {
      const b = basis.cashStuck;
      add(t("Variants with too much stock: {n}"), { n: f.count(b.tooMuchCount) });
      add(t("Dead-stock variants: {n}"), { n: f.count(b.deadCount) });
      if (b.skippedNoValue) add(t("Skipped, no cost or price: {n}"), { n: f.count(b.skippedNoValue) });
      if (card.costBasis === "retail") {
        add(t("Valued at retail price, no cost found: {n}"), { n: f.count(b.retailCount) });
      } else {
        lines.push(t("Valued at cost"));
      }
      add(t("Based on: stock beyond {days} days of sales, plus all stock of dead products, {range}"), {
        days: f.count(b.coverDays),
        range,
      });
      break;
    }
    case "soldOutTraffic": {
      const b = basis.soldOutTraffic;
      add(t("Products with visit data: {n}"), { n: f.count(b.productsWithData) });
      add(t("Products sold out: {n}"), { n: f.count(b.productsSoldOut) });
      add(t("Visits to sold-out pages: {n}"), { n: f.count(b.soldOutSessions) });
      add(t("Store conversion rate: {rate}"), { rate: f.percent(b.conversionRate) });
      add(t("Average order value: {aov}"), { aov: f.money(b.aov) });
      add(t("Based on: sold-out page visits × conversion rate × average order value, {range}"), { range });
      break;
    }
  }
  return lines;
}
