/**
 * SQL for the compact fact tables (DB scale "before 1,000 stores"). Pure: SQL text + parameters;
 * services/facts-store.server runs it (Prisma raw queries in the app, psql in the tests).
 *
 * READS. The app keeps asking for the old daily rows — SalesDaily, StockDaily, SessionsDaily —
 * with Prisma-shaped arguments (where / by / _sum / _min / _max / _count / select / orderBy /
 * take) in the app's own ids. `buildRead` translates one such read into SQL over the compact
 * table, with the same result: SalesFact as is (gross from cents), StockMonth unnested into one
 * row per day with data (`unnest(endUnits) WITH ORDINALITY`; day = month + i − 1, outOfStock =
 * bit i − 1 of outMask), SessionsFact as is. Filters supported: equality, in, notIn, not, lt,
 * lte, gt, gte, equals, contains / startsWith (text), AND / OR / NOT — what the app uses. Every
 * read is for one shop (`shop` equality at the top level), so the shop number is fixed.
 * Dictionary values (locations, channels, traffic types) and variant GIDs are encoded through
 * `Resolved`; a value with no number cannot be in the table (equality → false, notIn → ignored).
 *
 * WRITES replace one shop's rows over a day range with the fresh facts (idempotent), touching
 * only what changed: rows no longer there are deleted, others go through
 * INSERT … ON CONFLICT DO UPDATE … WHERE (the values differ), in chunks, with parameter arrays
 * (unnest) — one statement per chunk, never a row at a time, and never a rewrite of an unchanged
 * row. StockMonth writes merge the range's days into each month's array.
 *
 * Every parameter is a string (or an array of strings) with an explicit cast in the SQL, so the
 * same text runs through Prisma ($queryRawUnsafe / $executeRawUnsafe) and through psql.
 */
import { addDays } from "./sync/shopifyql-shared";
import { dayString, monthOf, monthSegments, variantNum } from "./ids-shared";

export type FactTableName = "salesDaily" | "stockDaily" | "sessionsDaily";

type Kind = "shop" | "variant" | "key" | "int" | "bool" | "day" | "text" | "cents";
type Field = { kind: Kind; expr: string };

const SALES_FIELDS: Record<string, Field> = {
  shop: { kind: "shop", expr: `s."shopNum"` },
  day: { kind: "day", expr: `s."day"` },
  variantId: { kind: "variant", expr: `s."variantNum"` },
  locationKey: { kind: "key", expr: `s."locNum"` },
  channel: { kind: "key", expr: `s."channelNum"` },
  sold: { kind: "int", expr: `s."sold"` },
  returned: { kind: "int", expr: `s."returned"` },
  gross: { kind: "cents", expr: `s."grossCents"` },
};

const STOCK_DAY = `(s."month" + (u.i::int - 1))`;
const STOCK_FIELDS: Record<string, Field> = {
  shop: { kind: "shop", expr: `s."shopNum"` },
  day: { kind: "day", expr: STOCK_DAY },
  variantId: { kind: "variant", expr: `s."variantNum"` },
  locationId: { kind: "key", expr: `s."locNum"` },
  endUnits: { kind: "int", expr: `u.e` },
  outOfStock: { kind: "bool", expr: `(((s."outMask" >> (u.i::int - 1)) & 1) = 1)` },
};

const SESSIONS_FIELDS: Record<string, Field> = {
  shop: { kind: "shop", expr: `s."shopNum"` },
  day: { kind: "day", expr: `s."day"` },
  landingPath: { kind: "text", expr: `s."landingPath"` },
  trafficType: { kind: "key", expr: `s."trafficNum"` },
  sessions: { kind: "int", expr: `s."sessions"` },
  checkouts: { kind: "int", expr: `s."checkouts"` },
};

const TABLES: Record<FactTableName, { fields: Record<string, Field>; from: string; base: string | null; physical: string }> = {
  salesDaily: { fields: SALES_FIELDS, from: `"SalesFact" s`, base: null, physical: "SalesFact" },
  stockDaily: {
    fields: STOCK_FIELDS,
    from: `"StockMonth" s CROSS JOIN LATERAL unnest(s."endUnits") WITH ORDINALITY AS u(e, i)`,
    base: `u.e IS NOT NULL`,
    physical: "StockMonth",
  },
  sessionsDaily: { fields: SESSIONS_FIELDS, from: `"SessionsFact" s`, base: null, physical: "SessionsFact" },
};

/** The dictionary fields of a table (their values are FactKey strings). */
export function keyFields(table: FactTableName): string[] {
  return Object.entries(TABLES[table].fields)
    .filter(([, f]) => f.kind === "key")
    .map(([k]) => k);
}

export type Where = Record<string, unknown>;
export type AggFields = Record<string, boolean | undefined>;
export type OrderBy = Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[];

export type ReadOp =
  | {
      op: "groupBy";
      by: string[];
      where?: Where;
      _sum?: AggFields;
      _min?: AggFields;
      _max?: AggFields;
      _count?: AggFields | true;
      orderBy?: OrderBy;
      take?: number;
    }
  | { op: "findMany"; where?: Where; select?: AggFields; orderBy?: OrderBy; take?: number }
  | { op: "aggregate"; where?: Where; _sum?: AggFields; _min?: AggFields; _max?: AggFields; _count?: AggFields | true }
  | { op: "count"; where?: Where };

/** What the translator needs from the database: the shop's number and the dictionary. */
export interface Resolved {
  shopNum: number;
  /** A FactKey's number; undefined = not in the dictionary (so in no row). */
  keyNum(key: string): number | undefined;
}

const OPS = new Set(["equals", "in", "notIn", "lt", "lte", "gt", "gte", "not", "contains", "startsWith", "mode"]);

function isOpObject(c: unknown): c is Record<string, unknown> {
  return !!c && typeof c === "object" && !(c instanceof Date) && !Array.isArray(c) && Object.keys(c).some((k) => OPS.has(k));
}

/** The top-level shop of a where (every fact read is for one shop). */
export function whereShop(where: Where | undefined): string {
  const s = where?.shop;
  if (typeof s === "string") return s;
  if (isOpObject(s) && typeof s.equals === "string") return s.equals;
  throw new Error("facts: every read needs `shop` (one shop) at the top level of `where`");
}

/** Every dictionary string a where mentions (to resolve before building the SQL). */
export function whereKeys(table: FactTableName, where: Where | undefined): string[] {
  const fields = TABLES[table].fields;
  const out = new Set<string>();
  const walk = (w: unknown) => {
    if (!w || typeof w !== "object") return;
    for (const [k, c] of Object.entries(w as Where)) {
      if (k === "AND" || k === "OR") for (const x of Array.isArray(c) ? c : [c]) walk(x);
      else if (k === "NOT") for (const x of Array.isArray(c) ? c : [c]) walk(x);
      else if (fields[k]?.kind === "key") collect(c);
    }
  };
  const collect = (c: unknown) => {
    if (typeof c === "string") out.add(c);
    else if (isOpObject(c)) {
      for (const [op, v] of Object.entries(c)) {
        if (op === "in" || op === "notIn") for (const x of v as unknown[]) typeof x === "string" && out.add(x);
        else if (op === "not" && isOpObject(v)) collect(v);
        else if (typeof v === "string") out.add(v);
      }
    }
  };
  walk(where);
  return [...out];
}

class Params {
  readonly list: unknown[] = [];
  push(v: unknown): string {
    this.list.push(v);
    return `$${this.list.length}`;
  }
}

const SCALAR_CAST: Record<Kind, string> = {
  shop: "::int4",
  variant: "::int8",
  key: "::int4",
  int: "::int8",
  bool: "::bool",
  day: "::date",
  text: "::text",
  cents: "::int8",
};
const ARRAY_CAST: Record<Kind, string> = {
  shop: "::text[]::int4[]",
  variant: "::text[]::int8[]",
  key: "::text[]::int4[]",
  int: "::text[]::int8[]",
  bool: "::text[]::bool[]",
  day: "::text[]::date[]",
  text: "::text[]",
  cents: "::text[]::int8[]",
};

/** A where value as the column's stored form (a string), or null when no row can have it. */
function encode(f: Field, v: unknown, r: Resolved): string | null {
  if (v === null || v === undefined) return null;
  switch (f.kind) {
    case "variant":
      return typeof v === "string" ? variantNum(v) : null;
    case "key": {
      if (typeof v !== "string") return null;
      const n = r.keyNum(v);
      return n === undefined ? null : String(n);
    }
    case "day":
      return dayString(v);
    case "int":
      return Number.isFinite(Number(v)) ? String(Number(v)) : null;
    case "bool":
      return v ? "true" : "false";
    case "text":
      return String(v);
    case "cents":
      throw new Error("facts: filtering on an amount is not supported");
    case "shop":
      return null;
  }
}

function condition(field: string, f: Field, c: unknown, r: Resolved, p: Params): string | null {
  if (c === undefined) return null;
  if (f.kind === "shop") {
    // Checked once at the top level (whereShop); a nested shop condition must name the same shop.
    return null;
  }
  if (!isOpObject(c)) {
    const v = encode(f, c, r);
    if (c === null) return `${f.expr} IS NULL`;
    return v === null ? "FALSE" : `${f.expr} = ${p.push(v)}${SCALAR_CAST[f.kind]}`;
  }
  const parts: string[] = [];
  const ci = (c as { mode?: unknown }).mode === "insensitive";
  for (const [op, arg] of Object.entries(c)) {
    if (arg === undefined || op === "mode") continue;
    switch (op) {
      case "equals": {
        const v = encode(f, arg, r);
        parts.push(arg === null ? `${f.expr} IS NULL` : v === null ? "FALSE" : `${f.expr} = ${p.push(v)}${SCALAR_CAST[f.kind]}`);
        break;
      }
      case "in":
      case "notIn": {
        const vals = (arg as unknown[]).map((x) => encode(f, x, r)).filter((x): x is string => x !== null);
        const uniq = [...new Set(vals)];
        if (op === "in") parts.push(uniq.length ? `${f.expr} = ANY(${p.push(uniq)}${ARRAY_CAST[f.kind]})` : "FALSE");
        else if (uniq.length) parts.push(`NOT (${f.expr} = ANY(${p.push(uniq)}${ARRAY_CAST[f.kind]}))`);
        break;
      }
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const v = encode(f, arg, r);
        if (v === null) {
          parts.push("FALSE");
          break;
        }
        const sym = op === "lt" ? "<" : op === "lte" ? "<=" : op === "gt" ? ">" : ">=";
        parts.push(`${f.expr} ${sym} ${p.push(v)}${SCALAR_CAST[f.kind]}`);
        break;
      }
      case "not": {
        if (arg === null) {
          parts.push(`${f.expr} IS NOT NULL`);
          break;
        }
        if (isOpObject(arg)) {
          const inner = condition(field, f, arg, r, p);
          if (inner) parts.push(`NOT (${inner})`);
          break;
        }
        const v = encode(f, arg, r);
        if (v !== null) parts.push(`${f.expr} <> ${p.push(v)}${SCALAR_CAST[f.kind]}`);
        break;
      }
      case "contains":
      case "startsWith": {
        if (f.kind !== "text") throw new Error(`facts: ${op} on ${field} is not supported`);
        const e = ci ? `lower(${f.expr})` : f.expr;
        const v = p.push(ci ? String(arg).toLowerCase() : String(arg));
        parts.push(op === "contains" ? `strpos(${e}, ${v}::text) > 0` : `starts_with(${e}, ${v}::text)`);
        break;
      }
      default:
        throw new Error(`facts: filter ${op} is not supported`);
    }
  }
  return parts.length ? parts.join(" AND ") : null;
}

function whereSql(table: FactTableName, where: Where | undefined, r: Resolved, p: Params): string | null {
  if (!where) return null;
  const fields = TABLES[table].fields;
  const parts: string[] = [];
  for (const [k, c] of Object.entries(where)) {
    if (c === undefined) continue;
    if (k === "AND") {
      for (const x of Array.isArray(c) ? c : [c]) {
        const s = whereSql(table, x as Where, r, p);
        if (s) parts.push(`(${s})`);
      }
      continue;
    }
    if (k === "OR") {
      const list = (c as Where[]).map((x) => whereSql(table, x, r, p) ?? "TRUE");
      parts.push(list.length ? `(${list.map((s) => `(${s})`).join(" OR ")})` : "FALSE");
      continue;
    }
    if (k === "NOT") {
      for (const x of Array.isArray(c) ? c : [c]) {
        const s = whereSql(table, x as Where, r, p);
        if (s) parts.push(`NOT (${s})`);
      }
      continue;
    }
    const f = fields[k];
    if (!f) throw new Error(`facts: ${table} has no field ${k}`);
    if (f.kind === "shop" && whereShopValue(c) === undefined) throw new Error("facts: shop must be an equality");
    const s = condition(k, f, c, r, p);
    if (s) parts.push(s);
  }
  return parts.length ? parts.join(" AND ") : null;
}

function whereShopValue(c: unknown): string | undefined {
  if (typeof c === "string") return c;
  if (isOpObject(c) && typeof c.equals === "string") return c.equals;
  return undefined;
}

/** Inclusive day bounds a where's top level (and its top-level ANDs) put on `day`. */
export function dayBounds(where: Where | undefined): { lo: string | null; hi: string | null } {
  let lo: string | null = null;
  let hi: string | null = null;
  const tighten = (l: string | null, h: string | null) => {
    if (l !== null && (lo === null || l > lo)) lo = l;
    if (h !== null && (hi === null || h < hi)) hi = h;
  };
  const visit = (w: Where | undefined) => {
    if (!w) return;
    const c = w.day;
    if (c instanceof Date || typeof c === "string") tighten(dayString(c), dayString(c));
    else if (isOpObject(c)) {
      for (const [op, v] of Object.entries(c)) {
        if (v === undefined || v === null) continue;
        if (op === "gte") tighten(dayString(v), null);
        else if (op === "gt") tighten(addDays(dayString(v), 1), null);
        else if (op === "lte") tighten(null, dayString(v));
        else if (op === "lt") tighten(null, addDays(dayString(v), -1));
        else if (op === "equals") tighten(dayString(v), dayString(v));
        else if (op === "in") {
          const days = (v as unknown[]).map(dayString).sort();
          if (days.length) tighten(days[0]!, days[days.length - 1]!);
          else tighten("9999-12-31", "0001-01-01");
        }
      }
    }
    const and = w.AND;
    if (and) for (const x of Array.isArray(and) ? and : [and]) visit(x as Where);
  };
  visit(where);
  return { lo, hi };
}

/** Stock rows outside the day bounds are skipped before they are unnested (month, firstDay, lastDay). */
function stockRowFilter(where: Where | undefined, p: Params): string[] {
  const { lo, hi } = dayBounds(where);
  const out: string[] = [];
  if (lo !== null) {
    out.push(`s."month" >= ${p.push(monthOf(lo))}::date`);
    out.push(`(s."month" + (s."lastDay" - 1)) >= ${p.push(lo)}::date`);
  }
  if (hi !== null) {
    out.push(`s."month" <= ${p.push(hi)}::date`);
    out.push(`(s."month" + (s."firstDay" - 1)) <= ${p.push(hi)}::date`);
  }
  return out;
}

function fieldOf(table: FactTableName, name: string): Field {
  const f = TABLES[table].fields[name];
  if (!f) throw new Error(`facts: ${table} has no field ${name}`);
  return f;
}

/** How the store turns result columns back into the app's values. */
export type OutColumn = { alias: string; path: (string | number)[]; kind: Kind | "count" };
export type BuiltRead = { sql: string; params: unknown[]; columns: OutColumn[]; single: boolean; countOnly?: boolean };

const order = (o: OrderBy | undefined): [string, "asc" | "desc"][] => {
  if (!o) return [];
  const list = Array.isArray(o) ? o : [o];
  return list.flatMap((x) => Object.entries(x) as [string, "asc" | "desc"][]);
};

/** No condition other than shop / variant / location on a stock read (the firstDay / lastDay shortcut applies). */
function stockKeysOnly(where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => v === undefined || k === "shop" || k === "variantId" || k === "locationId");
}

function aggList(table: FactTableName, op: { _sum?: AggFields; _min?: AggFields; _max?: AggFields; _count?: AggFields | true }) {
  const cols: { sql: string; out: OutColumn }[] = [];
  const add = (fn: "sum" | "min" | "max", fields: AggFields | undefined) => {
    for (const [name, on] of Object.entries(fields ?? {})) {
      if (!on) continue;
      const f = fieldOf(table, name);
      if (fn === "sum" && !(f.kind === "int" || f.kind === "cents")) throw new Error(`facts: _sum of ${name} is not supported`);
      const alias = `${fn}_${name}`;
      cols.push({ sql: `${fn}(${f.expr}) AS "${alias}"`, out: { alias, path: [`_${fn}`, name], kind: f.kind } });
    }
  };
  add("sum", op._sum);
  add("min", op._min);
  add("max", op._max);
  if (op._count === true) cols.push({ sql: `count(*) AS "count_all"`, out: { alias: "count_all", path: ["_count"], kind: "count" } });
  else
    for (const [name, on] of Object.entries(op._count ?? {})) {
      if (!on) continue;
      const alias = `count_${name}`;
      const expr = name === "_all" ? "count(*)" : `count(${fieldOf(table, name).expr})`;
      cols.push({ sql: `${expr} AS "${alias}"`, out: { alias, path: ["_count", name], kind: "count" } });
    }
  return cols;
}

/** Does a stock read take the firstDay / lastDay shortcut in buildRead (no unnest, no fetch)? */
export function stockShortcut(op: ReadOp): boolean {
  if (!stockKeysOnly(op.where)) return false;
  if (op.op === "groupBy" || op.op === "aggregate") {
    const onlyDayMinMax = !op._sum && !op._count && Object.keys({ ...op._min, ...op._max }).every((k) => k === "day") && !!(op._min?.day || op._max?.day);
    return onlyDayMinMax && (op.op === "aggregate" || op.by.every((b) => b === "variantId" || b === "locationId"));
  }
  if (op.op === "findMany") {
    const o = order(op.orderBy);
    return op.take === 1 && !!op.select && Object.entries(op.select).every(([k, on]) => !on || k === "day") && o.length === 1 && o[0]![0] === "day";
  }
  return false;
}

/**
 * The StockMonth rows a stock read can match, for evaluating it in memory (lib/facts-eval-shared):
 * the shop, the top-level variant and location conditions and the months of the day bounds —
 * index work only; every condition is applied again on the expanded days.
 */
export function buildStockFetch(where: Where | undefined, r: Resolved): { sql: string; params: unknown[] } {
  const p = new Params();
  const conds: string[] = [`s."shopNum" = ${p.push(String(r.shopNum))}::int4`];
  const pushKeys = (field: string) => {
    const c = where?.[field];
    if (c === undefined) return;
    const f = STOCK_FIELDS[field]!;
    if (typeof c === "string" || (isOpObject(c) && Object.keys(c).every((k) => k === "in" || k === "notIn" || k === "equals"))) {
      const s = condition(field, f, c, r, p);
      if (s) conds.push(s);
    }
  };
  pushKeys("variantId");
  pushKeys("locationId");
  const { lo, hi } = dayBounds(where);
  if (lo !== null) conds.push(`s."month" >= ${p.push(monthOf(lo))}::date`);
  if (hi !== null) conds.push(`s."month" <= ${p.push(hi)}::date`);
  return {
    sql: `SELECT s."variantNum", s."locNum", s."month", s."outMask", s."endUnits" FROM "StockMonth" s WHERE ${conds.join(" AND ")}`,
    params: p.list,
  };
}

/** The latest stock day of one month for a keys-only where (the newest-month-first probe). */
export function buildStockLatestInMonth(where: Where | undefined, month: string, r: Resolved): { sql: string; params: unknown[] } {
  const p = new Params();
  const conds: string[] = [`s."shopNum" = ${p.push(String(r.shopNum))}::int4`, `s."month" = ${p.push(month)}::date`];
  const w = whereSql("stockDaily", where, r, p);
  if (w) conds.push(w);
  return { sql: `SELECT max(s."month" + (s."lastDay" - 1)) AS "f_day" FROM "StockMonth" s WHERE ${conds.join(" AND ")}`, params: p.list };
}

/**
 * One read as SQL. `single`: the result is one object (aggregate, count) instead of a list.
 * Stock min / max of `day` with no condition but shop, variants and locations read firstDay /
 * lastDay (no unnest) — the stored first / last days' build and lookups.
 */
export function buildRead(table: FactTableName, op: ReadOp, r: Resolved): BuiltRead {
  const t = TABLES[table];
  const p = new Params();
  const conds: string[] = [`s."shopNum" = ${p.push(String(r.shopNum))}::int4`];
  whereShop(op.where);

  // Stock shortcut: min / max(day) per group without unnesting.
  if (table === "stockDaily" && stockKeysOnly(op.where) && (op.op === "groupBy" || op.op === "aggregate")) {
    const onlyDayMinMax =
      !op._sum && !op._count && Object.keys({ ...op._min, ...op._max }).every((k) => k === "day") && (op._min?.day || op._max?.day);
    if (onlyDayMinMax && (op.op === "aggregate" || op.by.every((b) => b === "variantId" || b === "locationId"))) {
      const w = whereSql(table, op.where, r, p);
      if (w) conds.push(w);
      const by = op.op === "groupBy" ? op.by : [];
      const cols: { sql: string; out: OutColumn }[] = by.map((b) => ({ sql: `${fieldOf(table, b).expr} AS "by_${b}"`, out: { alias: `by_${b}`, path: [b], kind: fieldOf(table, b).kind } }));
      if (op._min?.day) cols.push({ sql: `min(s."month" + (s."firstDay" - 1)) AS "min_day"`, out: { alias: "min_day", path: ["_min", "day"], kind: "day" } });
      if (op._max?.day) cols.push({ sql: `max(s."month" + (s."lastDay" - 1)) AS "max_day"`, out: { alias: "max_day", path: ["_max", "day"], kind: "day" } });
      const group = by.length ? ` GROUP BY ${by.map((_, i) => i + 1).join(", ")}` : "";
      return {
        sql: `SELECT ${cols.map((c) => c.sql).join(", ")} FROM "StockMonth" s WHERE ${conds.join(" AND ")}${group}`,
        params: p.list,
        columns: cols.map((c) => c.out),
        single: op.op === "aggregate",
      };
    }
  }
  // Stock shortcut: the first / last day of a findFirst / findMany ordered by day, take 1, select day.
  if (
    table === "stockDaily" &&
    op.op === "findMany" &&
    op.take === 1 &&
    stockKeysOnly(op.where) &&
    op.select &&
    Object.entries(op.select).every(([k, on]) => !on || k === "day") &&
    order(op.orderBy).length === 1 &&
    order(op.orderBy)[0]![0] === "day"
  ) {
    const w = whereSql(table, op.where, r, p);
    if (w) conds.push(w);
    const desc = order(op.orderBy)[0]![1] === "desc";
    const expr = desc ? `max(s."month" + (s."lastDay" - 1))` : `min(s."month" + (s."firstDay" - 1))`;
    return {
      sql: `SELECT ${expr} AS "f_day" FROM "StockMonth" s WHERE ${conds.join(" AND ")} HAVING ${expr} IS NOT NULL`,
      params: p.list,
      columns: [{ alias: "f_day", path: ["day"], kind: "day" }],
      single: false,
    };
  }

  if (t.base) conds.push(t.base);
  if (table === "stockDaily") conds.push(...stockRowFilter(op.where, p));
  const w = whereSql(table, op.where, r, p);
  if (w) conds.push(w);
  const whereClause = ` WHERE ${conds.join(" AND ")}`;

  if (op.op === "count") {
    return { sql: `SELECT count(*) AS "count" FROM ${t.from}${whereClause}`, params: p.list, columns: [{ alias: "count", path: [], kind: "count" }], single: true, countOnly: true };
  }
  if (op.op === "aggregate") {
    const cols = aggList(table, op);
    return { sql: `SELECT ${cols.map((c) => c.sql).join(", ")} FROM ${t.from}${whereClause}`, params: p.list, columns: cols.map((c) => c.out), single: true };
  }
  if (op.op === "groupBy") {
    if (!op.by.length) throw new Error("facts: groupBy needs `by`");
    const byCols = op.by.map((b) => ({ sql: `${fieldOf(table, b).expr} AS "by_${b}"`, out: { alias: `by_${b}`, path: [b], kind: fieldOf(table, b).kind } as OutColumn }));
    const cols = [...byCols, ...aggList(table, op)];
    const ob = order(op.orderBy).map(([k, dir]) => {
      if (!op.by.includes(k)) throw new Error(`facts: groupBy orderBy ${k} must be a by field`);
      return `"by_${k}" ${dir === "desc" ? "DESC" : "ASC"}`;
    });
    return {
      sql: `SELECT ${cols.map((c) => c.sql).join(", ")} FROM ${t.from}${whereClause} GROUP BY ${op.by.map((_, i) => i + 1).join(", ")}${ob.length ? ` ORDER BY ${ob.join(", ")}` : ""}${op.take !== undefined ? ` LIMIT ${Math.max(0, Math.trunc(op.take))}` : ""}`,
      params: p.list,
      columns: cols.map((c) => c.out),
      single: false,
    };
  }
  // findMany
  const names = op.select ? Object.entries(op.select).filter(([, on]) => on).map(([k]) => k) : Object.keys(t.fields);
  const cols = names.map((n) => ({ sql: `${fieldOf(table, n).expr} AS "f_${n}"`, out: { alias: `f_${n}`, path: [n], kind: fieldOf(table, n).kind } as OutColumn }));
  const ob = order(op.orderBy).map(([k, dir]) => `${fieldOf(table, k).expr} ${dir === "desc" ? "DESC" : "ASC"}`);
  return {
    sql: `SELECT ${cols.map((c) => c.sql).join(", ")} FROM ${t.from}${whereClause}${ob.length ? ` ORDER BY ${ob.join(", ")}` : ""}${op.take !== undefined ? ` LIMIT ${Math.max(0, Math.trunc(op.take))}` : ""}`,
    params: p.list,
    columns: cols.map((c) => c.out),
    single: false,
  };
}

/** The result columns holding dictionary numbers (the store resolves them to keys before decoding). */
export function keyColumns(b: BuiltRead): string[] {
  return b.columns.filter((c) => c.kind === "key").map((c) => c.alias);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type Statement = { sql: string; params: unknown[] };

/** Rows per upsert statement (each statement carries one array parameter per column). */
export const UPSERT_CHUNK = 20_000;

const arr = (xs: readonly (string | number)[]) => xs.map(String);

export type EncodedSales = { variantNum: string; locNum: number; channelNum: number; day: string; sold: number; returned: number; grossCents: string };

/**
 * Replace a shop's SalesFact rows in [since, until] with `rows` (already encoded, all inside the
 * range, unique per key): delete the keys that are gone, then upsert the rest in chunks — only
 * rows whose values changed are written.
 */
export function salesReplace(shopNum: number, since: string, until: string, rows: readonly EncodedSales[]): Statement[] {
  const v = rows.map((r) => r.variantNum);
  const l = rows.map((r) => r.locNum);
  const c = rows.map((r) => r.channelNum);
  const d = rows.map((r) => r.day);
  const out: Statement[] = [
    {
      sql: `DELETE FROM "SalesFact" t
WHERE t."shopNum" = $1::int4 AND t."day" >= $2::date AND t."day" <= $3::date
  AND NOT EXISTS (
    SELECT 1 FROM unnest($4::text[]::int8[], $5::text[]::int4[], $6::text[]::int4[], $7::text[]::date[]) AS n(v, l, c, d)
    WHERE n.v = t."variantNum" AND n.l = t."locNum" AND n.c = t."channelNum" AND n.d = t."day")`,
      params: [String(shopNum), since, until, v, arr(l), arr(c), d],
    },
  ];
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const part = rows.slice(i, i + UPSERT_CHUNK);
    out.push({
      sql: `INSERT INTO "SalesFact" AS t ("variantNum", "grossCents", "shopNum", "day", "locNum", "channelNum", "sold", "returned")
SELECT n.v, n.g, $1::int4, n.d, n.l, n.c, n.s, n.r
FROM unnest($2::text[]::int8[], $3::text[]::int4[], $4::text[]::int4[], $5::text[]::date[], $6::text[]::int4[], $7::text[]::int4[], $8::text[]::int8[]) AS n(v, l, c, d, s, r, g)
ON CONFLICT ("shopNum", "variantNum", "locNum", "channelNum", "day") DO UPDATE SET
  "sold" = EXCLUDED."sold", "returned" = EXCLUDED."returned", "grossCents" = EXCLUDED."grossCents"
WHERE (t."sold", t."returned", t."grossCents") IS DISTINCT FROM (EXCLUDED."sold", EXCLUDED."returned", EXCLUDED."grossCents")`,
      params: [
        String(shopNum),
        part.map((r) => r.variantNum),
        arr(part.map((r) => r.locNum)),
        arr(part.map((r) => r.channelNum)),
        part.map((r) => r.day),
        arr(part.map((r) => r.sold)),
        arr(part.map((r) => r.returned)),
        part.map((r) => r.grossCents),
      ],
    });
  }
  return out;
}

export type EncodedSessions = { day: string; landingPath: string; trafficNum: number; sessions: number; checkouts: number };

/** Replace a shop's SessionsFact rows in [since, until] (as salesReplace). */
export function sessionsReplace(shopNum: number, since: string, until: string, rows: readonly EncodedSessions[]): Statement[] {
  const out: Statement[] = [
    {
      sql: `DELETE FROM "SessionsFact" t
WHERE t."shopNum" = $1::int4 AND t."day" >= $2::date AND t."day" <= $3::date
  AND NOT EXISTS (
    SELECT 1 FROM unnest($4::text[]::date[], $5::text[], $6::text[]::int4[]) AS n(d, p, k)
    WHERE n.d = t."day" AND n.p = t."landingPath" AND n.k = t."trafficNum")`,
      params: [String(shopNum), since, until, rows.map((r) => r.day), rows.map((r) => r.landingPath), arr(rows.map((r) => r.trafficNum))],
    },
  ];
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const part = rows.slice(i, i + UPSERT_CHUNK);
    out.push({
      sql: `INSERT INTO "SessionsFact" AS t ("shopNum", "day", "trafficNum", "sessions", "checkouts", "landingPath")
SELECT $1::int4, n.d, n.k, n.s, n.c, n.p
FROM unnest($2::text[]::date[], $3::text[], $4::text[]::int4[], $5::text[]::int4[], $6::text[]::int4[]) AS n(d, p, k, s, c)
ON CONFLICT ("shopNum", "day", "landingPath", "trafficNum") DO UPDATE SET
  "sessions" = EXCLUDED."sessions", "checkouts" = EXCLUDED."checkouts"
WHERE (t."sessions", t."checkouts") IS DISTINCT FROM (EXCLUDED."sessions", EXCLUDED."checkouts")`,
      params: [
        String(shopNum),
        part.map((r) => r.day),
        part.map((r) => r.landingPath),
        arr(part.map((r) => r.trafficNum)),
        arr(part.map((r) => r.sessions)),
        arr(part.map((r) => r.checkouts)),
      ],
    });
  }
  return out;
}

export type EncodedStock = { variantNum: string; locNum: number; day: string; endUnits: number; outOfStock: boolean };

/** One series' days a..b of a month: the slice array literal, its out-of-stock bits, first / last day. */
type StockSlice = { variantNum: string; locNum: number; slice: string; mask: number; first: number; last: number };

/** Groups a month segment's rows into one slice per series (days a..b; NULL = no row that day). */
export function stockSlices(rows: readonly EncodedStock[], a: number, b: number): StockSlice[] {
  const by = new Map<string, { variantNum: string; locNum: number; vals: (number | null)[]; mask: number; first: number; last: number }>();
  for (const r of rows) {
    const d = Number(r.day.slice(8, 10));
    if (d < a || d > b) continue;
    const k = `${r.variantNum}|${r.locNum}`;
    let s = by.get(k);
    if (!s) by.set(k, (s = { variantNum: r.variantNum, locNum: r.locNum, vals: new Array<number | null>(b - a + 1).fill(null), mask: 0, first: d, last: d }));
    s.vals[d - a] = r.endUnits;
    // A repeated (series, day) keeps the last value, as the old delete + insert did not allow it at all.
    s.mask = r.outOfStock ? s.mask | (1 << (d - 1)) : s.mask & ~(1 << (d - 1));
    if (d < s.first) s.first = d;
    if (d > s.last) s.last = d;
  }
  return [...by.values()].map((s) => ({
    variantNum: s.variantNum,
    locNum: s.locNum,
    slice: `{${s.vals.map((x) => (x === null ? "NULL" : String(Math.trunc(x)))).join(",")}}`,
    mask: s.mask,
    first: s.first,
    last: s.last,
  }));
}

/** Bits a..b (days of month) set. */
export function dayMask(a: number, b: number): number {
  let m = 0;
  for (let d = a; d <= b; d++) m |= 1 << (d - 1);
  return m;
}

/**
 * Replace a shop's stock for days a..b of one month (one StockMonth row per series and month):
 *  1. series with nothing left in the month once a..b is cleared are deleted,
 *  2. other series not in the new data get a..b cleared,
 *  3. the new data is merged in (insert, or splice the days a..b into the stored array) — only
 *     rows whose days a..b differ are written.
 */
export function stockReplace(shopNum: number, month: string, a: number, b: number, rows: readonly EncodedStock[]): Statement[] {
  const slices = stockSlices(rows, a, b);
  const v = slices.map((s) => s.variantNum);
  const l = arr(slices.map((s) => s.locNum));
  const mask = String(dayMask(a, b));
  const notNew = `NOT EXISTS (SELECT 1 FROM unnest($5::text[]::int8[], $6::text[]::int4[]) AS n(v, l) WHERE n.v = t."variantNum" AND n.l = t."locNum")`;
  const cleared = `t."endUnits"[1:$3::int - 1] || array_fill(NULL::int4, ARRAY[$4::int - $3::int + 1]) || t."endUnits"[$4::int + 1:31]`;
  const head = [String(shopNum), month, String(a), String(b), v, l, mask];
  const out: Statement[] = [
    {
      sql: `DELETE FROM "StockMonth" t
WHERE t."shopNum" = $1::int4 AND t."month" = $2::date AND t."firstDay" >= $3::int AND t."lastDay" <= $4::int
  AND ${notNew}`,
      params: head.slice(0, 6),
    },
    {
      sql: `UPDATE "StockMonth" t SET
  "endUnits" = ${cleared},
  "outMask" = t."outMask" & ~($7::int4),
  "firstDay" = keha_first_day(${cleared}),
  "lastDay" = keha_last_day(${cleared})
WHERE t."shopNum" = $1::int4 AND t."month" = $2::date AND t."firstDay" <= $4::int AND t."lastDay" >= $3::int
  AND t."endUnits"[$3::int:$4::int] IS DISTINCT FROM array_fill(NULL::int4, ARRAY[$4::int - $3::int + 1])
  AND ${notNew}`,
      params: head,
    },
  ];
  for (let i = 0; i < slices.length; i += UPSERT_CHUNK) {
    const part = slices.slice(i, i + UPSERT_CHUNK);
    out.push({
      sql: `INSERT INTO "StockMonth" AS t ("variantNum", "shopNum", "month", "locNum", "outMask", "firstDay", "lastDay", "endUnits")
SELECT n.v, $1::int4, $2::date, n.l, n.m, n.f, n.z,
  array_fill(NULL::int4, ARRAY[$3::int - 1]) || n.e::int4[] || array_fill(NULL::int4, ARRAY[31 - $4::int])
FROM unnest($5::text[]::int8[], $6::text[]::int4[], $8::text[]::int4[], $9::text[]::int2[], $10::text[]::int2[], $11::text[]) AS n(v, l, m, f, z, e)
ON CONFLICT ("shopNum", "variantNum", "locNum", "month") DO UPDATE SET
  "endUnits" = t."endUnits"[1:$3::int - 1] || EXCLUDED."endUnits"[$3::int:$4::int] || t."endUnits"[$4::int + 1:31],
  "outMask" = (t."outMask" & ~($7::int4)) | EXCLUDED."outMask",
  "firstDay" = CASE WHEN t."firstDay" < $3::int THEN t."firstDay" ELSE EXCLUDED."firstDay" END,
  "lastDay" = CASE WHEN t."lastDay" > $4::int THEN t."lastDay" ELSE EXCLUDED."lastDay" END
WHERE t."endUnits"[$3::int:$4::int] IS DISTINCT FROM EXCLUDED."endUnits"[$3::int:$4::int]
   OR (t."outMask" & $7::int4) <> EXCLUDED."outMask"`,
      params: [
        String(shopNum),
        month,
        String(a),
        String(b),
        part.map((s) => s.variantNum),
        arr(part.map((s) => s.locNum)),
        mask,
        arr(part.map((s) => s.mask)),
        arr(part.map((s) => s.first)),
        arr(part.map((s) => s.last)),
        part.map((s) => s.slice),
      ],
    });
  }
  return out;
}

/** The month segments (one StockMonth write each) of a day range. */
export { monthSegments };

// ---------------------------------------------------------------------------
// Purge (uninstall / shop redact): one partition at a time, in batches
// ---------------------------------------------------------------------------

/** Rows deleted per purge statement (short transactions on large stores). */
export const PURGE_BATCH = 50_000;

/** Of these partitions, the ones holding a row of shop $1 (one index probe each); rows { part }. null = none to probe. */
export function purgeProbeSql(partitions: readonly string[]): string | null {
  if (!partitions.length) return null;
  return partitions
    .map((p) => {
      const t = `"${p.replace(/"/g, '""')}"`;
      return `SELECT '${p.replace(/'/g, "''")}'::text AS "part" WHERE EXISTS (SELECT 1 FROM ${t} WHERE "shopNum" = $1::int4)`;
    })
    .join("\nUNION ALL\n");
}

/** Deletes up to PURGE_BATCH of a shop's rows from one partition ($1 = shopNum). Repeat until 0. */
export function purgeBatchSql(partition: string): string {
  // regclass text comes back quoted when needed ("SalesFact_p202610"); a bare name is quoted here.
  const t = partition.startsWith('"') ? partition : `"${partition.replace(/"/g, '""')}"`;
  return `DELETE FROM ${t} WHERE ctid = ANY(ARRAY(SELECT ctid FROM ${t} WHERE "shopNum" = $1::int4 LIMIT ${PURGE_BATCH}))`;
}

/** Today's day minus n (re-export for the store). */
export { addDays };
