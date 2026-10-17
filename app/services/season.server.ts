/**
 * Loads the daily units behind seasonality and trend (spec §7.3) for one shop and builds the
 * pure season context (app/lib/engine/season-shared). Shared by compute and accuracy.
 *
 * Units come from the pool's demand view (compute-shared demandWhere: all channels, minus
 * locations the merchant left out), the same view the sales rate uses; never both views.
 * Group series are loaded only for groups that qualify (season-shared buildSeasonGroups: sold
 * ≥ 2,000 units in the last 12 months and not a catch-all): one day-level query per qualifying
 * collection, and ONE grouped statement for every qualifying product type (season-sql-shared).
 */
import prisma from "../db.server";
import {
  SEASON,
  buildSeasonGroups,
  createSeasonContext,
  type Coverage,
  type SeasonGroupVariant,
  type TrendMode,
  type UnitsSeries,
} from "../lib/engine/season-shared";
import { productTypeSeriesQuery, readProductTypeSeries, type RawQuery } from "../lib/season-sql-shared";
import { dayDate } from "../lib/sync/facts-shared";
import { demandWhere, type DemandScope } from "../lib/compute-shared";
import { addDays } from "../lib/sync/shopifyql-shared";

export type SeasonContext = ReturnType<typeof createSeasonContext>;

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
/** Member variant ids per `in` filter (bounded query size). */
const MEMBER_CHUNK = 5000;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const prismaRaw: RawQuery = (sql, params) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);

export async function loadSeasonContext(
  shop: string,
  input: {
    today: string;
    /** Pool demand (compute-shared demandScope): the same SalesDaily view the sales rate reads. */
    demand: DemandScope;
    /** Non-bundle variants with their collections, product type and whether they are active and tracked. */
    variants: SeasonGroupVariant[];
    coverage: Coverage;
    /** Longest horizon any variant will ask for (lead time + cycle, or a month). */
    maxHorizonDays: number;
    /** Growth assumption (Shop.settings.trendMode); default "off" — the trend is measured, not applied. */
    trendMode?: TrendMode;
    /** Members of a product type: false (default) = every non-bundle variant, as the collections' members. */
    plannedOnly?: boolean;
  },
  raw: RawQuery = prismaRaw,
): Promise<SeasonContext> {
  const { today, coverage } = input;
  const yesterday = addDays(today, -1);
  // Oldest day any span reads: the oldest year's base blend (its longest rate window) and the
  // 3-week smoothing margin, or the LY trend window (season-shared seasonalIndex / trendFactor).
  const longestBase = Math.max(...SEASON.baseWindows.map((w) => w.days));
  const from = addDays(today, -(SEASON.yearShiftDays * SEASON.maxYears + longestBase + SEASON.smoothRadiusDays + 7));
  const horizon = Math.min(SEASON.maxHorizonDays, Math.max(1, input.maxHorizonDays));
  // Newest last-year day a span (or the weekly curve) reads, smoothing margin included.
  const lyTo = addDays(today, -SEASON.yearShiftDays + horizon + SEASON.smoothRadiusDays + 7);
  const pool = { shop, ...demandWhere(input.demand) };

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
  const { groups, members } = buildSeasonGroups(input.variants, variantUnits12);
  const qualifying = [...groups.values()].filter((g) => g.qualifies);
  const groupSeries = new Map<string, UnitsSeries>();
  // Day-level reads over the last-year windows (both years, bases and smoothing: [from … lyTo])
  // and the last 28 days.
  const lyEnd = lyTo < yesterday ? lyTo : yesterday;
  const dayWindows = [
    { from, to: lyEnd },
    ...(lyTo < addDays(today, -SEASON.trendDays) ? [{ from: addDays(today, -SEASON.trendDays), to: yesterday }] : []),
  ];
  // One day-level query per qualifying collection (its members' units summed in SQL).
  for (const g of qualifying.filter((x) => x.kind === "collection")) {
    const ids = members.get(g.id) ?? [];
    const units = new Map<string, number>();
    for (const w of dayWindows) {
      const day = { gte: dayDate(w.from), lte: dayDate(w.to) };
      for (let i = 0; i < ids.length; i += MEMBER_CHUNK) {
        const rows = await prisma.salesDaily.groupBy({
          by: ["day"],
          where: { ...pool, variantId: { in: ids.slice(i, i + MEMBER_CHUNK) }, day },
          _sum: { sold: true },
        });
        for (const r of rows) units.set(dayKey(r.day), (units.get(dayKey(r.day)) ?? 0) + num(r._sum.sold));
      }
    }
    groupSeries.set(g.id, { units, coverage });
  }
  // Every qualifying product type in ONE grouped statement (type × day rows, same windows).
  const types = qualifying.filter((x) => x.kind === "productType");
  const q = productTypeSeriesQuery({ shop, demand: input.demand, types: types.map((g) => g.key), windows: dayWindows, plannedOnly: input.plannedOnly });
  if (q) {
    const byType = readProductTypeSeries(await raw(q.sql, q.params));
    for (const g of types) groupSeries.set(g.id, { units: byType.get(g.key) ?? new Map(), coverage });
  }
  return createSeasonContext({ today, store: { units: storeUnits, coverage }, groupSeries, groups, trendMode: input.trendMode ?? "off" });
}
