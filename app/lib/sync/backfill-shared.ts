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
  finishedAt?: string | null;
};

export type BackfillState = {
  startedAt?: string | null;
  finishedAt?: string | null;
  /** The last 90 days of every history dataset are stored: the engine can run. */
  first90Ready?: boolean;
  datasets?: Partial<Record<Dataset, DatasetProgress>>;
};

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

/** Data is late when the last nightly run is older than this (spec §6.6 freshness). */
export const LATE_AFTER_MS = 36 * 60 * 60 * 1000;

export function isDataLate(lastNightlyAt: Date | string | null | undefined, now: Date): boolean {
  if (!lastNightlyAt) return false; // never ran yet: that's "syncing", not "late"
  return now.getTime() - new Date(lastNightlyAt).getTime() > LATE_AFTER_MS;
}
