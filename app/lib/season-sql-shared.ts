/**
 * Product-type season series in ONE grouped statement (seasonality by product type, owner
 * 2026-10-17): units sold per (product type × day) for the qualifying types, summed in SQL over
 * the pool's demand view (compute-shared demandWhere) and only the season windows the store
 * series already reads — never the full history, never one query per type, never the
 * variant × day rows. Pure: the SQL text and its parameters; the caller runs it
 * (Prisma $queryRawUnsafe in the app, psql in the tests).
 */
import type { DemandScope } from "./compute-shared";
import { ALL } from "./sync/facts-shared";

export type RawQuery = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

export interface DayWindow {
  /** Inclusive store-local days, YYYY-MM-DD. */
  from: string;
  to: string;
}

export interface ProductTypeSeriesInput {
  shop: string;
  demand: DemandScope;
  types: readonly string[];
  windows: readonly DayWindow[];
  /**
   * Which variants count as members: false = every non-bundle variant (compute and accuracy,
   * whose collection members are every non-bundle variant); true = active tracked ones only
   * (the planner, whose variants are those).
   */
  plannedOnly?: boolean;
}

/** null when there is nothing to read (no type or no window). */
export function productTypeSeriesQuery(input: ProductTypeSeriesInput): { sql: string; params: unknown[] } | null {
  const types = [...new Set(input.types)].filter((t) => t !== "");
  const windows = input.windows.filter((w) => w.from <= w.to);
  if (!types.length || !windows.length) return null;
  const params: unknown[] = [input.shop];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  const demand =
    input.demand.view === "channel"
      ? `s."locationKey" = ${p(ALL)}`
      : `s."channel" = ${p(ALL)} AND s."locationKey" NOT IN (${[ALL, ...input.demand.exclude].map(p).join(", ")})`;
  const typeList = types.map(p).join(", ");
  const days = windows.map((w) => `(s."day" >= ${p(w.from)}::date AND s."day" <= ${p(w.to)}::date)`).join(" OR ");
  const sql = `SELECT v."productType" AS "productType", to_char(s."day", 'YYYY-MM-DD') AS "day", SUM(s."sold")::bigint AS "sold"
FROM "SalesDaily" s
JOIN "Variant" v ON v."id" = s."variantId" AND v."shop" = s."shop"
WHERE s."shop" = $1
  AND (${days})
  AND ${demand}
  AND v."isBundle" = false${input.plannedOnly ? ` AND v."tracked" = true AND v."status" = 'ACTIVE'` : ""}
  AND v."productType" IN (${typeList})
GROUP BY v."productType", s."day"`;
  return { sql, params };
}

/** Rows → units per day per product type. */
export function readProductTypeSeries(rows: readonly Record<string, unknown>[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const t = typeof r.productType === "string" ? r.productType : null;
    const day = typeof r.day === "string" ? r.day.slice(0, 10) : r.day instanceof Date ? r.day.toISOString().slice(0, 10) : null;
    if (t === null || day === null) continue;
    const sold = Number(typeof r.sold === "bigint" ? r.sold : (r.sold ?? 0));
    const m = out.get(t) ?? out.set(t, new Map()).get(t)!;
    m.set(day, (m.get(day) ?? 0) + (Number.isFinite(sold) ? sold : 0));
  }
  return out;
}
