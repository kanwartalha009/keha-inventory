/**
 * The first-sync screen (owner 2026-10-17, "sync experience for big stores"): what the Dashboard
 * shows while we read a store — five stages (Products → Stock history → Sales history → Store
 * visits → Building your plan), each with its own progress, an ETA measured from this store's own
 * read, the store's size, partial-data labels and plain error copy naming the month that failed.
 *
 * Pure and client-safe: built from Shop.backfillState through the existing backfill-state API
 * (lib/sync/backfill-shared) — nothing here reads or writes storage. No clock access (callers
 * pass `now`); nothing unknown is invented (null = "—" / "Working out how long this takes…").
 *
 * ETA. The backfill runs as jobs on the queue (services/jobs): products first, then one calendar
 * month of one history dataset per step, a few steps per job, every store taking its turn. So
 * the honest throughput is this store's own: history months finished per minute since the
 * history started (the products pass's finishedAt) — queue waits, throttles and other stores'
 * turns are all inside that number. Remaining months ÷ that rate + the final plan build is the
 * ETA ("measured"). Before the first months are in there is nothing to measure; then a first
 * estimate from the store's size (tracked variants) stands in ("estimate", ASSUMED per-step
 * timings below), replaced by the measured one as soon as MIN_MEASURED_UNITS months are in.
 */
import { DATASETS, HISTORY_DATASETS, HISTORY_MONTHS, datasetPercent, type BackfillState, type Dataset, type DatasetProgress } from "./sync/backfill-shared";
import { monthChunks, type DayRange } from "./sync/shopifyql-shared";
import { fill } from "./i18n";

type T = (s: string) => string;

export const SYNC_STAGES = ["products", "stock", "sales", "visits", "plan"] as const;
export type SyncStageKey = (typeof SYNC_STAGES)[number];

/**
 * done: finished · running: in progress · waiting: not started · retrying: the last try failed,
 * the job tries again by itself · gaps: finished, but some months could not be read.
 */
export type SyncStageStatus = "done" | "running" | "waiting" | "retrying" | "gaps";

export type SyncStage = {
  key: SyncStageKey;
  status: SyncStageStatus;
  /** 0–100; null for the plan build (no partial progress to show). */
  percent: number | null;
  /** History stages: months read / months to read. */
  done: number | null;
  total: number | null;
  /** The month the last failed try was reading (first day, YYYY-MM-DD); products: null. */
  failedMonth: string | null;
  /** Months skipped after repeated failures (first days). */
  skippedMonths: string[];
};

/** Store size from tracked variants: S < 2,000 · M < 20,000 · L from 20,000 (null = catalog not read yet). */
export type StoreSize = "S" | "M" | "L";
export const SIZE_M_FROM = 2_000;
export const SIZE_L_FROM = 20_000;

export function storeSize(variants: number | null | undefined, catalogDone: boolean): StoreSize | null {
  if (!catalogDone || variants === null || variants === undefined || !Number.isFinite(variants)) return null;
  if (variants >= SIZE_L_FROM) return "L";
  if (variants >= SIZE_M_FROM) return "M";
  return "S";
}

/** A measured ETA needs at least this many history months done (one round of the datasets is too noisy). */
export const MIN_MEASURED_UNITS = 4;
/** …and at least this much time since the history started. */
export const MIN_MEASURED_MS = 60_000;

/**
 * First-estimate timings before anything is measured (ASSUMED — not measured on a real store;
 * the measured rate replaces them after MIN_MEASURED_UNITS months): one history month of one
 * dataset, the products pass, and the final plan build, each a fixed part plus a part per
 * 1,000 tracked variants.
 */
export const PRIOR = {
  stepMs: 20_000,
  stepPerKVariantMs: 6_000,
  productsMs: 60_000,
  productsPerKVariantMs: 4_000,
  buildMs: 60_000,
  buildPerKVariantMs: 3_000,
} as const;

export type SyncEta = { minutes: number; basis: "measured" | "estimate" } | null;

export type SyncView = {
  stages: SyncStage[];
  /** Whole read 0–100 (mean of the four datasets, as /health and "Still reading your store"). */
  percent: number;
  eta: SyncEta;
  size: StoreSize | null;
  /** Tracked variants (null before the catalog is read). */
  variants: number | null;
  /** Months of history we read at install. */
  months: number;
  /** Months of stock AND sales read so far (what the partial numbers are based on). */
  monthsRead: number;
  /** Numbers exist but older months are still loading ("Based on the last 90 days so far"). */
  partial: boolean;
  /** The plan-ready email will go out (transport set, Monday email on, not sent yet). */
  emailOnReady: boolean;
  /** Every stage is done. */
  complete: boolean;
};

export type SyncViewInput = {
  state: BackfillState;
  now: Date;
  /** Tracked, non-bundle variants (HomeRaw.trackedVariants). */
  trackedVariants: number;
  catalogDone: boolean;
  /** When the plan (money at stake) was last computed (ISO), null = never. */
  planBuiltAt: string | null;
  emailOnReady: boolean;
};

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

/** The history months (newest first), as the backfill reads them. */
export function syncChunks(state: BackfillState): DayRange[] {
  const r = state.range;
  if (!r?.from || !r?.until) return [];
  try {
    return monthChunks(r.from, r.until);
  } catch {
    return [];
  }
}

/** A real failure to show: a throttle (Shopify's rate window) is only a pause, not the merchant's problem. */
const failing = (p: DatasetProgress | undefined) => !!p?.lastError && p.lastErrorCode !== "throttled";

function historyStage(key: Exclude<Dataset, "products">, p: DatasetProgress | undefined, chunks: DayRange[]): SyncStage {
  const total = p?.total || chunks.length || HISTORY_MONTHS;
  const done = Math.min(total, Math.max(0, p?.done ?? 0));
  const skipped = [...(p?.skippedMonths ?? [])];
  const failedMonth = failing(p) && done < total ? (chunks[done]?.since ?? null) : null;
  const finished = done >= total;
  const status: SyncStageStatus = finished
    ? skipped.length
      ? "gaps"
      : "done"
    : failing(p)
      ? "retrying"
      : done > 0
        ? "running"
        : "waiting";
  return { key, status, percent: datasetPercent(p ? { ...p, done, total } : undefined), done, total, failedMonth, skippedMonths: skipped };
}

function productsStage(p: DatasetProgress | undefined): SyncStage {
  const pct = datasetPercent(p);
  const status: SyncStageStatus = pct >= 100 ? "done" : failing(p) ? "retrying" : p?.stage || p?.cursorStartedAt ? "running" : "waiting";
  return { key: "products", status, percent: pct, done: null, total: null, failedMonth: null, skippedMonths: [] };
}

/** The plan build: waits for the history, runs until a plan computed after the read finished exists. */
function planStage(state: BackfillState, historyDone: boolean, planBuiltAt: string | null): SyncStage {
  const finished = ms(state.finishedAt);
  const built = ms(planBuiltAt);
  const done = historyDone && built !== null && (finished === null || built >= finished);
  const status: SyncStageStatus = done ? "done" : historyDone ? "running" : "waiting";
  return { key: "plan", status, percent: null, done: null, total: null, failedMonth: null, skippedMonths: [] };
}

const perK = (variants: number) => Math.max(0, variants) / 1000;

/** Minutes left (whole, at least 1) — measured from this store's read once enough is in, else a first estimate. */
export function syncEta(input: SyncViewInput, stages: SyncStage[]): SyncEta {
  const { state, now, trackedVariants } = input;
  if (stages.every((s) => s.status === "done" || s.status === "gaps")) return null;
  const chunks = syncChunks(state);
  const months = chunks.length || HISTORY_MONTHS;
  let unitsDone = 0;
  let unitsLeft = 0;
  for (const d of HISTORY_DATASETS) {
    const p = state.datasets?.[d];
    const total = p?.total || months;
    const done = Math.min(total, Math.max(0, p?.done ?? 0));
    unitsDone += done;
    unitsLeft += total - done;
  }
  const v = Math.max(0, trackedVariants || 0);
  const productsDone = datasetPercent(state.datasets?.products) >= 100;
  const planDone = stages.find((s) => s.key === "plan")?.status === "done";
  const buildMs = planDone ? 0 : PRIOR.buildMs + PRIOR.buildPerKVariantMs * perK(v);
  const productsLeftMs = productsDone ? 0 : PRIOR.productsMs + PRIOR.productsPerKVariantMs * perK(v);

  const historyStart = ms(state.datasets?.products?.finishedAt) ?? ms(state.startedAt);
  const elapsed = historyStart === null ? 0 : now.getTime() - historyStart;
  let basis: "measured" | "estimate" = "estimate";
  let stepMs = PRIOR.stepMs + PRIOR.stepPerKVariantMs * perK(v);
  if (productsDone && unitsDone >= MIN_MEASURED_UNITS && elapsed >= MIN_MEASURED_MS) {
    stepMs = elapsed / unitsDone;
    basis = "measured";
  }
  const left = productsLeftMs + unitsLeft * stepMs + buildMs;
  if (!Number.isFinite(left) || left < 0) return null;
  return { minutes: Math.max(1, Math.ceil(left / 60_000)), basis };
}

/** Everything the sync screen shows. */
export function buildSyncView(input: SyncViewInput): SyncView {
  const { state } = input;
  const chunks = syncChunks(state);
  const stages: SyncStage[] = [productsStage(state.datasets?.products)];
  for (const key of DATASETS) if (key !== "products") stages.push(historyStage(key, state.datasets?.[key], chunks));
  const historyDone = !!state.finishedAt || stages.every((s) => s.status === "done" || s.status === "gaps");
  stages.push(planStage(state, historyDone, input.planBuiltAt));
  const percent = Math.round(DATASETS.map((d) => datasetPercent(state.datasets?.[d])).reduce((a, b) => a + b, 0) / DATASETS.length);
  const monthsRead = Math.min(state.datasets?.stock?.done ?? 0, state.datasets?.sales?.done ?? 0);
  const complete = stages.every((s) => s.status === "done" || s.status === "gaps");
  return {
    stages,
    percent,
    eta: syncEta(input, stages),
    size: storeSize(input.trackedVariants, input.catalogDone),
    variants: input.catalogDone ? input.trackedVariants : null,
    months: chunks.length || HISTORY_MONTHS,
    monthsRead,
    partial: !!state.first90Ready && !historyDone,
    emailOnReady: input.emailOnReady,
    complete,
  };
}

// ── Copy (literal t() calls so the coverage test sees every string) ─────────

export function stageLabel(key: SyncStageKey, t: T): string {
  switch (key) {
    case "products":
      return t("Products");
    case "stock":
      return t("Stock history");
    case "sales":
      return t("Sales history");
    case "visits":
      return t("Store visits");
    case "plan":
      return t("Building your plan");
  }
}

/** "March 2025" in the admin's language. */
export function formatMonth(day: string, locale: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "—";
  try {
    return new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  } catch {
    return day.slice(0, 7);
  }
}

/** The stage's right-hand status ("3 of 14 months", "Done", "Waiting to start" …). */
export function stageStatusText(s: SyncStage, t: T, count: (n: number) => string, percent: (ratio: number) => string): string {
  switch (s.status) {
    case "done":
      return t("Done");
    case "gaps":
      return t("Done, with gaps");
    case "waiting":
      return s.key === "plan" ? t("Starts when the history is read") : t("Waiting to start");
    case "retrying":
    case "running":
      if (s.key === "plan") return t("Working on it");
      if (s.done !== null && s.total !== null) return fill(t("{done} of {total} months"), { done: count(s.done), total: count(s.total) });
      return percent((s.percent ?? 0) / 100);
  }
}

/** The plain error line under a stage, or null ("We couldn't read sales for March 2025 — we'll retry automatically."). */
export function stageErrorText(s: SyncStage, t: T, locale: string): string | null {
  if (s.status === "retrying") {
    if (s.key === "products") return t("We couldn't read your products — we'll retry automatically.");
    const month = s.failedMonth ? formatMonth(s.failedMonth, locale) : null;
    if (!month) return t("We hit a problem reading this — we'll retry automatically.");
    switch (s.key) {
      case "stock":
        return fill(t("We couldn't read stock levels for {month} — we'll retry automatically."), { month });
      case "sales":
        return fill(t("We couldn't read sales for {month} — we'll retry automatically."), { month });
      case "visits":
        return fill(t("We couldn't read store visits for {month} — we'll retry automatically."), { month });
      default:
        return null;
    }
  }
  if (s.status === "gaps" || s.skippedMonths.length) {
    const months = s.skippedMonths.map((d) => formatMonth(d, locale)).join(", ");
    if (!months) return null;
    switch (s.key) {
      case "stock":
        return fill(t("We couldn't read stock levels for {months} after several tries. Your plan uses the other months."), { months });
      case "sales":
        return fill(t("We couldn't read sales for {months} after several tries. Your plan uses the other months."), { months });
      case "visits":
        return fill(t("We couldn't read store visits for {months} after several tries. Your plan uses the other months."), { months });
      default:
        return null;
    }
  }
  return null;
}

/** "About 25 minutes left" · "About 3 hours left" · "Almost done" · "Working out how long this takes…". */
export function etaText(eta: SyncEta, t: T, count: (n: number) => string): string {
  if (!eta) return t("Working out how long this takes…");
  const m = eta.minutes;
  if (m <= 2) return t("Almost done");
  if (m < 60) return fill(t("About {n} minutes left"), { n: count(Math.max(5, Math.round(m / 5) * 5)) });
  const h = Math.round(m / 60);
  if (h <= 1) return t("About 1 hour left");
  if (h < 24) return fill(t("About {n} hours left"), { n: count(h) });
  return t("More than a day left");
}

/** The subdued line under the ETA: how it was worked out. */
export function etaBasisText(eta: SyncEta, variants: number | null, t: T, count: (n: number) => string): string | null {
  if (!eta) return null;
  if (eta.basis === "measured") return t("Worked out from how fast your store has been read so far.");
  return variants !== null
    ? fill(t("A first estimate from your store's size ({n} variants). It gets more precise once the first months are in."), { n: count(variants) })
    : t("A first estimate. It gets more precise once your products and the first months are in.");
}

/** What the partial numbers are based on ("Based on the last 90 days so far"). */
export function partialText(monthsRead: number, t: T, count: (n: number) => string): string {
  if (monthsRead <= 3) return t("Based on the last 90 days so far");
  return fill(t("Based on the last {n} months so far"), { n: count(monthsRead) });
}

/** The size sentence of the intro. */
export function sizeText(size: StoreSize | null, t: T): string {
  return size === "L" ? t("Large stores take a few hours — you can close this page.") : t("You can close this page — we keep reading in the background.");
}

// ── The "your order plan is ready" notice ────────────────────────────────────

/** The Dashboard shows "Your order plan is ready" for this long after the read finished. */
export const READY_NOTICE_MS = 3 * 24 * 60 * 60 * 1000;

export function showReadyNotice(state: BackfillState, ready: boolean, now: Date): boolean {
  const f = ms(state.finishedAt);
  return ready && f !== null && now.getTime() - f >= 0 && now.getTime() - f <= READY_NOTICE_MS;
}
