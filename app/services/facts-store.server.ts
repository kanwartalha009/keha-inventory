/**
 * The daily facts — sales, stock, store visits — behind one interface (DB scale "before 1,000
 * stores"). The app reads them as it always did, in its own ids and with Prisma-shaped
 * arguments:
 *
 *   facts.salesDaily.groupBy({ by: ["variantId", "day"], where: { shop, locationKey: ALL, … }, _sum: { sold: true } })
 *
 * and the store answers from the compact, monthly-partitioned tables (prisma/schema.prisma
 * SalesFact / StockMonth / SessionsFact) through lib/facts-sql-shared, converting at this
 * boundary (lib/ids-shared): shop domain ⇄ Shop.num, variant GID ⇄ its number, location keys /
 * channels / traffic types ⇄ FactKey numbers. Results look exactly like the old rows (GIDs, keys,
 * Date days, numbers; gross in currency units).
 *
 * Writes: replaceSales / replaceStock / replaceSessions put one shop's facts for a day range in
 * place (idempotent: rows no longer there are deleted, changed rows updated, unchanged rows left
 * alone), creating the month partitions they need; rows older than retention are not written.
 * purgeShop deletes a shop's rows partition by partition in batches. Retention itself is the
 * partition-maintenance job (services/partitions.server): applyRetention only reports the first
 * day each dataset still holds.
 *
 * `factsStore()` is the app's store (Postgres through Prisma); tests swap it with setFactsStore —
 * the in-memory Prisma of the unit tests (tests/helpers/fake-facts) or psql (Postgres tests).
 */
import { prismaRunner, type SqlRunner } from "./db/sql.server";
import { compileWhere, evaluate, evaluateStockMonths, type Row, type StockMonthRow } from "../lib/facts-eval-shared";
import {
  buildRead,
  buildStockFetch,
  buildStockLatestInMonth,
  keyColumns,
  keyFields,
  PURGE_BATCH,
  purgeBatchSql,
  purgeProbeSql,
  salesReplace,
  sessionsReplace,
  stockReplace,
  stockShortcut,
  whereKeys,
  whereShop,
  type BuiltRead,
  type EncodedSales,
  type EncodedSessions,
  type EncodedStock,
  type FactTableName,
  type ReadOp,
  type Statement,
} from "../lib/facts-sql-shared";
import { FIXED_KEYS, addMonths, amountToCents, centsToAmount, dayAsDate, monthOf, monthSegments, monthsBetween, toNumber, variantGid, variantNum } from "../lib/ids-shared";
import { FACT_TABLES, keepFrom, partitionName, type FactTable } from "../lib/partitions-shared";
import { ensurePartitions, listPartitions } from "./partitions.server";
import type { SalesFact, SessionsFact, StockFact } from "../lib/sync/facts-shared";
import type { DayRange } from "../lib/sync/shopifyql-shared";

// ---------------------------------------------------------------------------
// The rows the app sees, and Prisma-shaped argument / result types
// ---------------------------------------------------------------------------

export type SalesDailyRow = { shop: string; day: Date; variantId: string; locationKey: string; channel: string; sold: number; returned: number; gross: number };
export type StockDailyRow = { shop: string; day: Date; variantId: string; locationId: string; endUnits: number; outOfStock: boolean };
export type SessionsDailyRow = { shop: string; day: Date; landingPath: string; trafficType: string; sessions: number; checkouts: number };

type Filter<T> =
  | T
  | {
      equals?: T;
      in?: readonly T[];
      notIn?: readonly T[];
      lt?: T;
      lte?: T;
      gt?: T;
      gte?: T;
      not?: T | null | Filter<T>;
      contains?: string;
      startsWith?: string;
      mode?: "insensitive" | "default";
    };
export type FactWhere<R> = { [K in keyof R]?: Filter<R[K]> } & {
  AND?: FactWhere<R> | readonly FactWhere<R>[];
  OR?: readonly FactWhere<R>[];
  NOT?: FactWhere<R> | readonly FactWhere<R>[];
};
type Flags<K extends PropertyKey> = { readonly [P in K]?: boolean };
type NumericKeys<R> = { [K in keyof R]-?: R[K] extends number ? K : never }[keyof R];
type Dir = "asc" | "desc";

export type FactGroupByArgs<R> = {
  by: readonly (keyof R)[];
  where?: FactWhere<R>;
  _sum?: Flags<NumericKeys<R>>;
  _min?: Flags<keyof R>;
  _max?: Flags<keyof R>;
  _count?: Flags<keyof R | "_all">;
  orderBy?: { readonly [P in keyof R]?: Dir } | readonly { readonly [P in keyof R]?: Dir }[];
  take?: number;
};
export type FactFindArgs<R> = {
  where?: FactWhere<R>;
  select?: Flags<keyof R>;
  orderBy?: { readonly [P in keyof R]?: Dir } | readonly { readonly [P in keyof R]?: Dir }[];
  take?: number;
};
export type FactAggregateArgs<R> = { where?: FactWhere<R>; _sum?: Flags<NumericKeys<R>>; _min?: Flags<keyof R>; _max?: Flags<keyof R>; _count?: Flags<keyof R | "_all"> };

type Selected<R, S> = S extends Flags<keyof R> ? { [K in keyof S & keyof R as S[K] extends true ? K : never]: R[K] } : R;
type AggOut<R, A> = (A extends { _sum: infer S } ? { _sum: { [F in keyof S]: number | null } } : unknown) &
  (A extends { _min: infer S } ? { _min: { [F in keyof S & keyof R]: R[F] | null } } : unknown) &
  (A extends { _max: infer S } ? { _max: { [F in keyof S & keyof R]: R[F] | null } } : unknown) &
  (A extends { _count: infer S } ? { _count: { [F in keyof S]: number } } : unknown);

export interface FactReader<R> {
  groupBy<const A extends FactGroupByArgs<R>>(args: A): Promise<(Pick<R, A["by"][number]> & AggOut<R, A>)[]>;
  findMany<const A extends FactFindArgs<R>>(args: A): Promise<Selected<R, A["select"]>[]>;
  findFirst<const A extends FactFindArgs<R>>(args: A): Promise<Selected<R, A["select"]> | null>;
  aggregate<const A extends FactAggregateArgs<R>>(args: A): Promise<AggOut<R, A>>;
  count(args: { where?: FactWhere<R> }): Promise<number>;
}

export type RetentionResult = {
  /** Rows deleted now (0 for the partitioned store: whole months go in the maintenance job). */
  removed: number;
  /** The first day each dataset still holds (stored first days older than it are moved up). */
  from: { stock: string; sales: string };
};

export interface FactsStore {
  salesDaily: FactReader<SalesDailyRow>;
  stockDaily: FactReader<StockDailyRow>;
  sessionsDaily: FactReader<SessionsDailyRow>;
  /** The shop's sales in [since, until] become `rows` (lib/sync/facts-shared SalesFact). */
  replaceSales(shop: string, range: DayRange, rows: readonly SalesFact[]): Promise<void>;
  replaceStock(shop: string, range: DayRange, rows: readonly StockFact[]): Promise<void>;
  replaceSessions(shop: string, range: DayRange, rows: readonly SessionsFact[]): Promise<void>;
  applyRetention(shop: string, today: string): Promise<RetentionResult>;
  /** Every fact row of the shop; returns how many. */
  purgeShop(shop: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------

export class UnknownShopError extends Error {
  constructor(shop: string) {
    super(`facts: no Shop row for ${shop} (the shop's number keys its facts)`);
    this.name = "UnknownShopError";
  }
}

export type PgFactsOptions = { now?: () => number };

/** How long a stock fetch is shared, and how many are kept (each up to a few MB). */
const SHARE_MS = 3000;
const SHARE_MAX = 4;
/** How long a read trusts a cached Shop.num (writes and purges always read it). */
const SHOP_NUM_TTL_MS = 60_000;

const utcToday = (now: () => number) => new Date(now()).toISOString().slice(0, 10);

/** The Postgres store over any SqlRunner (Prisma in the app, psql in the tests). */
export function pgFactsStore(runner: SqlRunner, opts: PgFactsOptions = {}): FactsStore & { forget(): void } {
  const now = opts.now ?? Date.now;
  // Shop.num per domain. A number changes when its Shop row is deleted and created again (a purge
  // then a reinstall, or sample data removed and loaded again — `<shop>#sample`), possibly by
  // another process: reads trust a cached number for SHOP_NUM_TTL_MS, writes always read it fresh.
  const shopNums = new Map<string, { n: number; at: number }>();
  const keyToNum = new Map<string, number>(FIXED_KEYS);
  const numToKey = new Map<number, string>([...FIXED_KEYS].map(([k, n]) => [n, k]));

  async function shopNum(shop: string, fresh = false): Promise<number | null> {
    const hit = shopNums.get(shop);
    if (!fresh && hit !== undefined && Date.now() - hit.at < SHOP_NUM_TTL_MS) return hit.n;
    const rows = await runner.query(`SELECT "num" FROM "Shop" WHERE "domain" = $1::text`, [shop]);
    if (!rows.length || rows[0]!.num === null || rows[0]!.num === undefined) {
      shopNums.delete(shop);
      return null;
    }
    const n = Number(toNumber(rows[0]!.num));
    shopNums.set(shop, { n, at: Date.now() });
    return n;
  }

  const remember = (rows: Record<string, unknown>[]) => {
    for (const r of rows) {
      const n = Number(toNumber(r.num));
      const k = String(r.key);
      keyToNum.set(k, n);
      numToKey.set(n, k);
    }
  };

  /** Loads the numbers of keys not known yet (unknown ones stay unknown: no row has them). */
  async function loadKeys(keys: readonly string[]): Promise<void> {
    const missing = [...new Set(keys)].filter((k) => !keyToNum.has(k));
    if (!missing.length) return;
    remember(await runner.query(`SELECT "num", "key" FROM "FactKey" WHERE "key" = ANY($1::text[])`, [missing]));
  }

  /** Numbers for keys a write needs, adding the new ones to the dictionary. */
  async function ensureKeys(keys: readonly string[]): Promise<void> {
    await loadKeys(keys);
    const missing = [...new Set(keys)].filter((k) => !keyToNum.has(k));
    if (!missing.length) return;
    remember(
      await runner.query(
        `INSERT INTO "FactKey" ("key") SELECT k FROM unnest($1::text[]) AS k ORDER BY k ON CONFLICT ("key") DO NOTHING RETURNING "num", "key"`,
        [missing],
      ),
    );
    await loadKeys(missing); // added by another process meanwhile
    const still = missing.filter((k) => !keyToNum.has(k));
    if (still.length) throw new Error(`facts: could not number keys ${still.slice(0, 3).join(", ")}`);
  }

  async function loadNums(nums: readonly number[]): Promise<void> {
    const missing = [...new Set(nums)].filter((n) => !numToKey.has(n));
    if (!missing.length) return;
    remember(await runner.query(`SELECT "num", "key" FROM "FactKey" WHERE "num" = ANY($1::text[]::int4[])`, [missing.map(String)]));
    const still = missing.filter((n) => !numToKey.has(n));
    if (still.length) throw new Error(`facts: unknown key numbers ${still.slice(0, 3).join(", ")}`);
  }

  function decode(b: BuiltRead, shop: string, row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const c of b.columns) {
      const raw = row[c.alias];
      let v: unknown;
      if (raw === null || raw === undefined) v = c.kind === "count" ? 0 : null;
      else
        switch (c.kind) {
          case "shop":
            v = shop;
            break;
          case "variant":
            v = variantGid(raw);
            break;
          case "key":
            v = numToKey.get(Number(toNumber(raw)));
            break;
          case "day":
            v = dayAsDate(raw);
            break;
          case "bool":
            v = raw === true || raw === "t" || raw === "true";
            break;
          case "text":
            v = String(raw);
            break;
          case "cents":
            v = centsToAmount(raw);
            break;
          default:
            v = toNumber(raw);
        }
      if (!c.path.length) return { value: v };
      let o = out;
      for (let i = 0; i < c.path.length - 1; i++) o = (o[c.path[i]!] ??= {}) as Record<string, unknown>;
      o[c.path[c.path.length - 1]!] = v;
    }
    return out;
  }

  /**
   * Identical stock fetches in flight or finished in the last SHARE_MS share one read: compute
   * asks for a chunk's pooled stock and its out-of-stock days at once — the same month rows.
   */
  const recent = new Map<string, { at: number; rows: Promise<Record<string, unknown>[]> }>();
  function fetchShared(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    const key = `${sql}\u0000${JSON.stringify(params)}`;
    const t = now();
    for (const [k, v] of recent) if (t - v.at > SHARE_MS) recent.delete(k);
    const hit = recent.get(key);
    if (hit) return hit.rows;
    const rows = runner.query(sql, params);
    recent.set(key, { at: t, rows });
    rows.catch(() => recent.delete(key));
    while (recent.size > SHARE_MAX) recent.delete(recent.keys().next().value!);
    return rows;
  }

  /** int4[] from either driver: a number array (Prisma) or its text form (psql). */
  const intArray = (v: unknown): (number | null)[] => {
    if (Array.isArray(v)) return v.map((x) => (x === null || x === undefined ? null : Number(x)));
    if (typeof v === "string") {
      const body = v.replace(/^\{|\}$/g, "");
      return body ? body.split(",").map((x) => (x === "NULL" ? null : Number(x))) : [];
    }
    return [];
  };
  const monthKey = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 7) : String(v).slice(0, 7));

  /**
   * A stock read evaluated in memory (lib/facts-eval-shared): the candidate month rows are fetched
   * (index work only) and their days expanded here — Postgres no longer unnests and sorts millions
   * of array elements per query. Reads of the first / last day keep their SQL shortcut, and the
   * latest stock day over locations probes the newest month first.
   */
  async function readStock(op: ReadOp, shop: string, num: number): Promise<Record<string, unknown>[] | Record<string, unknown>> {
    const resolved = { shopNum: num, keyNum: (k: string) => keyToNum.get(k) };
    const o = op.op === "findMany" ? Object.entries(op.orderBy ?? {}) : [];
    if (op.op === "findMany" && stockShortcut(op) && op.where?.variantId === undefined && o.length === 1 && o[0]![1] === "desc") {
      const from = monthOf(keepFrom("StockMonth", utcToday(now)));
      for (let m = monthOf(utcToday(now)); m >= from; m = addMonths(m, -1)) {
        const b = buildStockLatestInMonth(op.where, m, resolved);
        const row = (await runner.query(b.sql, b.params))[0];
        if (row && row.f_day !== null && row.f_day !== undefined) return [{ day: dayAsDate(row.f_day) }];
      }
      return [];
    }
    const f = buildStockFetch(op.where, resolved);
    const rows = await fetchShared(f.sql, f.params);
    await loadNums(rows.map((r) => Number(toNumber(r.locNum))));
    const months: StockMonthRow[] = rows.map((r) => ({
      variantId: variantGid(r.variantNum),
      locationId: numToKey.get(Number(toNumber(r.locNum)))!,
      month: monthKey(r.month),
      mask: Number(toNumber(r.outMask)),
      units: intArray(r.endUnits),
    }));
    const fast = evaluateStockMonths(op, shop, months);
    if (fast !== undefined) return fast as Record<string, unknown>[] | Record<string, unknown>;
    const pass = compileWhere(op.where);
    function* days(): Generator<Row> {
      for (const r of rows) {
        const variantId = variantGid(r.variantNum);
        const locationId = numToKey.get(Number(toNumber(r.locNum)))!;
        const ym = monthKey(r.month);
        const mask = Number(toNumber(r.outMask));
        const units = intArray(r.endUnits);
        for (let i = 0; i < units.length; i++) {
          const e = units[i];
          if (e === null || e === undefined) continue;
          const row: Row = { shop, day: `${ym}-${i < 9 ? "0" : ""}${i + 1}`, variantId, locationId, endUnits: e, outOfStock: ((mask >> i) & 1) === 1 };
          if (pass(row)) yield row;
        }
      }
    }
    return evaluate(op, days(), true) as Record<string, unknown>[] | Record<string, unknown>;
  }

  async function read(table: FactTableName, op: ReadOp): Promise<Record<string, unknown>[] | Record<string, unknown>> {
    const shop = whereShop(op.where);
    const num = await shopNum(shop);
    const single = op.op === "aggregate" || op.op === "count";
    if (num !== null && table === "stockDaily" && !stockShortcut(op)) {
      await loadKeys(whereKeys(table, op.where));
      const res = await readStock(op, shop, num);
      return op.op === "count" ? { value: res } : res;
    }
    if (num !== null && table === "stockDaily" && op.op === "findMany" && op.where?.variantId === undefined && Object.values(op.orderBy ?? {})[0] === "desc") {
      await loadKeys(whereKeys(table, op.where));
      return readStock(op, shop, num);
    }
    if (num === null) {
      // No Shop row: no facts. Same shapes as an empty table.
      if (op.op === "count") return { value: 0 };
      if (op.op === "aggregate") {
        const b = buildRead(table, op, { shopNum: 0, keyNum: () => undefined });
        return decode(b, shop, {});
      }
      return [];
    }
    await loadKeys(whereKeys(table, op.where));
    const b = buildRead(table, op, { shopNum: num, keyNum: (k) => keyToNum.get(k) });
    const rows = await runner.query(b.sql, b.params);
    const kc = keyColumns(b);
    if (kc.length) await loadNums(rows.flatMap((r) => kc.map((a) => r[a]).filter((x) => x !== null && x !== undefined).map((x) => Number(toNumber(x)))));
    if (single) return decode(b, shop, rows[0] ?? {});
    return rows.map((r) => decode(b, shop, r));
  }

  function reader<R>(table: FactTableName): FactReader<R> {
    return {
      groupBy: (async (args: FactGroupByArgs<R>) => read(table, { op: "groupBy", ...(args as object) } as ReadOp)) as FactReader<R>["groupBy"],
      findMany: (async (args: FactFindArgs<R>) => read(table, { op: "findMany", ...(args as object) } as ReadOp)) as FactReader<R>["findMany"],
      findFirst: (async (args: FactFindArgs<R>) => {
        const rows = (await read(table, { op: "findMany", ...(args as object), take: 1 } as ReadOp)) as Record<string, unknown>[];
        return rows[0] ?? null;
      }) as FactReader<R>["findFirst"],
      aggregate: (async (args: FactAggregateArgs<R>) => read(table, { op: "aggregate", ...(args as object) } as ReadOp)) as FactReader<R>["aggregate"],
      count: async (args: { where?: FactWhere<R> }) => {
        const r = (await read(table, { op: "count", where: args.where as Record<string, unknown> })) as { value: unknown };
        return Number(r.value ?? 0);
      },
    };
  }

  async function requireShop(shop: string): Promise<number> {
    const n = await shopNum(shop, true);
    if (n === null) throw new UnknownShopError(shop);
    return n;
  }

  /** The part of a range still kept (null = all of it is past retention) and the months it needs. */
  async function keptRange(table: FactTable, range: DayRange): Promise<DayRange | null> {
    const today = utcToday(now);
    const from = monthOf(keepFrom(table, today));
    const since = range.since > from ? range.since : from;
    if (since > range.until) return null;
    await ensurePartitions(runner, table, monthsBetween(monthOf(since), monthOf(range.until)));
    return { since, until: range.until };
  }

  const inRange = (day: string, r: DayRange) => day >= r.since && day <= r.until;

  function encodeVariant(id: string): string {
    const n = variantNum(id);
    if (n === null) throw new Error(`facts: ${id} is not a ProductVariant GID`);
    return n;
  }

  return {
    salesDaily: reader<SalesDailyRow>("salesDaily"),
    stockDaily: reader<StockDailyRow>("stockDaily"),
    sessionsDaily: reader<SessionsDailyRow>("sessionsDaily"),

    async replaceSales(shop, range, rows) {
      const num = await requireShop(shop);
      const kept = await keptRange("SalesFact", range);
      if (!kept) return;
      const mine = rows.filter((r) => inRange(r.day, kept));
      await ensureKeys(mine.flatMap((r) => [r.locationKey, r.channel]));
      const enc: EncodedSales[] = mine.map((r) => ({
        variantNum: encodeVariant(r.variantId),
        locNum: keyToNum.get(r.locationKey)!,
        channelNum: keyToNum.get(r.channel)!,
        day: r.day,
        sold: r.sold,
        returned: r.returned,
        grossCents: amountToCents(r.gross),
      }));
      await runner.transaction(salesReplace(num, kept.since, kept.until, enc));
    },

    async replaceStock(shop, range, rows) {
      const num = await requireShop(shop);
      const kept = await keptRange("StockMonth", range);
      if (!kept) return;
      const mine = rows.filter((r) => inRange(r.day, kept));
      await ensureKeys(mine.map((r) => r.locationId));
      const enc: EncodedStock[] = mine.map((r) => ({
        variantNum: encodeVariant(r.variantId),
        locNum: keyToNum.get(r.locationId)!,
        day: r.day,
        endUnits: r.endUnits,
        outOfStock: r.outOfStock,
      }));
      recent.clear(); // no shared read may outlive a write
      const statements: Statement[] = [];
      for (const seg of monthSegments(kept.since, kept.until)) {
        statements.push(...stockReplace(num, seg.month, seg.a, seg.b, enc.filter((r) => r.day >= seg.since && r.day <= seg.until)));
      }
      await runner.transaction(statements);
    },

    async replaceSessions(shop, range, rows) {
      const num = await requireShop(shop);
      const kept = await keptRange("SessionsFact", range);
      if (!kept) return;
      const mine = rows.filter((r) => inRange(r.day, kept));
      await ensureKeys(mine.map((r) => r.trafficType));
      const enc: EncodedSessions[] = mine.map((r) => ({
        day: r.day,
        landingPath: r.landingPath,
        trafficNum: keyToNum.get(r.trafficType)!,
        sessions: r.sessions,
        checkouts: r.checkouts,
      }));
      await runner.transaction(sessionsReplace(num, kept.since, kept.until, enc));
    },

    async applyRetention(_shop, today) {
      // Whole months are dropped by the maintenance job; report what is still held.
      const first = async (table: FactTable) => (await listPartitions(runner, table))[0] ?? keepFrom(table, today);
      return { removed: 0, from: { stock: await first("StockMonth"), sales: await first("SalesFact") } };
    },

    async purgeShop(shop) {
      recent.clear();
      const num = await shopNum(shop, true);
      if (num === null) return 0;
      let total = 0;
      for (const table of FACT_TABLES) {
        // Only the partitions that hold the shop's rows (one probe each), then batches of PURGE_BATCH.
        const probe = purgeProbeSql((await listPartitions(runner, table)).map((m) => partitionName(table, m)));
        const parts = probe ? (await runner.query(probe, [String(num)])).map((r) => String(r.part)) : [];
        for (const part of parts) {
          const sql = purgeBatchSql(part);
          for (;;) {
            const n = await runner.execute(sql, [String(num)]);
            total += n;
            if (n < PURGE_BATCH) break;
          }
        }
      }
      shopNums.delete(shop);
      return total;
    },

    forget() {
      shopNums.clear();
    },
  };
}

let current: FactsStore | null = null;

/** The app's facts store (Postgres through Prisma). */
export function factsStore(): FactsStore {
  return (current ??= pgFactsStore(prismaRunner));
}

/** Tests: use another store (null = back to Postgres). */
export function setFactsStore(store: FactsStore | null): void {
  current = store;
}

/** `facts.salesDaily.groupBy(…)` etc.: the current store's readers (models and services read through this). */
export const facts = {
  get salesDaily(): FactReader<SalesDailyRow> {
    return factsStore().salesDaily;
  },
  get stockDaily(): FactReader<StockDailyRow> {
    return factsStore().stockDaily;
  },
  get sessionsDaily(): FactReader<SessionsDailyRow> {
    return factsStore().sessionsDaily;
  },
};

/** The dictionary fields per table (for the in-memory store and tests). */
export const FACT_KEY_FIELDS: Record<FactTableName, string[]> = {
  salesDaily: keyFields("salesDaily"),
  stockDaily: keyFields("stockDaily"),
  sessionsDaily: keyFields("sessionsDaily"),
};
