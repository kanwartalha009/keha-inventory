/**
 * The app's raw SQL statements, answered from the fake Prisma's tables (tests/helpers/fake-prisma
 * `extras`): the product-type season series (lib/season-sql-shared productTypeSeriesQuery, read
 * from its own SQL text and parameters), the Products filter's collection list and the alerts
 * job's aggregations (lib/alerts-sql-shared; the same answers as Postgres: tests/alerts-sql-pg.test.ts). Any other
 * statement throws, so a new raw query can't pass silently. Real Postgres runs the real SQL
 * (tests/helpers/pg-prisma).
 */
import type { FakeDb, Row } from "./fake-prisma";

const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const at = (params: unknown[], ref: string) => params[Number(ref.replace("$", "")) - 1];

function productTypeSeries(db: FakeDb, sql: string, params: unknown[]): Record<string, unknown>[] {
  const shop = params[0];
  // The compact SalesFact (R1): the channel view is locNum = 0 ("all"); the pool view is
  // channelNum = 0 AND locNum <> 0, minus the FactKey keys listed (left-out locations).
  const channel = sql.includes(`s."locNum" = 0`);
  const location = sql.includes(`s."channelNum" = 0 AND s."locNum" <> 0`);
  const excluded = /k\."key" IN \(([^)]*)\)/.exec(sql);
  const types = new Set((/v\."productType" IN \(([^)]*)\)/.exec(sql)?.[1] ?? "").split(",").map((x) => at(params, x.trim())));
  const windows = [...sql.matchAll(/\(s\."day" >= (\$\d+)::date AND s\."day" <= (\$\d+)::date\)/g)].map((m) => [String(at(params, m[1]!)), String(at(params, m[2]!))] as const);
  const planned = sql.includes(`v."tracked" = true`);
  const variants = new Map<string, Row>();
  for (const v of db.tables.variant ?? []) if (v.shop === shop) variants.set(v.id as string, v);
  const exclude = new Set(["all", ...(excluded ? excluded[1]!.split(",").map((x) => at(params, x.trim())) : [])]);
  const sums = new Map<string, number>();
  for (const s of db.tables.salesDaily ?? []) {
    if (s.shop !== shop) continue;
    if (channel && s.locationKey !== "all") continue;
    if (location && (s.channel !== "all" || exclude.has(s.locationKey as string))) continue;
    const d = day(s.day);
    if (!windows.some(([a, b]) => d >= a && d <= b)) continue;
    const v = variants.get(s.variantId as string);
    if (!v || v.isBundle || !types.has(v.productType)) continue;
    if (planned && !(v.tracked && v.status === "ACTIVE")) continue;
    const k = `${v.productType}\u0000${d}`;
    sums.set(k, (sums.get(k) ?? 0) + Number(s.sold));
  }
  return [...sums].map(([k, sold]) => ({ productType: k.split("\u0000")[0], day: k.split("\u0000")[1], sold: BigInt(sold) }));
}

function collections(db: FakeDb, shop: unknown): Record<string, unknown>[] {
  const set = new Set<string>();
  for (const v of db.tables.variant ?? []) if (v.shop === shop && v.tracked && !v.isBundle) for (const c of (v.collections as string[]) ?? []) set.add(c);
  return [...set].sort().slice(0, 500).map((c) => ({ c }));
}


/** lib/alerts-sql-shared over the fake tables: the planned variants (tracked, active, not a bundle). */
const planned = (v: Row) => v.tracked === true && v.isBundle === false && v.status === "ACTIVE";

function fullyOutProducts(db: FakeDb, shop: unknown, pool: unknown): Record<string, unknown>[] {
  const locs = new Set(Array.isArray(pool) ? pool : []);
  const available = new Map<string, number>();
  for (const s of db.tables.stockNow ?? []) if (s.shop === shop && locs.has(s.locationId)) available.set(s.variantId as string, (available.get(s.variantId as string) ?? 0) + Number(s.available));
  const out = new Map<string, boolean>();
  for (const v of db.tables.variant ?? []) {
    if (v.shop !== shop || !planned(v)) continue;
    const a = available.get(v.id as string);
    out.set(v.productId as string, (out.get(v.productId as string) ?? true) && a !== undefined && a <= 0);
  }
  return [...out].filter(([, o]) => o).map(([productId]) => ({ productId }));
}

function plannedMetrics(db: FakeDb, shop: unknown, scope: unknown): { m: Row; productId: string }[] {
  const productOf = new Map<string, string>();
  for (const v of db.tables.variant ?? []) if (v.shop === shop && planned(v)) productOf.set(v.id as string, v.productId as string);
  return (db.tables.variantMetric ?? []).filter((m) => m.shop === shop && m.scope === scope && productOf.has(m.variantId as string)).map((m) => ({ m, productId: productOf.get(m.variantId as string)! }));
}

function alertMetrics(db: FakeDb, shop: unknown, scope: unknown): Record<string, unknown>[] {
  const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
  const rows = plannedMetrics(db, shop, scope);
  const allDead = new Map<string, boolean>();
  for (const { m, productId } of rows) allDead.set(productId, (allDead.get(productId) ?? true) && m.status === "dead");
  return rows
    .filter(({ m, productId }) => {
      const days = num(m.daysLeft);
      const qty = num(m.orderQty);
      return allDead.get(productId) || (m.role === "A" && days !== null && days < 365) || ((m.status === "running_low" || m.status === "out") && qty !== null && qty > 0 && days !== null && m.orderBy != null);
    })
    .map(({ m, productId }) => ({ variantId: m.variantId, productId, status: m.status, role: m.role, daysLeft: m.daysLeft ?? null, orderQty: m.orderQty ?? null, orderBy: m.orderBy ?? null, computedAt: m.computedAt, dead: allDead.get(productId) === true }));
}

function run(db: FakeDb, sql: string, params: unknown[]): Record<string, unknown>[] {
  if (sql.includes(`FROM "SalesFact" s`) && sql.includes(`v."productType" IN`)) return productTypeSeries(db, sql, params);
  if (sql.includes(`HAVING bool_and(n."available" IS NOT NULL`)) return fullyOutProducts(db, params[0], params[1]);
  if (sql.includes(`m."role" = 'A' AND m."daysLeft" < 365`)) return alertMetrics(db, params[0], params[1]);
  if (sql.includes(`unnest("collections")`)) return collections(db, params[0]);
  throw new Error(`fake-raw: statement not emulated: ${sql.slice(0, 120)}`);
}

export function fakeRaw(get: () => FakeDb) {
  return {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => run(get(), sql, params),
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => run(get(), strings.reduce((a, s, i) => a + s + (i < values.length ? `$${i + 1}` : ""), ""), values),
  };
}
