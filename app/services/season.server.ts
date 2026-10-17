/**
 * Loads the daily units behind seasonality and trend (spec §7.3) for one shop and builds the
 * pure season context (app/lib/engine/season-shared). Shared by compute and accuracy.
 *
 * Units come from the SalesDaily LOCATION view (channel "all", locationKey in the online pool
 * keys), the same view the sales rate uses; the channel view is never added to it.
 * Collection series are loaded only when a collection sold ≥ 2,000 units in the last 12 months.
 */
import prisma from "../db.server";
import {
  SEASON,
  createSeasonContext,
  type Coverage,
  type TrendMode,
  type UnitsSeries,
} from "../lib/engine/season-shared";
import { ALL, dayDate } from "../lib/sync/facts-shared";
import { addDays } from "../lib/sync/shopifyql-shared";

export type SeasonContext = ReturnType<typeof createSeasonContext>;

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
/** Member variant ids per `in` filter (bounded query size). */
const MEMBER_CHUNK = 5000;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function loadSeasonContext(
  shop: string,
  input: {
    today: string;
    poolKeys: string[];
    variants: { id: string; collections: string[] }[];
    coverage: Coverage;
    /** Longest horizon any variant will ask for (lead time + cycle, or a month). */
    maxHorizonDays: number;
    /** Growth assumption (Shop.settings.trendMode); default "off" — the trend is measured, not applied. */
    trendMode?: TrendMode;
  },
): Promise<SeasonContext> {
  const { today, poolKeys, coverage } = input;
  const yesterday = addDays(today, -1);
  // Oldest day any span reads: the oldest year's base blend (its longest rate window) and the
  // 3-week smoothing margin, or the LY trend window (season-shared seasonalIndex / trendFactor).
  const longestBase = Math.max(...SEASON.baseWindows.map((w) => w.days));
  const from = addDays(today, -(SEASON.yearShiftDays * SEASON.maxYears + longestBase + SEASON.smoothRadiusDays + 7));
  const horizon = Math.min(SEASON.maxHorizonDays, Math.max(1, input.maxHorizonDays));
  // Newest last-year day a span (or the weekly curve) reads, smoothing margin included.
  const lyTo = addDays(today, -SEASON.yearShiftDays + horizon + SEASON.smoothRadiusDays + 7);
  const pool = { shop, channel: ALL, locationKey: { in: poolKeys } };

  const [storeG, units12G] = await Promise.all([
    prisma.salesDaily.groupBy({
      by: ["day"],
      where: { ...pool, day: { gte: dayDate(from), lte: dayDate(yesterday) } },
      _sum: { sold: true },
    }),
    prisma.salesDaily.groupBy({
      by: ["variantId"],
      where: { ...pool, day: { gte: dayDate(addDays(today, -SEASON.units12mDays)), lte: dayDate(yesterday) } },
      _sum: { sold: true },
    }),
  ]);
  const storeUnits = new Map<string, number>(storeG.map((g) => [dayKey(g.day), num(g._sum.sold)]));

  const variantUnits12 = new Map(units12G.map((g) => [g.variantId, num(g._sum.sold)]));
  const members = new Map<string, string[]>();
  for (const v of input.variants) for (const c of v.collections ?? []) (members.get(c) ?? members.set(c, []).get(c)!).push(v.id);
  const units12m = new Map<string, number>();
  for (const [c, ids] of members) units12m.set(c, ids.reduce((a, id) => a + (variantUnits12.get(id) ?? 0), 0));

  const qualifying = [...units12m].filter(([, u]) => u >= SEASON.collectionMinUnits12m).map(([c]) => c);
  const collections = new Map<string, UnitsSeries>();
  // One day-level query per qualifying collection (its members' units summed in SQL), over the
  // last-year windows (both years, bases and smoothing: [from … lyTo]) and the last 28 days.
  const windows = [
    { gte: dayDate(from), lte: dayDate(lyTo < yesterday ? lyTo : yesterday) },
    ...(lyTo < addDays(today, -SEASON.trendDays) ? [{ gte: dayDate(addDays(today, -SEASON.trendDays)), lte: dayDate(yesterday) }] : []),
  ];
  for (const c of qualifying) {
    const ids = members.get(c) ?? [];
    const units = new Map<string, number>();
    for (const day of windows) {
      for (let i = 0; i < ids.length; i += MEMBER_CHUNK) {
        const rows = await prisma.salesDaily.groupBy({
          by: ["day"],
          where: { ...pool, variantId: { in: ids.slice(i, i + MEMBER_CHUNK) }, day },
          _sum: { sold: true },
        });
        for (const g of rows) units.set(dayKey(g.day), (units.get(dayKey(g.day)) ?? 0) + num(g._sum.sold));
      }
    }
    collections.set(c, { units, coverage });
  }
  return createSeasonContext({ today, store: { units: storeUnits, coverage }, collections, units12m, trendMode: input.trendMode ?? "off" });
}
