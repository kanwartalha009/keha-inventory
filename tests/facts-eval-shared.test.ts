/**
 * lib/facts-eval-shared: the fast path over stock month rows (evaluateStockMonths, what the
 * Postgres store uses for compute's reads) gives exactly what the day-by-day evaluator gives, on
 * random month rows and every read shape the app sends; shapes it does not handle fall back.
 */
import { describe, expect, it } from "vitest";
import { compileWhere, evaluate, evaluateStockMonths, type Row, type StockMonthRow } from "../app/lib/facts-eval-shared";
import type { ReadOp } from "../app/lib/facts-sql-shared";

const S = "acme.myshopify.com";
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const L = (n: number) => `gid://shopify/Location/${n}`;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function monthRows(seed: number): StockMonthRow[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: StockMonthRow[] = [];
  for (let v = 1; v <= 12; v++)
    for (const l of [1, 2, 3])
      for (const month of ["2026-08", "2026-09", "2026-10"]) {
        if (rnd() < 0.15) continue;
        const units: (number | null)[] = [];
        let mask = 0;
        const days = month === "2026-09" ? 30 : month === "2026-10" ? 16 : 31;
        for (let i = 0; i < 31; i++) {
          if (i >= days || rnd() < 0.1) units.push(null);
          else {
            const e = Math.floor(rnd() * 12) - 2;
            units.push(e);
            if (e <= 0 && rnd() < 0.8) mask |= 1 << i;
          }
        }
        out.push({ variantId: V(v), locationId: L(l), month, mask, units });
      }
  return out;
}

function expand(rows: readonly StockMonthRow[]): Row[] {
  const out: Row[] = [];
  for (const r of rows)
    r.units.forEach((e, i) => {
      if (e === null || e === undefined) return;
      out.push({ shop: S, day: `${r.month}-${String(i + 1).padStart(2, "0")}`, variantId: r.variantId, locationId: r.locationId, endUnits: e, outOfStock: ((r.mask >> i) & 1) === 1 });
    });
  return out;
}

const sortKey = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Date ? x.toISOString() : x));
const canon = (v: unknown) => (Array.isArray(v) ? v.map(sortKey).sort() : sortKey(v));

const ids = [V(1), V(2), V(5), V(9), V(99)];
const range = { gte: d("2026-08-20"), lte: d("2026-10-10") };
const OPS: ReadOp[] = [
  { op: "groupBy", by: ["variantId", "day"], where: { shop: S, locationId: { in: [L(1), L(2)] }, variantId: { in: ids }, day: range }, _sum: { endUnits: true }, _count: { _all: true } },
  { op: "groupBy", by: ["variantId", "day"], where: { shop: S, locationId: { in: [L(1), L(2)] }, variantId: { in: ids }, day: range, outOfStock: true }, _count: { _all: true } },
  { op: "groupBy", by: ["variantId"], where: { shop: S, variantId: { in: ids } }, _min: { day: true }, _max: { day: true } },
  { op: "groupBy", by: ["variantId", "locationId"], where: { shop: S, day: { gt: d("2026-09-01"), lt: d("2026-09-20") } }, _min: { day: true, endUnits: true }, _max: { endUnits: true } },
  { op: "groupBy", by: ["day"], where: { shop: S, locationId: L(3), day: { in: [d("2026-08-05"), d("2026-10-01"), d("2026-10-31")] } }, _sum: { endUnits: true } },
  { op: "groupBy", by: ["locationId"], where: { shop: S, endUnits: { lte: 0 } }, _count: { _all: true } },
  { op: "groupBy", by: ["variantId", "day"], where: { shop: S, variantId: V(3), day: range }, _sum: { endUnits: true }, orderBy: { day: "desc" }, take: 5 },
  { op: "aggregate", where: { shop: S, variantId: V(2) }, _min: { day: true }, _max: { day: true }, _sum: { endUnits: true }, _count: { _all: true } },
  { op: "aggregate", where: { shop: S, variantId: V(404) }, _sum: { endUnits: true }, _min: { day: true } },
  { op: "findMany", where: { shop: S, day: d("2026-09-15"), locationId: { in: [L(1)] }, variantId: { in: ids } }, select: { variantId: true, endUnits: true, outOfStock: true } },
  { op: "findMany", where: { shop: S, locationId: L(2), variantId: { in: ids }, day: range }, select: { variantId: true, day: true, endUnits: true, outOfStock: true }, orderBy: { day: "asc" }, take: 7 },
  { op: "count", where: { shop: S, outOfStock: true, day: { gte: d("2026-10-01") } } },
  { op: "groupBy", by: ["variantId", "day"], where: { shop: S, locationId: { notIn: [L(2)] }, variantId: { in: ids }, day: range, outOfStock: false }, _count: { _all: true } },
];

describe("evaluateStockMonths = evaluate over the expanded days", () => {
  for (const seed of [1, 7, 42]) {
    it(`random month rows (seed ${seed})`, () => {
      const rows = monthRows(seed);
      const days = expand(rows);
      for (const op of OPS) {
        const fast = evaluateStockMonths(op, S, rows);
        expect(fast, JSON.stringify(op)).not.toBeUndefined();
        expect(canon(fast), JSON.stringify(op)).toEqual(canon(evaluate(op, days)));
      }
    });
  }

  it("falls back for shapes it does not handle (OR / NOT / AND at the top level)", () => {
    const rows = monthRows(3);
    expect(evaluateStockMonths({ op: "count", where: { shop: S, OR: [{ endUnits: 1 }, { outOfStock: true }] } }, S, rows)).toBeUndefined();
    expect(evaluateStockMonths({ op: "count", where: { shop: S, NOT: { locationId: L(1) } } }, S, rows)).toBeUndefined();
    const op: ReadOp = { op: "groupBy", by: ["locationId"], where: { shop: S, OR: [{ endUnits: { gte: 8 } }, { outOfStock: true }] }, _count: { _all: true } };
    const days = expand(rows);
    expect((evaluate(op, days) as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("compileWhere", () => {
  const row: Row = { shop: S, day: "2026-10-05", variantId: V(1), locationId: L(1), endUnits: 3, outOfStock: false };
  it("matches Prisma's filter semantics on days, keys and numbers", () => {
    expect(compileWhere({ day: d("2026-10-05") })(row)).toBe(true);
    expect(compileWhere({ day: { gte: d("2026-10-06") } })(row)).toBe(false);
    expect(compileWhere({ day: { lt: d("2026-10-06"), gt: d("2026-10-04") } })(row)).toBe(true);
    expect(compileWhere({ variantId: { notIn: [V(1)] } })(row)).toBe(false);
    expect(compileWhere({ locationId: { not: L(2) } })(row)).toBe(true);
    expect(compileWhere({ endUnits: { not: { gt: 2 } } })(row)).toBe(false);
    expect(compileWhere({ OR: [{ endUnits: 9 }, { outOfStock: false }], NOT: { variantId: V(2) } })(row)).toBe(true);
    expect(compileWhere({ AND: [{ endUnits: { gte: 3 } }, { endUnits: { lte: 3 } }] })(row)).toBe(true);
  });
});
