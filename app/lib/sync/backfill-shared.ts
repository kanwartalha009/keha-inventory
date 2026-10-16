/**
 * Backfill progress — the shape stored in Shop.backfillState and shown on Home
 * as one progress bar per dataset (spec §4 J1, §6.6). Pure, client-safe.
 *
 * Datasets: products (catalog bulk read), stock history, sales history and
 * store visits. History datasets are read in calendar months, newest first;
 * the first 90 days come first so numbers appear early ("first90Ready").
 */

export const HISTORY_MONTHS = 13;

export const DATASETS = ["products", "stock", "sales", "visits"] as const;
export type Dataset = (typeof DATASETS)[number];

export type DatasetProgress = {
  /** Units of work done / total (months for history, 1 for products). */
  done: number;
  total: number;
  /** Oldest day fully stored so far (history datasets), YYYY-MM-DD. */
  doneThrough?: string | null;
  lastError?: string | null;
  /** ISO time of lastError (for /health "most recent error"). */
  lastErrorAt?: string | null;
  finishedAt?: string | null;
};

export type BackfillState = {
  startedAt?: string | null;
  finishedAt?: string | null;
  /** The last 90 days of every history dataset are stored: the engine can run. */
  first90Ready?: boolean;
  datasets?: Partial<Record<Dataset, DatasetProgress>>;
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
  return !!state.finishedAt || DATASETS.every((d) => datasetPercent(state.datasets?.[d]) === 100);
}

/** The most recent dataset error in a state, or null. */
export function latestError(state: BackfillState): { message: string; at: string | null } | null {
  let best: { message: string; at: string | null } | null = null;
  for (const d of DATASETS) {
    const p = state.datasets?.[d];
    if (!p?.lastError) continue;
    const at = p.lastErrorAt ?? null;
    if (!best || (at !== null && (best.at === null || at > best.at))) best = { message: p.lastError, at };
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
// Resumable backfill steps (task 1.4b). Pure: the service runs a step, then records it.
// ---------------------------------------------------------------------------

/** History datasets, in the order each month is fetched. */
export const HISTORY_DATASETS = ["stock", "sales", "visits"] as const;
export type HistoryDataset = (typeof HISTORY_DATASETS)[number];

/** Months of stock + sales that make the first numbers possible ("first90Ready"). */
export const FIRST_READY_MONTHS = 3;

export type BackfillStep =
  | { kind: "products" }
  | { kind: "history"; dataset: HistoryDataset; index: number; range: DayRange }
  | { kind: "done" };

function complete(p: DatasetProgress | undefined): boolean {
  return !!p && p.total > 0 && p.done >= p.total;
}

/**
 * The next unit of work. History goes month by month, newest first, all three datasets per
 * month before the next month, so the newest 90 days are complete early.
 */
export function nextBackfillStep(state: BackfillState, chunks: DayRange[]): BackfillStep {
  if (!complete(state.datasets?.products)) return { kind: "products" };
  for (let i = 0; i < chunks.length; i++) {
    for (const dataset of HISTORY_DATASETS) {
      if ((state.datasets?.[dataset]?.done ?? 0) <= i) return { kind: "history", dataset, index: i, range: chunks[i] };
    }
  }
  return { kind: "done" };
}

/** The state after `step` succeeded. Clears that dataset's lastError. */
export function completeStep(state: BackfillState, step: BackfillStep, chunks: DayRange[], nowIso: string): BackfillState {
  const datasets: Partial<Record<Dataset, DatasetProgress>> = { ...(state.datasets ?? {}) };
  if (step.kind === "products") {
    datasets.products = { done: 1, total: 1, lastError: null, lastErrorAt: null, finishedAt: nowIso };
  } else if (step.kind === "history") {
    const total = chunks.length;
    const done = step.index + 1;
    datasets[step.dataset] = {
      ...(datasets[step.dataset] ?? {}),
      done,
      total,
      doneThrough: step.range.since,
      lastError: null,
      lastErrorAt: null,
      finishedAt: done >= total ? nowIso : null,
    };
  }
  const next: BackfillState = { ...state, datasets };
  const ready = Math.min(FIRST_READY_MONTHS, chunks.length);
  if ((datasets.stock?.done ?? 0) >= ready && (datasets.sales?.done ?? 0) >= ready && ready > 0) next.first90Ready = true;
  if (!next.finishedAt && nextBackfillStep(next, chunks).kind === "done") {
    next.finishedAt = nowIso;
    next.first90Ready = true;
    next.syncedThrough = state.range?.until ?? chunks[0]?.until ?? null;
  }
  return next;
}

/** The state after a step failed (the step is retried on the next run). */
export function failStep(state: BackfillState, dataset: Dataset, message: string, nowIso: string): BackfillState {
  const prev = state.datasets?.[dataset];
  return {
    ...state,
    datasets: {
      ...(state.datasets ?? {}),
      [dataset]: { done: prev?.done ?? 0, total: prev?.total ?? 0, ...prev, lastError: message.slice(0, 500), lastErrorAt: nowIso },
    },
  };
}

/** The state with every dataset's lastError cleared (after a fully successful nightly run). */
export function clearErrors(state: BackfillState): BackfillState {
  const datasets: Partial<Record<Dataset, DatasetProgress>> = {};
  for (const [k, v] of Object.entries(state.datasets ?? {}) as [Dataset, DatasetProgress][]) {
    datasets[k] = { ...v, lastError: null, lastErrorAt: null };
  }
  return { ...state, datasets };
}
