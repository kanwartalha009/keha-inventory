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
  shiftYears,
  type Coverage,
  type UnitsSeries,
} from "../lib/engine/season-shared";
import { ALL, dayDate } from "../lib/sync/facts-shared";
import { addDays } from "../lib/sync/shopifyql-shared";

export type SeasonContext = ReturnType<typeof createSeasonContext>;

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
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
  },
): Promise<SeasonContext> {
  const { today, poolKeys, coverage } = input;
  const yesterday = addDays(today, -1);
  // Oldest day any span reads: the LY base (28 days ending yesterday − 1y) or the LY trend window.
  const from = addDays(shiftYears(yesterday, -1), -(SEASON.baseDays + 7));
  const lyFrom = shiftYears(today, -1);
  const lyTo = addDays(lyFrom, Math.min(SEASON.maxHorizonDays, Math.max(1, input.maxHorizonDays)) - 1);
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
  if (qualifying.length) {
    // Two windows only: [LY base … LY horizon end] and the last 28 days.
    const windows = [
      { gte: dayDate(from), lte: dayDate(lyTo < yesterday ? lyTo : yesterday) },
      { gte: dayDate(addDays(today, -SEASON.trendDays)), lte: dayDate(yesterday) },
    ];
    const rows = (
      await Promise.all(
        windows.map((day) =>
          prisma.salesDaily.groupBy({ by: ["variantId", "day"], where: { ...pool, day }, _sum: { sold: true } }),
        ),
      )
    ).flat();
    const seen = new Set<string>();
    const byVariant = new Map<string, Map<string, number>>();
    for (const g of rows) {
      const k = `${g.variantId}|${dayKey(g.day)}`;
      if (seen.has(k)) continue; // the two windows never overlap in practice; guard anyway
      seen.add(k);
      const m = byVariant.get(g.variantId) ?? byVariant.set(g.variantId, new Map()).get(g.variantId)!;
      m.set(dayKey(g.day), num(g._sum.sold));
    }
    for (const c of qualifying) {
      const units = new Map<string, number>();
      for (const id of members.get(c) ?? []) {
        for (const [day, u] of byVariant.get(id) ?? []) units.set(day, (units.get(day) ?? 0) + u);
      }
      collections.set(c, { units, coverage });
    }
  }
  return createSeasonContext({ today, store: { units: storeUnits, coverage }, collections, units12m });
}
