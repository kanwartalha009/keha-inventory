/**
 * The frozen, anonymised accuracy dataset (docs/ACCURACY.md) and the engine inputs built from it
 * the way compute.server builds them. Pure apart from reading the file.
 *
 * data/store.json.gz: one real store's daily units, anonymised before it was committed — random
 * variant ids, no product names, SKUs, titles, handles, prices, money or store name. Per variant:
 * the ABC role, net units sold per day and the sold-out days (ended the day at ≤ 0 units and sold
 * nothing); plus the store's total units per day (the store-level seasonal index). `start` is the
 * calendar day of day 0: the seasonal index aligns weekdays and Black Friday, so it can't be
 * removed. Stock levels, revenue and costs are not in it, so the service simulation reports stock
 * in units, not money.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AbcRole, DailyRow } from "../../app/lib/engine/index-shared";
import { addDays, dayIndex } from "../../app/lib/engine/dates-shared";
import { createSeasonContext } from "../../app/lib/engine/season-shared";

export const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), "data", "store.json.gz");

export interface DatasetFile {
  version: 1;
  start: string;
  days: number;
  note?: string;
  store: number[];
  variants: { id: string; role: AbcRole; sold: number[]; out: number[] }[];
}

export interface Variant {
  id: string;
  role: AbcRole;
  sold: number[];
  soldOut: Set<number>;
  /** First day index with a sale (the launch). */
  launch: number;
}

export interface Dataset {
  start: string;
  days: number;
  store: number[];
  variants: Variant[];
  dayOf: (i: number) => string;
  idxOf: (day: string) => number;
}

export function readDatasetFile(path: string = DATA_FILE): DatasetFile {
  return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as DatasetFile;
}

export function loadDataset(path: string = DATA_FILE): Dataset {
  const f = readDatasetFile(path);
  const s0 = dayIndex(f.start);
  return {
    start: f.start,
    days: f.days,
    store: f.store,
    variants: f.variants.map((v) => {
      const launch = v.sold.findIndex((x) => x !== 0);
      return { id: v.id, role: v.role, sold: v.sold, soldOut: new Set(v.out), launch: launch < 0 ? f.days : launch };
    }),
    dayOf: (i) => addDays(f.start, i),
    idxOf: (day) => dayIndex(day) - s0,
  };
}

/** Engine rows for days [from, to] (from the launch on); a sold-out day is out of stock and sold nothing. */
export function rowsFor(ds: Dataset, v: Variant, from: number, to: number, opts: { floor?: number } = {}): DailyRow[] {
  const out: DailyRow[] = [];
  for (let i = Math.max(from, v.launch, opts.floor ?? 0); i <= to; i++) {
    const so = v.soldOut.has(i) && !(v.sold[i]! > 0);
    out.push({ day: ds.dayOf(i), sold: v.sold[i]!, endStock: so ? 0 : 1, outOfStock: so });
  }
  return out;
}

/**
 * The store's season context as of day T (the store's units through T − 1). `historyFrom`: the
 * first day the history covers (a younger store: the seasonal index needs 13 months).
 */
export function seasonContextAt(ds: Dataset, T: number, historyFrom = 0) {
  const units = new Map<string, number>();
  for (let i = historyFrom; i < T; i++) units.set(ds.dayOf(i), ds.store[i]!);
  return createSeasonContext({ today: ds.dayOf(T), store: { units, coverage: { from: ds.dayOf(historyFrom), to: ds.dayOf(T - 1) } }, trendMode: "off" });
}

/** Seeded PRNG (mulberry32) so a "random" sample is the same every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
