/**
 * Prisma-shaped reads evaluated in memory over daily rows (DB scale "before 1,000 stores"). The
 * Postgres facts store reads stock this way: it fetches the StockMonth rows that can match (shop,
 * variants, locations, months — index work only) and expands each month's 31-day array here,
 * instead of Postgres unnesting and sorting millions of elements per query (measured: 5–10×
 * faster on a 30,000-variant store, docs/SCALE.md). Pure.
 *
 * Same filter language as lib/facts-sql-shared (and the same answers — tests/facts-store-pg runs
 * both against the in-memory Prisma): equality, in, notIn, not, lt, lte, gt, gte, equals,
 * contains / startsWith, AND / OR / NOT. Days are compared as YYYY-MM-DD strings.
 */
import { dayString } from "./ids-shared";
import type { ReadOp, Where } from "./facts-sql-shared";

export type Row = Record<string, string | number | boolean>;

const OPS = new Set(["equals", "in", "notIn", "lt", "lte", "gt", "gte", "not", "contains", "startsWith", "mode"]);
const isOp = (c: unknown): c is Record<string, unknown> =>
  !!c && typeof c === "object" && !(c instanceof Date) && !Array.isArray(c) && Object.keys(c).some((k) => OPS.has(k));

/** A where value in the rows' form: Dates as days. */
const val = (v: unknown, dayField: boolean): unknown => (dayField && v !== null && v !== undefined ? dayString(v) : v);

/** Compiles a where into a predicate over rows (field "day" holds YYYY-MM-DD strings). */
export function compileWhere(where: Where | undefined): (r: Row) => boolean {
  if (!where) return () => true;
  const tests: ((r: Row) => boolean)[] = [];
  for (const [k, c] of Object.entries(where)) {
    if (c === undefined) continue;
    if (k === "AND") {
      const list = (Array.isArray(c) ? c : [c]).map((x) => compileWhere(x as Where));
      tests.push((r) => list.every((t) => t(r)));
      continue;
    }
    if (k === "OR") {
      const list = (c as Where[]).map((x) => compileWhere(x));
      tests.push((r) => list.some((t) => t(r)));
      continue;
    }
    if (k === "NOT") {
      const list = (Array.isArray(c) ? c : [c]).map((x) => compileWhere(x as Where));
      tests.push((r) => list.every((t) => !t(r)));
      continue;
    }
    tests.push(fieldTest(k, c));
  }
  return (r) => tests.every((t) => t(r));
}

function fieldTest(k: string, c: unknown): (r: Row) => boolean {
  const day = k === "day";
  if (!isOp(c)) {
    if (c === null) return (r) => r[k] === null || r[k] === undefined;
    const v = val(c, day);
    return (r) => r[k] === v;
  }
  const parts: ((r: Row) => boolean)[] = [];
  const ci = (c as { mode?: unknown }).mode === "insensitive";
  for (const [op, arg] of Object.entries(c)) {
    if (arg === undefined || op === "mode") continue;
    switch (op) {
      case "equals": {
        const v = val(arg, day);
        parts.push((r) => r[k] === v);
        break;
      }
      case "in": {
        const set = new Set((arg as unknown[]).map((x) => val(x, day)));
        parts.push((r) => set.has(r[k]));
        break;
      }
      case "notIn": {
        const set = new Set((arg as unknown[]).map((x) => val(x, day)));
        parts.push((r) => !set.has(r[k]));
        break;
      }
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const v = val(arg, day) as string | number;
        if (v === null || v === undefined) {
          parts.push(() => false);
          break;
        }
        parts.push(
          op === "lt" ? (r) => (r[k] as string | number) < v : op === "lte" ? (r) => (r[k] as string | number) <= v : op === "gt" ? (r) => (r[k] as string | number) > v : (r) => (r[k] as string | number) >= v,
        );
        break;
      }
      case "not": {
        if (arg === null) parts.push((r) => r[k] !== null && r[k] !== undefined);
        else if (isOp(arg)) {
          const inner = fieldTest(k, arg);
          parts.push((r) => !inner(r));
        } else {
          const v = val(arg, day);
          parts.push((r) => r[k] !== v);
        }
        break;
      }
      case "contains":
      case "startsWith": {
        const needle = ci ? String(arg).toLowerCase() : String(arg);
        parts.push((r) => {
          const s = typeof r[k] === "string" ? (ci ? (r[k] as string).toLowerCase() : (r[k] as string)) : null;
          return s !== null && (op === "contains" ? s.includes(needle) : s.startsWith(needle));
        });
        break;
      }
      default:
        throw new Error(`facts: filter ${op} is not supported`);
    }
  }
  return (r) => parts.every((t) => t(r));
}

const asDate = (d: string) => new Date(`${d}T00:00:00.000Z`);
const out = (k: string, v: unknown) => (k === "day" && typeof v === "string" ? asDate(v) : v);

type Acc = { key: Row; sum: Map<string, number>; min: Map<string, unknown>; max: Map<string, unknown>; count: Map<string, number>; n: number };

const orderList = (o: unknown): [string, "asc" | "desc"][] => (o ? (Array.isArray(o) ? o : [o]).flatMap((x) => Object.entries(x as object) as [string, "asc" | "desc"][]) : []);

function sortRows<T extends Record<string, unknown>>(rows: T[], orderBy: unknown): T[] {
  const list = orderList(orderBy);
  if (!list.length) return rows;
  return [...rows].sort((a, b) => {
    for (const [k, dir] of list) {
      const x = a[k] instanceof Date ? (a[k] as Date).getTime() : (a[k] as number | string);
      const y = b[k] instanceof Date ? (b[k] as Date).getTime() : (b[k] as number | string);
      if (x === y) continue;
      const c = x < y ? -1 : 1;
      return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

/**
 * Runs one read over rows (already filtered by `where`, or not: it is applied here). Results are
 * shaped as Prisma's (and as lib/facts-sql-shared's decoded rows): days as Dates, sums numbers.
 */
export function evaluate(op: ReadOp, rows: Iterable<Row>, prefiltered = false): unknown {
  const pass = prefiltered ? () => true : compileWhere(op.where);
  if (op.op === "count") {
    let n = 0;
    for (const r of rows) if (pass(r)) n++;
    return n;
  }
  if (op.op === "findMany") {
    const sel = op.select ? Object.entries(op.select).filter(([, on]) => on).map(([k]) => k) : null;
    let list: Record<string, unknown>[] = [];
    for (const r of rows) {
      if (!pass(r)) continue;
      const o: Record<string, unknown> = {};
      for (const k of sel ?? Object.keys(r)) o[k] = out(k, r[k]);
      list.push(o);
    }
    list = sortRows(list, op.orderBy);
    return op.take !== undefined ? list.slice(0, Math.max(0, op.take)) : list;
  }
  const by = op.op === "groupBy" ? op.by : [];
  const groups = new Map<string, Acc>();
  const sums = Object.entries(op._sum ?? {}).filter(([, on]) => on).map(([k]) => k);
  const mins = Object.entries(op._min ?? {}).filter(([, on]) => on).map(([k]) => k);
  const maxs = Object.entries(op._max ?? {}).filter(([, on]) => on).map(([k]) => k);
  const counts = op._count === true ? ["_all"] : Object.entries(op._count ?? {}).filter(([, on]) => on).map(([k]) => k);
  for (const r of rows) {
    if (!pass(r)) continue;
    const gk = by.length === 1 ? String(r[by[0]!]) : by.map((b) => String(r[b])).join("\u0000");
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = { key: Object.fromEntries(by.map((b) => [b, r[b]!])), sum: new Map(), min: new Map(), max: new Map(), count: new Map(), n: 0 }));
    g.n++;
    for (const f of sums) g.sum.set(f, (g.sum.get(f) ?? 0) + Number(r[f] ?? 0));
    for (const f of mins) {
      const v = r[f];
      if (v === null || v === undefined) continue;
      const cur = g.min.get(f);
      if (cur === undefined || (v as string | number) < (cur as string | number)) g.min.set(f, v);
    }
    for (const f of maxs) {
      const v = r[f];
      if (v === null || v === undefined) continue;
      const cur = g.max.get(f);
      if (cur === undefined || (v as string | number) > (cur as string | number)) g.max.set(f, v);
    }
    for (const f of counts) if (f !== "_all" && r[f] !== null && r[f] !== undefined) g.count.set(f, (g.count.get(f) ?? 0) + 1);
  }
  const shape = (g: Acc | null) => {
    const o: Record<string, unknown> = {};
    if (g) for (const b of by) o[b] = out(b, g.key[b]);
    if (sums.length) o._sum = Object.fromEntries(sums.map((f) => [f, g ? (g.n ? (g.sum.get(f) ?? 0) : null) : null]));
    if (mins.length) o._min = Object.fromEntries(mins.map((f) => [f, g?.min.has(f) ? out(f, g.min.get(f)) : null]));
    if (maxs.length) o._max = Object.fromEntries(maxs.map((f) => [f, g?.max.has(f) ? out(f, g.max.get(f)) : null]));
    if (op._count === true) o._count = g?.n ?? 0;
    else if (counts.length) o._count = Object.fromEntries(counts.map((f) => [f, f === "_all" ? (g?.n ?? 0) : (g?.count.get(f) ?? 0)]));
    return o;
  };
  if (op.op === "aggregate") return shape(groups.size ? mergeAll([...groups.values()]) : null);
  let list = [...groups.values()].map(shape);
  list = sortRows(list, op.op === "groupBy" ? op.orderBy : undefined);
  return op.op === "groupBy" && op.take !== undefined ? list.slice(0, Math.max(0, op.take)) : list;
}

/** One group of everything (aggregate). */
function mergeAll(gs: Acc[]): Acc {
  if (gs.length === 1) return gs[0]!;
  const m: Acc = { key: {}, sum: new Map(), min: new Map(), max: new Map(), count: new Map(), n: 0 };
  for (const g of gs) {
    m.n += g.n;
    for (const [k, v] of g.sum) m.sum.set(k, (m.sum.get(k) ?? 0) + v);
    for (const [k, v] of g.min) if (!m.min.has(k) || (v as number) < (m.min.get(k) as number)) m.min.set(k, v);
    for (const [k, v] of g.max) if (!m.max.has(k) || (v as number) > (m.max.get(k) as number)) m.max.set(k, v);
    for (const [k, v] of g.count) m.count.set(k, (m.count.get(k) ?? 0) + v);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Stock month rows, fast: the shapes compute and the screens use
// ---------------------------------------------------------------------------

/** One StockMonth row as fetched (decoded): its series, month (YYYY-MM) and 31-day array. */
export type StockMonthRow = { variantId: string; locationId: string; month: string; mask: number; units: (number | null)[] };

const ROW_KEYS = new Set(["shop", "variantId", "locationId"]);
const DAY_KEYS = new Set(["day"]);
const CELL_KEYS = new Set(["outOfStock", "endUnits"]);

/** Day-of-month window [a, b] (1-based) of a month inside [lo, hi] (YYYY-MM-DD, inclusive), or null. */
function window(month: string, lo: string | null, hi: string | null): [number, number] | null {
  const first = `${month}-01`;
  const last = `${month}-31`;
  if (hi !== null && hi < first) return null;
  if (lo !== null && lo > last) return null;
  const a = lo !== null && lo > first ? Number(lo.slice(8, 10)) : 1;
  const b = hi !== null && hi.slice(0, 7) === month ? Number(hi.slice(8, 10)) : 31;
  return a <= b ? [a, b] : null;
}

/**
 * The fast form of `evaluate` for stock month rows, or undefined when the read is not one of the
 * simple shapes (then the caller expands the days and uses `evaluate`): conditions only at the top
 * level — shop / variant / location (checked once per month row), day (a range, an equality or a
 * list: an index window), outOfStock / endUnits (per day) — grouped by any of variantId,
 * locationId, day, with _sum / _count / _min / _max; or findMany / count. Same answers as `evaluate`.
 */
export function evaluateStockMonths(op: ReadOp, shop: string, rows: readonly StockMonthRow[]): unknown | undefined {
  const where = op.where ?? {};
  for (const [k, c] of Object.entries(where)) {
    if (c === undefined) continue;
    if (!ROW_KEYS.has(k) && !DAY_KEYS.has(k) && !CELL_KEYS.has(k)) return undefined; // AND / OR / NOT …
    if (k === "day" && isOp(c) && Object.keys(c).some((x) => !["gte", "gt", "lte", "lt", "equals", "in"].includes(x))) return undefined;
  }
  const rowPass = compileWhere(Object.fromEntries(Object.entries(where).filter(([k]) => ROW_KEYS.has(k))) as Where);
  const cellPass = compileWhere(Object.fromEntries(Object.entries(where).filter(([k]) => CELL_KEYS.has(k))) as Where);
  const cellFree = !Object.keys(where).some((k) => CELL_KEYS.has(k) && where[k] !== undefined);
  // Day bounds (inclusive) and an optional list.
  let lo: string | null = null;
  let hi: string | null = null;
  let list: Set<string> | null = null;
  const dc = where.day;
  const shift = (x: string, n: number) => {
    const t = new Date(`${x}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  if (dc instanceof Date || typeof dc === "string") lo = hi = dayString(dc);
  else if (isOp(dc)) {
    for (const [o, v] of Object.entries(dc)) {
      if (v === undefined || v === null) continue;
      if (o === "in") {
        list = new Set((v as unknown[]).map(dayString));
        continue;
      }
      const x = dayString(v);
      if (o === "gte" && (lo === null || x > lo)) lo = x;
      if (o === "gt" && (lo === null || shift(x, 1) > lo)) lo = shift(x, 1);
      if (o === "lte" && (hi === null || x < hi)) hi = x;
      if (o === "lt" && (hi === null || shift(x, -1) < hi)) hi = shift(x, -1);
      if (o === "equals") {
        if (lo === null || x > lo) lo = x;
        if (hi === null || x < hi) hi = x;
      }
    }
  }
  if (op.op === "groupBy" && op.by.some((b) => b !== "variantId" && b !== "locationId" && b !== "day")) return undefined;
  const by = op.op === "groupBy" ? op.by : [];
  const byDay = by.includes("day");
  const rowBy = by.filter((b) => b !== "day") as ("variantId" | "locationId")[];
  const cell: Row = { shop, day: "", variantId: "", locationId: "", endUnits: 0, outOfStock: false };

  if (op.op === "findMany" || op.op === "count") {
    const sel = op.op === "findMany" && op.select ? Object.entries(op.select).filter(([, on]) => on).map(([k]) => k) : null;
    let n = 0;
    const outRows: Record<string, unknown>[] = [];
    for (const r of rows) {
      cell.variantId = r.variantId;
      cell.locationId = r.locationId;
      if (!rowPass(cell)) continue;
      const w = window(r.month, lo, hi);
      if (!w) continue;
      for (let d = w[0]; d <= w[1]; d++) {
        const e = r.units[d - 1];
        if (e === null || e === undefined) continue;
        const day = `${r.month}-${d < 10 ? "0" : ""}${d}`;
        if (list && !list.has(day)) continue;
        cell.endUnits = e;
        cell.outOfStock = ((r.mask >> (d - 1)) & 1) === 1;
        if (!cellFree && !cellPass(cell)) continue;
        n++;
        if (op.op === "findMany") {
          const o: Record<string, unknown> = {};
          for (const k of sel ?? ["shop", "day", "variantId", "locationId", "endUnits", "outOfStock"]) o[k] = k === "day" ? new Date(`${day}T00:00:00.000Z`) : cell[k];
          outRows.push(o);
        }
      }
    }
    if (op.op === "count") return n;
    const sorted = sortRows(outRows, op.orderBy);
    return op.take !== undefined ? sorted.slice(0, Math.max(0, op.take)) : sorted;
  }

  // groupBy / aggregate: per row-group key (variant and / or location), one accumulator per month
  // with typed arrays indexed by day of month — no string or object per day (≈ 20 ns a day).
  for (const k of Object.keys({ ...op._sum, ...op._min, ...op._max })) if (k !== "endUnits" && k !== "day") return undefined;
  const wantMin = !!op._min?.endUnits;
  const wantMax = !!op._max?.endUnits;
  type M = { sum: Float64Array; n: Int32Array; min: Float64Array | null; max: Float64Array | null };
  type G = { key: Record<string, string>; months: Map<string, M> };
  const groups = new Map<string, G>();
  const newMonth = (): M => ({
    sum: new Float64Array(32),
    n: new Int32Array(32),
    min: wantMin ? new Float64Array(32).fill(Infinity) : null,
    max: wantMax ? new Float64Array(32).fill(-Infinity) : null,
  });
  for (const r of rows) {
    cell.variantId = r.variantId;
    cell.locationId = r.locationId;
    if (!rowPass(cell)) continue;
    const w = window(r.month, lo, hi);
    if (!w) continue;
    const rk = rowBy.length === 0 ? "" : rowBy.length === 1 ? (rowBy[0] === "variantId" ? r.variantId : r.locationId) : `${r.variantId}\u0000${r.locationId}`;
    let g = groups.get(rk);
    if (!g) groups.set(rk, (g = { key: keyOf(rowBy, r), months: new Map() }));
    let m = g.months.get(r.month);
    if (!m) g.months.set(r.month, (m = newMonth()));
    const units = r.units;
    for (let d = w[0]; d <= w[1]; d++) {
      const e = units[d - 1];
      if (e === null || e === undefined) continue;
      if (list && !list.has(`${r.month}-${d < 10 ? "0" : ""}${d}`)) continue;
      if (!cellFree) {
        cell.endUnits = e;
        cell.outOfStock = ((r.mask >> (d - 1)) & 1) === 1;
        if (!cellPass(cell)) continue;
      }
      m.n[d]++;
      m.sum[d] += e;
      if (m.min && e < m.min[d]!) m.min[d] = e;
      if (m.max && e > m.max[d]!) m.max[d] = e;
    }
  }
  const dayOf = (month: string, d: number) => `${month}-${d < 10 ? "0" : ""}${d}`;
  const epochOf = new Map<string, number>();
  const monthEpoch = (month: string) => epochOf.get(month) ?? epochOf.set(month, Date.parse(`${month}-01T00:00:00.000Z`)).get(month)!;
  const asD = (x: string | null) => (x === null ? null : new Date(monthEpoch(x.slice(0, 7)) + (Number(x.slice(8, 10)) - 1) * 86_400_000));
  type Out = { key: Record<string, string>; day: string | null; n: number; sum: number; min: number | null; max: number | null; dmin: string | null; dmax: string | null };
  // The result's fields, decided once (shaping 100,000s of groups is the hot part).
  const sumKeys = Object.entries(op._sum ?? {}).filter(([, on]) => on).map(([k]) => k);
  const minKeys = Object.entries(op._min ?? {}).filter(([, on]) => on).map(([k]) => k);
  const maxKeys = Object.entries(op._max ?? {}).filter(([, on]) => on).map(([k]) => k);
  const countKeys = op._count && op._count !== true ? Object.entries(op._count).filter(([, on]) => on).map(([k]) => k) : [];
  const shape = (g: Out | null) => {
    const o: Record<string, unknown> = {};
    if (g) {
      for (const b of rowBy) o[b] = g.key[b];
      if (byDay) o.day = asD(g.day);
    }
    if (op._sum) {
      const x: Record<string, unknown> = {};
      for (const k of sumKeys) x[k] = g ? g.sum : null;
      o._sum = x;
    }
    if (op._min) {
      const x: Record<string, unknown> = {};
      for (const k of minKeys) x[k] = !g ? null : k === "day" ? asD(g.dmin) : g.min;
      o._min = x;
    }
    if (op._max) {
      const x: Record<string, unknown> = {};
      for (const k of maxKeys) x[k] = !g ? null : k === "day" ? asD(g.dmax) : g.max;
      o._max = x;
    }
    if (op._count === true) o._count = g?.n ?? 0;
    else if (op._count) {
      const x: Record<string, unknown> = {};
      for (const k of countKeys) x[k] = g?.n ?? 0;
      o._count = x;
    }
    return o;
  };
  const outs: Out[] = [];
  // Grouped by day, without min / max of the day: the result rows are built directly (no day strings).
  if (byDay && op.op === "groupBy" && !minDayWanted(op) && !maxDayWanted(op) && !op.orderBy && op.take === undefined) {
    const res: Record<string, unknown>[] = [];
    const simpleCount = op._count === true;
    for (const g of groups.values())
      for (const [month, m] of g.months) {
        const base = monthEpoch(month);
        for (let d = 1; d <= 31; d++) {
          const n = m.n[d]!;
          if (!n) continue;
          const o: Record<string, unknown> = {};
          for (const b of rowBy) o[b] = g.key[b];
          o.day = new Date(base + (d - 1) * 86_400_000);
          if (op._sum) {
            const x: Record<string, unknown> = {};
            for (const k of sumKeys) x[k] = m.sum[d];
            o._sum = x;
          }
          if (op._min) {
            const x: Record<string, unknown> = {};
            for (const k of minKeys) x[k] = m.min![d];
            o._min = x;
          }
          if (op._max) {
            const x: Record<string, unknown> = {};
            for (const k of maxKeys) x[k] = m.max![d];
            o._max = x;
          }
          if (simpleCount) o._count = n;
          else if (op._count) {
            const x: Record<string, unknown> = {};
            for (const k of countKeys) x[k] = n;
            o._count = x;
          }
          res.push(o);
        }
      }
    return res;
  }
  for (const g of groups.values()) {
    if (byDay) {
      for (const [month, m] of g.months)
        for (let d = 1; d <= 31; d++) {
          if (!m.n[d]) continue;
          const day = dayOf(month, d);
          outs.push({ key: g.key, day, n: m.n[d]!, sum: m.sum[d]!, min: m.min ? m.min[d]! : null, max: m.max ? m.max[d]! : null, dmin: day, dmax: day });
        }
      continue;
    }
    const o: Out = { key: g.key, day: null, n: 0, sum: 0, min: null, max: null, dmin: null, dmax: null };
    for (const [month, m] of g.months)
      for (let d = 1; d <= 31; d++) {
        if (!m.n[d]) continue;
        o.n += m.n[d]!;
        o.sum += m.sum[d]!;
        if (m.min && (o.min === null || m.min[d]! < o.min)) o.min = m.min[d]!;
        if (m.max && (o.max === null || m.max[d]! > o.max)) o.max = m.max[d]!;
        const day = minDayWanted(op) || maxDayWanted(op) ? dayOf(month, d) : null;
        if (day !== null && (o.dmin === null || day < o.dmin)) o.dmin = day;
        if (day !== null && (o.dmax === null || day > o.dmax)) o.dmax = day;
      }
    if (o.n) outs.push(o);
  }
  if (op.op === "aggregate") {
    if (!outs.length) return shape(null);
    const all: Out = { key: {}, day: null, n: 0, sum: 0, min: null, max: null, dmin: null, dmax: null };
    for (const g of outs) {
      all.n += g.n;
      all.sum += g.sum;
      if (g.min !== null && (all.min === null || g.min < all.min)) all.min = g.min;
      if (g.max !== null && (all.max === null || g.max > all.max)) all.max = g.max;
      if (g.dmin !== null && (all.dmin === null || g.dmin < all.dmin)) all.dmin = g.dmin;
      if (g.dmax !== null && (all.dmax === null || g.dmax > all.dmax)) all.dmax = g.dmax;
    }
    return shape(all);
  }
  let list2 = outs.map(shape);
  list2 = sortRows(list2, op.orderBy);
  return op.take !== undefined ? list2.slice(0, Math.max(0, op.take)) : list2;
}

const minDayWanted = (op: ReadOp) => (op.op === "groupBy" || op.op === "aggregate") && !!op._min?.day;
const maxDayWanted = (op: ReadOp) => (op.op === "groupBy" || op.op === "aggregate") && !!op._max?.day;

function keyOf(by: readonly ("variantId" | "locationId")[], r: StockMonthRow): Record<string, string> {
  const k: Record<string, string> = {};
  for (const b of by) k[b] = r[b];
  return k;
}
