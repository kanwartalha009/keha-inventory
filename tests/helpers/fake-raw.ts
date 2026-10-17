/**
 * The app's raw SQL statements, answered from the fake Prisma's tables (tests/helpers/fake-prisma
 * `extras`): the product-type season series (lib/season-sql-shared productTypeSeriesQuery, read
 * from its own SQL text and parameters) and the Products filter's collection list. Any other
 * statement throws, so a new raw query can't pass silently. Real Postgres runs the real SQL
 * (tests/helpers/pg-prisma).
 */
import type { FakeDb, Row } from "./fake-prisma";

const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const at = (params: unknown[], ref: string) => params[Number(ref.replace("$", "")) - 1];

function productTypeSeries(db: FakeDb, sql: string, params: unknown[]): Record<string, unknown>[] {
  const shop = params[0];
  const channel = /s\."locationKey" = (\$\d+)/.exec(sql);
  const location = /s\."channel" = (\$\d+) AND s\."locationKey" NOT IN \(([^)]*)\)/.exec(sql);
  const types = new Set((/v\."productType" IN \(([^)]*)\)/.exec(sql)?.[1] ?? "").split(",").map((x) => at(params, x.trim())));
  const windows = [...sql.matchAll(/\(s\."day" >= (\$\d+)::date AND s\."day" <= (\$\d+)::date\)/g)].map((m) => [String(at(params, m[1]!)), String(at(params, m[2]!))] as const);
  const planned = sql.includes(`v."tracked" = true`);
  const variants = new Map<string, Row>();
  for (const v of db.tables.variant ?? []) if (v.shop === shop) variants.set(v.id as string, v);
  const exclude = location ? new Set(location[2]!.split(",").map((x) => at(params, x.trim()))) : null;
  const sums = new Map<string, number>();
  for (const s of db.tables.salesDaily ?? []) {
    if (s.shop !== shop) continue;
    if (channel && s.locationKey !== at(params, channel[1]!)) continue;
    if (location && (s.channel !== at(params, location[1]!) || exclude!.has(s.locationKey))) continue;
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

function run(db: FakeDb, sql: string, params: unknown[]): Record<string, unknown>[] {
  if (sql.includes(`FROM "SalesDaily" s`) && sql.includes(`v."productType" IN`)) return productTypeSeries(db, sql, params);
  if (sql.includes(`unnest("collections")`)) return collections(db, params[0]);
  throw new Error(`fake-raw: statement not emulated: ${sql.slice(0, 120)}`);
}

export function fakeRaw(get: () => FakeDb) {
  return {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => run(get(), sql, params),
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => run(get(), strings.reduce((a, s, i) => a + s + (i < values.length ? `$${i + 1}` : ""), ""), values),
  };
}
