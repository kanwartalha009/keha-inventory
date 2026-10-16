/**
 * Backfill progress — the shape stored in Shop.backfillState and shown on Home
 * as one progress bar per dataset (spec §4 J1, §6.6). Pure, client-safe.
 *
 * Datasets: products (catalog bulk read), stock history, sales history and
 * store visits (the four Home bars), plus store totals (orders / gross for AOV,
 * not a bar). History datasets are read in calendar months, newest first, each
 * with its own month cursor, so a failing dataset never blocks the others; the
 * first 90 days come first so numbers appear early ("first90Ready").
 */

export const HISTORY_MONTHS = 13;

/** The datasets Home shows as progress bars. */
export const DATASETS = ["products", "stock", "sales", "visits"] as const;
export type Dataset = (typeof DATASETS)[number];
/** Every dataset the sync tracks (the bars + store totals). */
export const SYNC_DATASETS = ["products", "stock", "sales", "visits", "totals"] as const;
export type SyncDataset = (typeof SYNC_DATASETS)[number];

export type DatasetProgress = {
  /** Units of work done / total (months for history, 1 for products). */
  done: number;
  total: number;
  /** Oldest day fully stored so far (history datasets), YYYY-MM-DD. */
  doneThrough?: string | null;
  lastError?: string | null;
  /** ISO time of lastError (for /health "most recent error"). */
  lastErrorAt?: string | null;
  /** Short machine code of lastError, safe to show publicly (/health). */
  lastErrorCode?: string | null;
  finishedAt?: string | null;
  /** Consecutive failures of the current unit of work (reset on success or skip). */
  attempts?: number;
  /** A month was skipped after MAX_STEP_ATTEMPTS failures: this dataset has gaps. */
  degraded?: boolean;
  /** First day (YYYY-MM-DD) of every month skipped. */
  skippedMonths?: string[];
  /** Newest day stored for this dataset; the nightly job continues from here. */
  syncedThrough?: string | null;
};

export type BackfillState = {
  startedAt?: string | null;
  finishedAt?: string | null;
  /** The last 90 days of every history dataset are stored: the engine can run. */
  first90Ready?: boolean;
  datasets?: Partial<Record<SyncDataset, DatasetProgress>>;
  /**
   * The history window, fixed when the backfill starts (store-local days), so a backfill
   * that spans several days still works through the same months.
   */
  range?: { from: string; until: string } | null;
  /** Newest store-local day whose history is stored; the nightly job continues from here. */
  syncedThrough?: string | null;
};

import type { DayRange } from "./shopifyql-shared";

/** Read whatever is in the JSON column defensively. */
export function readBackfillState(raw: unknown): BackfillState {
  if (!raw || typeof raw !== "object") return {};
  return raw as BackfillState;
}

/** 0–100 per dataset; unknown datasets count as not started. */
export function datasetPercent(p: DatasetProgress | undefined): number {
  if (!p || !p.total) return 0;
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
}

/** Overall percent for /health (mean of the four datasets). */
export function backfillPercent(state: BackfillState): number {
  const ds = DATASETS.map((d) => datasetPercent(state.datasets?.[d]));
  return Math.round(ds.reduce((a, b) => a + b, 0) / DATASETS.length);
}

export function isBackfillDone(state: BackfillState): boolean {
  return !!state.finishedAt || SYNC_DATASETS.every((d) => datasetPercent(state.datasets?.[d]) === 100);
}

/** The most recent dataset error in a state, or null. */
export function latestError(state: BackfillState): { message: string; code: string | null; at: string | null } | null {
  let best: { message: string; code: string | null; at: string | null } | null = null;
  for (const d of SYNC_DATASETS) {
    const p = state.datasets?.[d];
    if (!p?.lastError) continue;
    const at = p.lastErrorAt ?? null;
    if (!best || (at !== null && (best.at === null || at > best.at))) best = { message: p.lastError, code: p.lastErrorCode ?? null, at };
  }
  return best;
}

/** Data is late when the last nightly run is older than this (spec §6.6 freshness). */
export const LATE_AFTER_MS = 36 * 60 * 60 * 1000;

export function isDataLate(lastNightlyAt: Date | string | null | undefined, now: Date): boolean {
  if (!lastNightlyAt) return false; // never ran yet: that's "syncing", not "late"
  return now.getTime() - new Date(lastNightlyAt).getTime() > LATE_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Resumable backfill steps (task 1.4b, review H3). Pure: the service runs a step, then
// records success (completeStep) or failure (failStep).
// ---------------------------------------------------------------------------

/** History datasets, each with its own month cursor (`done`). */
export const HISTORY_DATASETS = ["stock", "sales", "visits", "totals"] as const;
export type HistoryDataset = (typeof HISTORY_DATASETS)[number];

/** Months of stock + sales that make the first numbers possible ("first90Ready"). */
export const FIRST_READY_MONTHS = 3;

/** After this many consecutive failures of one dataset-month, the month is skipped. */
export const MAX_STEP_ATTEMPTS = 5;

export type BackfillStep =
  | { kind: "products" }
  | { kind: "history"; dataset: HistoryDataset; index: number; range: DayRange }
  /** Work remains, but every remaining dataset is excluded for this run. */
  | { kind: "wait" }
  | { kind: "done" };

function complete(p: DatasetProgress | undefined): boolean {
  return !!p && p.total > 0 && p.done >= p.total;
}

function historyComplete(state: BackfillState, d: HistoryDataset, chunks: DayRange[]): boolean {
  return (state.datasets?.[d]?.done ?? 0) >= chunks.length;
}

/**
 * The next unit of work: products first, then the history dataset with the fewest months
 * done (ties in HISTORY_DATASETS order) — month by month, newest first, all datasets level.
 * Datasets in `exclude` (failed earlier in this run) are passed over, so the others continue.
 */
export function nextBackfillStep(
  state: BackfillState,
  chunks: DayRange[],
  exclude: ReadonlySet<string> = new Set(),
): BackfillStep {
  if (!complete(state.datasets?.products)) return exclude.has("products") ? { kind: "wait" } : { kind: "products" };
  let best: { dataset: HistoryDataset; index: number } | null = null;
  let pending = false;
  for (const dataset of HISTORY_DATASETS) {
    if (historyComplete(state, dataset, chunks)) continue;
    pending = true;
    if (exclude.has(dataset)) continue;
    const index = state.datasets?.[dataset]?.done ?? 0;
    if (!best || index < best.index) best = { dataset, index };
  }
  if (best) return { kind: "history", dataset: best.dataset, index: best.index, range: chunks[best.index] };
  return pending ? { kind: "wait" } : { kind: "done" };
}

function readyMonths(chunks: DayRange[]): number {
  return Math.min(FIRST_READY_MONTHS, chunks.length);
}

/** first90Ready: the newest 3 months of stock AND sales are done (visits / totals not required). */
export function isFirst90Ready(state: BackfillState, chunks: DayRange[]): boolean {
  const ready = readyMonths(chunks);
  return ready > 0 && (state.datasets?.stock?.done ?? 0) >= ready && (state.datasets?.sales?.done ?? 0) >= ready;
}

function withProgress(state: BackfillState, chunks: DayRange[], nowIso: string): BackfillState {
  const next = { ...state };
  if (isFirst90Ready(next, chunks)) next.first90Ready = true;
  if (!next.finishedAt && nextBackfillStep(next, chunks).kind === "done") {
    next.finishedAt = nowIso;
    next.first90Ready = true;
    next.syncedThrough = state.range?.until ?? chunks[0]?.until ?? null;
  }
  return next;
}

/** The state after `step` succeeded. Clears that dataset's error and attempts. */
export function completeStep(state: BackfillState, step: BackfillStep, chunks: DayRange[], nowIso: string): BackfillState {
  const datasets: Partial<Record<SyncDataset, DatasetProgress>> = { ...(state.datasets ?? {}) };
  if (step.kind === "products") {
    datasets.products = { ...(datasets.products ?? {}), done: 1, total: 1, lastError: null, lastErrorAt: null, attempts: 0, finishedAt: nowIso };
  } else if (step.kind === "history") {
    const total = chunks.length;
    const prev = datasets[step.dataset];
    const done = step.index + 1;
    datasets[step.dataset] = {
      ...(prev ?? {}),
      done,
      total,
      doneThrough: step.range.since,
      lastError: null,
      lastErrorAt: null,
      attempts: 0,
      syncedThrough: prev?.syncedThrough ?? (step.index === 0 ? step.range.until : null),
      finishedAt: done >= total ? nowIso : null,
    };
  }
  return withProgress({ ...state, datasets }, chunks, nowIso);
}

export type FailOptions = {
  /** Count towards the retry cap (false for throttling: it is not the month's fault). */
  countAttempt?: boolean;
  /** The failed history step, so a capped month can be skipped. */
  step?: BackfillStep;
  chunks?: DayRange[];
  /** Short machine code for /health (review M). */
  code?: string;
};

/**
 * The state after a step failed. A history month that failed MAX_STEP_ATTEMPTS times in a
 * row is skipped: recorded in skippedMonths, the dataset marked degraded, its cursor moved on.
 * Products are never skipped (nothing works without the catalog); they are marked degraded.
 */
export function failStep(
  state: BackfillState,
  dataset: SyncDataset,
  message: string,
  nowIso: string,
  opts: FailOptions = {},
): { state: BackfillState; skipped: boolean } {
  const prev = state.datasets?.[dataset];
  const attempts = (prev?.attempts ?? 0) + (opts.countAttempt === false ? 0 : 1);
  const p: DatasetProgress = {
    done: prev?.done ?? 0,
    total: prev?.total ?? 0,
    ...prev,
    lastError: message.slice(0, 500),
    lastErrorAt: nowIso,
    lastErrorCode: opts.code ?? prev?.lastErrorCode ?? null,
    attempts,
  };
  let skipped = false;
  if (attempts >= MAX_STEP_ATTEMPTS) {
    p.degraded = true;
    if (opts.step?.kind === "history" && opts.chunks) {
      const total = opts.chunks.length;
      p.done = opts.step.index + 1;
      p.total = total;
      p.attempts = 0;
      p.skippedMonths = [...(prev?.skippedMonths ?? []), opts.step.range.since];
      p.finishedAt = p.done >= total ? nowIso : null;
      if (opts.step.index === 0 && !p.syncedThrough) p.syncedThrough = opts.step.range.until;
      skipped = true;
    }
  }
  const next: BackfillState = { ...state, datasets: { ...(state.datasets ?? {}), [dataset]: p } };
  return { state: skipped && opts.chunks ? withProgress(next, opts.chunks, nowIso) : next, skipped };
}

/** True when any dataset skipped a month or keeps failing. */
export function isDegraded(state: BackfillState): boolean {
  return SYNC_DATASETS.some((d) => !!state.datasets?.[d]?.degraded);
}

/** The state with one dataset's error and attempts cleared. */
export function clearError(state: BackfillState, dataset: SyncDataset): BackfillState {
  const p = state.datasets?.[dataset];
  if (!p) return state;
  return { ...state, datasets: { ...state.datasets, [dataset]: { ...p, lastError: null, lastErrorAt: null, lastErrorCode: null, attempts: 0 } } };
}

/** The state with every dataset's lastError cleared. */
export function clearErrors(state: BackfillState): BackfillState {
  let s = state;
  for (const d of SYNC_DATASETS) s = clearError(s, d);
  return s;
}
