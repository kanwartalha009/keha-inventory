/**
 * A Prisma client stand-in that runs REAL SQL on Postgres through `psql` (the sandbox has no
 * Prisma query engine, tests/helpers/pg). The model metadata comes from the generated schema
 * (Prisma.dmmf): column types, ids, defaults and unique keys, so reads come back typed as Prisma
 * returns them (Date, Prisma.Decimal, bigint, parsed Json, arrays).
 *
 * The subset the app uses: findMany / findFirst / findUnique (where, select, orderBy, take, skip,
 * distinct), count, aggregate and groupBy (_sum, _min, _max, _count), create, createMany
 * (skipDuplicates), upsert (ON CONFLICT on the where's unique key), update, updateMany, delete,
 * deleteMany, $transaction (an array runs in ONE psql call inside one transaction; a callback runs
 * statement by statement), $queryRaw / $queryRawUnsafe. Where: equality, null, equals, in, notIn,
 * lt, lte, gt, gte, not, contains / startsWith / endsWith (mode "insensitive"), has, AND / OR /
 * NOT, compound unique selectors. Prisma's semantics where they differ from JS: `not: x` excludes
 * NULLs (SQL), a unique violation throws P2002, a missing update target P2025.
 *
 * Every statement prints exactly one jsonb line (psql -A -t), so a batch's output splits by line.
 * Operations are lazy (like PrismaPromise): nothing runs until awaited or put in a $transaction.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PG_CONN } from "./pg";

type Field = {
  name: string;
  kind: string;
  type: string;
  isList: boolean;
  isId: boolean;
  hasDefaultValue: boolean;
  isUpdatedAt: boolean;
  nativeType?: [string, string[]] | null;
  default?: unknown;
};
type Model = { name: string; fields: Field[]; byName: Map<string, Field> };
type Row = Record<string, unknown>;

const MODELS = new Map<string, Model>();
for (const m of Prisma.dmmf.datamodel.models) {
  const fields = (m.fields as unknown as Field[]).filter((f) => f.kind === "scalar" || f.kind === "enum");
  MODELS.set(m.name.charAt(0).toLowerCase() + m.name.slice(1), { name: m.name, fields, byName: new Map(fields.map((f) => [f.name, f])) });
}

const OPS = new Set(["equals", "in", "notIn", "lt", "lte", "gt", "gte", "not", "contains", "startsWith", "endsWith", "mode", "has"]);
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const str = (s: string) => `'${s.replace(/'/g, "''")}'`;

function isDecimalLike(v: unknown): boolean {
  return !!v && typeof v === "object" && typeof (v as { toFixed?: unknown }).toFixed === "function" && typeof (v as { toNumber?: unknown }).toNumber === "function";
}

const isDateField = (f?: Field) => !!f && f.type === "DateTime" && f.nativeType?.[0] === "Date";

/** A JS value as a SQL literal for field `f` (or untyped). */
function lit(v: unknown, f?: Field): string {
  if (v === null || v === undefined) return "NULL";
  if (f?.isList) {
    const arr = v as unknown[];
    const t = f.type === "String" ? "text" : f.type === "Int" ? "integer" : "text";
    return arr.length ? `ARRAY[${arr.map((x) => lit(x)).join(",")}]::${t}[]` : `'{}'::${t}[]`;
  }
  if (f?.type === "Json") return `${str(JSON.stringify(v))}::jsonb`;
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) throw new Error("pg-prisma: invalid Date");
    return isDateField(f) ? `${str(v.toISOString().slice(0, 10))}::date` : `${str(v.toISOString())}::timestamp(3)`;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`pg-prisma: non-finite number ${v}`);
    return String(v);
  }
  if (typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (isDecimalLike(v)) return String(v);
  if (typeof v === "string") {
    if (f?.type === "DateTime") return isDateField(f) ? `${str(v.slice(0, 10))}::date` : `${str(v)}::timestamp(3)`;
    return str(v);
  }
  return `${str(JSON.stringify(v))}::jsonb`;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function isOpObject(c: unknown): c is Row {
  return !!c && typeof c === "object" && !(c instanceof Date) && !Array.isArray(c) && !isDecimalLike(c) && Object.keys(c).some((k) => OPS.has(k));
}

function whereSql(m: Model, where: Row | undefined): string {
  if (!where) return "TRUE";
  const parts: string[] = [];
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === "AND") {
      const list = (Array.isArray(cond) ? cond : [cond]) as Row[];
      parts.push(list.length ? `(${list.map((w) => whereSql(m, w)).join(" AND ")})` : "TRUE");
      continue;
    }
    if (k === "OR") {
      const list = cond as Row[];
      parts.push(list.length ? `(${list.map((w) => whereSql(m, w)).join(" OR ")})` : "FALSE");
      continue;
    }
    if (k === "NOT") {
      const list = (Array.isArray(cond) ? cond : [cond]) as Row[];
      parts.push(`NOT (${list.map((w) => whereSql(m, w)).join(" AND ")})`);
      continue;
    }
    const f = m.byName.get(k);
    if (!f) {
      // Compound unique selector: { shop_day: { shop, day } }.
      if (cond && typeof cond === "object" && !Array.isArray(cond)) {
        parts.push(whereSql(m, cond as Row));
        continue;
      }
      throw new Error(`pg-prisma: unknown field ${m.name}.${k}`);
    }
    parts.push(fieldCond(f, cond));
  }
  return parts.length ? parts.join(" AND ") : "TRUE";
}

function fieldCond(f: Field, cond: unknown): string {
  const col = q(f.name);
  if (cond === null) return `${col} IS NULL`;
  if (!isOpObject(cond)) return f.isList ? `${col} = ${lit(cond, f)}` : `${col} = ${lit(cond, f)}`;
  const c = cond as Row;
  const insensitive = c.mode === "insensitive";
  const like = insensitive ? "ILIKE" : "LIKE";
  const out: string[] = [];
  for (const [op, arg] of Object.entries(c)) {
    if (arg === undefined || op === "mode") continue;
    const scalar: Field = { ...f, isList: false };
    switch (op) {
      case "equals":
        out.push(arg === null ? `${col} IS NULL` : `${col} = ${lit(arg, f)}`);
        break;
      case "in": {
        const list = arg as unknown[];
        out.push(list.length ? `${col} IN (${list.map((x) => lit(x, scalar)).join(",")})` : "FALSE");
        break;
      }
      case "notIn": {
        const list = arg as unknown[];
        out.push(list.length ? `${col} NOT IN (${list.map((x) => lit(x, scalar)).join(",")})` : "TRUE");
        break;
      }
      case "lt":
        out.push(`${col} < ${lit(arg, f)}`);
        break;
      case "lte":
        out.push(`${col} <= ${lit(arg, f)}`);
        break;
      case "gt":
        out.push(`${col} > ${lit(arg, f)}`);
        break;
      case "gte":
        out.push(`${col} >= ${lit(arg, f)}`);
        break;
      case "not":
        if (arg === null) out.push(`${col} IS NOT NULL`);
        else if (isOpObject(arg)) out.push(`NOT (${fieldCond(f, arg)})`);
        else out.push(`${col} <> ${lit(arg, f)}`);
        break;
      case "contains":
        out.push(`${col} ${like} ${str(`%${likeEscape(String(arg))}%`)}`);
        break;
      case "startsWith":
        out.push(`${col} ${like} ${str(`${likeEscape(String(arg))}%`)}`);
        break;
      case "endsWith":
        out.push(`${col} ${like} ${str(`%${likeEscape(String(arg))}`)}`);
        break;
      case "has":
        out.push(`${lit(arg, scalar)} = ANY(${col})`);
        break;
      default:
        throw new Error(`pg-prisma: unsupported operator ${op}`);
    }
  }
  return out.length ? out.join(" AND ") : "TRUE";
}

function orderSql(m: Model, orderBy: unknown): string {
  if (!orderBy) return "";
  const list = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
  const parts: string[] = [];
  for (const o of list) {
    for (const [k, dir] of Object.entries(o)) {
      if (!m.byName.has(k)) throw new Error(`pg-prisma: orderBy ${m.name}.${k} not supported`);
      parts.push(`${q(k)} ${String(dir).toLowerCase() === "desc" ? "DESC" : "ASC"}`);
    }
  }
  return parts.length ? ` ORDER BY ${parts.join(", ")}` : "";
}

/** jsonb value of a column → what Prisma returns. */
function fromJson(f: Field | undefined, v: unknown): unknown {
  if (v === null || v === undefined || !f) return v ?? null;
  if (f.isList) return v;
  switch (f.type) {
    case "DateTime": {
      const s = String(v);
      return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
    }
    case "Decimal":
      return new Prisma.Decimal(v as number | string);
    case "BigInt":
      return BigInt(v as number);
    default:
      return v;
  }
}

function toRow(m: Model, raw: Row, select?: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(raw)) {
    if (select && !select[k]) continue;
    out[k] = fromJson(m.byName.get(k), v);
  }
  return out;
}

function cols(m: Model, select?: Record<string, unknown>): string {
  if (!select) return "*";
  const names = Object.entries(select)
    .filter(([, on]) => on)
    .map(([k]) => k);
  for (const k of names) if (!m.byName.has(k)) throw new Error(`pg-prisma: select ${m.name}.${k} not supported`);
  return names.map(q).join(", ") || "1 AS _";
}

const cuid = () => `c${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;

/** Client-side defaults Prisma fills in: cuid ids and @updatedAt. */
function withDefaults(m: Model, data: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) out[k] = v;
  for (const f of m.fields) {
    const d = f.default as { name?: string } | undefined;
    if (out[f.name] === undefined && f.hasDefaultValue && d && (d.name === "cuid" || d.name === "uuid")) out[f.name] = cuid();
    if (out[f.name] === undefined && f.isUpdatedAt) out[f.name] = new Date();
  }
  return out;
}

function setSql(m: Model, data: Row, touch = true): string {
  const parts: string[] = [];
  let updated = false;
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    const f = m.byName.get(k);
    if (!f) throw new Error(`pg-prisma: unknown field ${m.name}.${k}`);
    if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) && !isDecimalLike(v) && f.type !== "Json") {
      const op = v as Row;
      if ("increment" in op) parts.push(`${q(k)} = ${q(k)} + ${lit(op.increment, f)}`);
      else if ("decrement" in op) parts.push(`${q(k)} = ${q(k)} - ${lit(op.decrement, f)}`);
      else if ("set" in op) parts.push(`${q(k)} = ${lit(op.set, f)}`);
      else throw new Error(`pg-prisma: unsupported update op on ${m.name}.${k}`);
    } else parts.push(`${q(k)} = ${lit(v, f)}`);
    if (f.isUpdatedAt) updated = true;
  }
  if (touch && !updated) for (const f of m.fields) if (f.isUpdatedAt) parts.push(`${q(f.name)} = ${lit(new Date(), f)}`);
  return parts.join(", ");
}

/** Flattened column names of a unique where (for ON CONFLICT). */
function uniqueCols(m: Model, where: Row): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(where)) {
    if (m.byName.has(k)) out.push(k);
    else if (v && typeof v === "object") out.push(...Object.keys(v as Row));
  }
  return out;
}

const AGG_SQL: Record<string, string> = { _sum: "SUM", _min: "MIN", _max: "MAX", _avg: "AVG" };

/** Aggregate columns (`"_sum__sold"` …) and how to read them back. */
function aggCols(m: Model, args: Row): { sql: string[]; read: (raw: Row) => Row } {
  const sql: string[] = [];
  const readers: ((raw: Row, out: Row) => void)[] = [];
  for (const [agg, fn] of Object.entries(AGG_SQL)) {
    const fields = args[agg] as Record<string, unknown> | undefined;
    if (!fields) continue;
    for (const [k, on] of Object.entries(fields)) {
      if (!on) continue;
      const f = m.byName.get(k);
      if (!f) throw new Error(`pg-prisma: ${agg} ${m.name}.${k}`);
      const alias = `${agg}__${k}`;
      sql.push(`${fn}(${q(k)}) AS ${q(alias)}`);
      readers.push((raw, out) => {
        const bucket = (out[agg] ??= {}) as Row;
        const v = raw[alias];
        // SUM of an Int column is a bigint in SQL; Prisma returns a number.
        bucket[k] = v === null || v === undefined ? null : agg === "_sum" && (f.type === "Int" || f.type === "Float") ? Number(v) : fromJson(f, v);
      });
    }
  }
  const count = args._count as Record<string, unknown> | boolean | undefined;
  if (count === true) {
    sql.push(`COUNT(*) AS "_count"`);
    readers.push((raw, out) => (out._count = Number(raw._count)));
  } else if (count && typeof count === "object") {
    for (const [k, on] of Object.entries(count)) {
      if (!on) continue;
      const alias = `_count__${k}`;
      sql.push(k === "_all" ? `COUNT(*) AS ${q(alias)}` : `COUNT(${q(k)}) AS ${q(alias)}`);
      readers.push((raw, out) => (((out._count ??= {}) as Row)[k] = Number(raw[alias])));
    }
  }
  return {
    sql,
    read: (raw) => {
      const out: Row = {};
      for (const r of readers) r(raw, out);
      return out;
    },
  };
}

// ── Running SQL ──────────────────────────────────────────────────────────────────────────────

class PgError extends Error {}

function prismaError(message: string): Error {
  if (/duplicate key value violates unique constraint/.test(message)) {
    return new Prisma.PrismaClientKnownRequestError(message, { code: "P2002", clientVersion: Prisma.prismaVersion.client });
  }
  return new PgError(message);
}

export type PsqlRunner = (sql: string, opts: { transaction: boolean }) => Promise<string[]>;

/** Runs a script through psql; one output line per statement. */
export function psqlRunner(db: string): PsqlRunner {
  return (sql, { transaction }) =>
    new Promise((resolve, reject) => {
      const args = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...(transaction ? ["-1"] : []), `${PG_CONN} dbname=${db}`, "-f", "-"];
      const p = spawn("psql", args, { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      p.stdout.on("data", (b: Buffer) => out.push(b));
      p.stderr.on("data", (b: Buffer) => err.push(b));
      p.on("error", reject);
      p.on("close", (code) => {
        const stderr = Buffer.concat(err).toString("utf8");
        if (code !== 0) return reject(prismaError(stderr || `psql exited with ${code}`));
        const text = Buffer.concat(out).toString("utf8");
        resolve(text.split("\n").filter((l) => l.length > 0));
      });
      p.stdin.end(sql);
    });
}

/**
 * One long-lived psql session (spawning psql per statement costs more than most statements):
 * batches are written to its stdin one at a time, each followed by a stdout and a stderr marker;
 * the batch's output is the lines before the stdout marker, and any "ERROR:" before the stderr
 * marker fails it (a failed transaction batch is rolled back by its COMMIT).
 */
export function psqlSession(db: string): PsqlRunner & { close: () => Promise<void> } {
  let proc: ReturnType<typeof spawn> | null = null;
  let out = "";
  let err = "";
  let seq = 0;
  let waiter: (() => void) | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const start = () => {
    const p = spawn("psql", ["-X", "-q", "-A", "-t", `${PG_CONN} dbname=${db}`], { stdio: ["pipe", "pipe", "pipe"] });
    p.stdout!.on("data", (b: Buffer) => {
      out += b.toString("utf8");
      waiter?.();
    });
    p.stderr!.on("data", (b: Buffer) => {
      err += b.toString("utf8");
      waiter?.();
    });
    p.on("close", () => {
      proc = null;
      waiter?.();
    });
    proc = p;
    return p;
  };
  const runOne = (sql: string, transaction: boolean): Promise<string[]> =>
    new Promise((resolve, reject) => {
      const p = proc ?? start();
      const n = ++seq;
      const mark = `__KEHA_END_${n}__`;
      out = "";
      err = "";
      waiter = () => {
        if (!proc) {
          waiter = null;
          return reject(new PgError(`psql session ended: ${err}`));
        }
        const o = out.indexOf(`${mark}\n`);
        const e = err.indexOf(`${mark}\n`);
        if (o < 0 || e < 0) return;
        waiter = null;
        const lines = out.slice(0, o).split("\n").filter((l) => l.length > 0);
        const errors = err.slice(0, e);
        if (/ERROR:/.test(errors)) return reject(prismaError(errors));
        resolve(lines);
      };
      p.stdin!.write(`${transaction ? "BEGIN;\n" : ""}${sql}${transaction ? "COMMIT;\n" : ""}\\echo ${mark}\n\\warn ${mark}\n`);
    });
  const runner = ((sql: string, { transaction }: { transaction: boolean }) => {
    const next = queue.then(() => runOne(sql, transaction));
    queue = next.catch(() => null);
    return next;
  }) as PsqlRunner & { close: () => Promise<void> };
  runner.close = () =>
    new Promise<void>((resolve) => {
      const p = proc;
      if (!p) return resolve();
      p.on("close", () => resolve());
      p.stdin?.end();
    });
  return runner;
}

type Stmt = { sql: string; parse: (line: string) => unknown };

/** A lazy operation (PrismaPromise-like): runs when awaited, or as part of a $transaction batch. */
class Lazy<T> implements PromiseLike<T> {
  private started: Promise<T> | null = null;
  constructor(
    readonly stmt: Stmt,
    private readonly run: PsqlRunner,
  ) {}
  private exec(): Promise<T> {
    this.started ??= this.run(this.stmt.sql + ";\n", { transaction: false }).then((lines) => this.stmt.parse(lines[0] ?? "null") as T);
    return this.started;
  }
  then<A = T, B = never>(ok?: ((v: T) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.exec().then(ok, fail);
  }
  catch<B = never>(fail?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.exec().catch(fail);
  }
  finally(fn?: (() => void) | null): Promise<T> {
    return this.exec().finally(fn);
  }
}

const parseJson = (line: string) => JSON.parse(line) as unknown;

function delegate(m: Model, run: PsqlRunner) {
  const T = q(m.name);
  const lazy = <R>(sql: string, parse: (line: string) => R) => new Lazy<R>({ sql, parse }, run);
  const rowsOf = (line: string) => (parseJson(line) as Row[] | null) ?? [];
  const select = (args: Row, limit?: number) => {
    const distinct = args.distinct as string[] | undefined;
    const take = limit ?? (args.take as number | undefined);
    const skip = args.skip as number | undefined;
    const inner = `SELECT ${distinct ? "*" : cols(m, args.select as Row | undefined)} FROM ${T} WHERE ${whereSql(m, args.where as Row)}${orderSql(m, args.orderBy)}${distinct ? "" : `${take !== undefined ? ` LIMIT ${Number(take)}` : ""}${skip ? ` OFFSET ${Number(skip)}` : ""}`}`;
    return `SELECT coalesce(jsonb_agg(t), '[]'::jsonb) FROM (${inner}) t`;
  };
  const shape = (args: Row) => (line: string) => {
    let list = rowsOf(line);
    const distinct = args.distinct as string[] | undefined;
    if (distinct) {
      const seen = new Set<string>();
      list = list.filter((r) => {
        const k = JSON.stringify(distinct.map((d) => r[d]));
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (args.skip) list = list.slice(Number(args.skip));
      if (args.take !== undefined) list = list.slice(0, Number(args.take));
    }
    return list.map((r) => toRow(m, r, args.select as Row | undefined));
  };
  const insert = (rows: Row[], conflict = "") => {
    const filled = rows.map((r) => withDefaults(m, r));
    const names = [...new Set(filled.flatMap((r) => Object.keys(r)))];
    for (const k of names) if (!m.byName.has(k)) throw new Error(`pg-prisma: unknown field ${m.name}.${k}`);
    const values = filled.map((r) => `(${names.map((k) => (k in r ? lit(r[k], m.byName.get(k)) : "DEFAULT")).join(", ")})`).join(",\n");
    return `INSERT INTO ${T} (${names.map(q).join(", ")}) VALUES ${values}${conflict}`;
  };
  return {
    findMany: (args: Row = {}) => lazy(select(args), shape(args)),
    findFirst: (args: Row = {}) => lazy(select({ ...args, distinct: undefined }, 1), (l) => shape({ ...args, distinct: undefined })(l)[0] ?? null),
    findUnique: (args: Row) => lazy(select(args, 1), (l) => shape(args)(l)[0] ?? null),
    count: (args: Row = {}) => lazy(`SELECT to_jsonb(COUNT(*)) FROM ${T} WHERE ${whereSql(m, args.where as Row)}`, (l) => Number(parseJson(l))),
    aggregate: (args: Row) => {
      const a = aggCols(m, args);
      return lazy(`SELECT to_jsonb(t) FROM (SELECT ${a.sql.join(", ") || "1 AS _"} FROM ${T} WHERE ${whereSql(m, args.where as Row)}) t`, (l) => a.read(parseJson(l) as Row));
    },
    groupBy: (args: Row) => {
      const by = args.by as string[];
      const a = aggCols(m, args);
      const inner = `SELECT ${[...by.map(q), ...a.sql].join(", ")} FROM ${T} WHERE ${whereSql(m, args.where as Row)} GROUP BY ${by.map(q).join(", ")}${orderSql(m, args.orderBy)}${args.take !== undefined ? ` LIMIT ${Number(args.take)}` : ""}${args.skip ? ` OFFSET ${Number(args.skip)}` : ""}`;
      return lazy(`SELECT coalesce(jsonb_agg(t), '[]'::jsonb) FROM (${inner}) t`, (l) =>
        rowsOf(l).map((raw) => {
          const out: Row = {};
          for (const b of by) out[b] = fromJson(m.byName.get(b), raw[b]);
          return Object.assign(out, a.read(raw));
        }),
      );
    },
    create: (args: { data: Row; select?: Row }) => lazy(`WITH x AS (${insert([args.data])} RETURNING *) SELECT to_jsonb(x) FROM x`, (l) => toRow(m, parseJson(l) as Row, args.select)),
    createMany: (args: { data: Row[]; skipDuplicates?: boolean }) =>
      args.data.length
        ? lazy(`WITH x AS (${insert(args.data, args.skipDuplicates ? " ON CONFLICT DO NOTHING" : "")} RETURNING 1) SELECT jsonb_build_object('count', COUNT(*)) FROM x`, (l) => parseJson(l) as { count: number })
        : lazy(`SELECT jsonb_build_object('count', 0)`, (l) => parseJson(l) as { count: number }),
    upsert: (args: { where: Row; create: Row; update: Row; select?: Row }) => {
      const conflict = uniqueCols(m, args.where);
      const set = setSql(m, args.update);
      const sql = `WITH x AS (${insert([args.create], ` ON CONFLICT (${conflict.map(q).join(", ")}) DO ${set ? `UPDATE SET ${set}` : "NOTHING"}`)} RETURNING *) SELECT coalesce((SELECT to_jsonb(x) FROM x), 'null'::jsonb)`;
      return lazy(sql, (l) => {
        const r = parseJson(l) as Row | null;
        return r ? toRow(m, r, args.select) : null;
      });
    },
    update: (args: { where: Row; data: Row; select?: Row }) =>
      lazy(`WITH x AS (UPDATE ${T} SET ${setSql(m, args.data)} WHERE ${whereSql(m, args.where)} RETURNING *) SELECT coalesce((SELECT to_jsonb(x) FROM x LIMIT 1), 'null'::jsonb)`, (l) => {
        const r = parseJson(l) as Row | null;
        if (!r) throw new Prisma.PrismaClientKnownRequestError(`Record to update not found (${m.name})`, { code: "P2025", clientVersion: Prisma.prismaVersion.client });
        return toRow(m, r, args.select);
      }),
    updateMany: (args: { where?: Row; data: Row }) =>
      lazy(`WITH x AS (UPDATE ${T} SET ${setSql(m, args.data)} WHERE ${whereSql(m, args.where)} RETURNING 1) SELECT jsonb_build_object('count', COUNT(*)) FROM x`, (l) => parseJson(l) as { count: number }),
    delete: (args: { where: Row }) =>
      lazy(`WITH x AS (DELETE FROM ${T} WHERE ${whereSql(m, args.where)} RETURNING *) SELECT coalesce((SELECT to_jsonb(x) FROM x LIMIT 1), 'null'::jsonb)`, (l) => {
        const r = parseJson(l) as Row | null;
        if (!r) throw new Prisma.PrismaClientKnownRequestError(`Record to delete does not exist (${m.name})`, { code: "P2025", clientVersion: Prisma.prismaVersion.client });
        return toRow(m, r);
      }),
    deleteMany: (args: { where?: Row } = {}) =>
      lazy(`WITH x AS (DELETE FROM ${T} WHERE ${whereSql(m, args.where)} RETURNING 1) SELECT jsonb_build_object('count', COUNT(*)) FROM x`, (l) => parseJson(l) as { count: number }),
  };
}

/** `$1`… placeholders → literals (raw queries). */
function bindRaw(sql: string, params: readonly unknown[]): string {
  return sql.replace(/\$(\d+)/g, (m, n: string) => {
    const i = Number(n) - 1;
    return i >= 0 && i < params.length ? lit(params[i]) : m;
  });
}

export type PgPrisma = Record<string, unknown> & { $statements: () => number; $close: () => Promise<void> };

/** A Prisma-like client over database `db`. */
export function createPgPrisma(db: string): PgPrisma {
  const base = psqlSession(db);
  let statements = 0;
  const run: PsqlRunner = (sql, opts) => {
    statements++;
    return base(sql, opts);
  };
  const delegates = new Map<string, ReturnType<typeof delegate>>();
  const raw = (sql: string, params: unknown[]) =>
    new Lazy<Row[]>({ sql: `SELECT coalesce(jsonb_agg(t), '[]'::jsonb) FROM (${bindRaw(sql.trim().replace(/;$/, ""), params)}) t`, parse: (l) => (parseJson(l) as Row[]) ?? [] }, run);
  const client: Record<string, unknown> = {
    $statements: () => statements,
    $close: () => base.close(),
    $queryRawUnsafe: (sql: string, ...params: unknown[]) => raw(sql, params),
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => raw(strings.reduce((a, s, i) => a + s + (i < values.length ? `$${i + 1}` : ""), ""), values),
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      await run(`${bindRaw(sql, params)};\nSELECT 'null'::jsonb;\n`, { transaction: false });
      return 0;
    },
    $transaction: async (arg: unknown) => {
      if (typeof arg === "function") return (arg as (tx: unknown) => unknown)(proxy);
      const list = arg as Lazy<unknown>[];
      if (!list.length) return [];
      const lines = await run(list.map((l) => l.stmt.sql + ";\n").join(""), { transaction: true });
      return list.map((l, i) => l.stmt.parse(lines[i] ?? "null"));
    },
    $disconnect: async () => {},
    $connect: async () => {},
  };
  const proxy: PgPrisma = new Proxy(client, {
    get: (target, name: string) => {
      if (name in target) return target[name];
      if (name === "then" || typeof name === "symbol") return undefined;
      const m = MODELS.get(name);
      if (!m) throw new Error(`pg-prisma: no model ${name}`);
      if (!delegates.has(name)) delegates.set(name, delegate(m, run));
      return delegates.get(name);
    },
  }) as PgPrisma;
  return proxy;
}
