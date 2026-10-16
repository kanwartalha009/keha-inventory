/**
 * In-memory stand-in for the Prisma client (the query engine can't run in CI sandboxes).
 * Supports the subset the sync / compute / health code uses: findMany / findFirst / findUnique,
 * count, create, createMany (skipDuplicates by `keys`), upsert, update, updateMany, deleteMany,
 * aggregate (_max / _min), groupBy (_sum / _max / _count), and batch $transaction.
 *
 * Where-matcher: equality, { in, notIn, lt, lte, gt, gte, not, contains, startsWith }, OR / AND / NOT.
 * Dates compare by time. Compound unique keys (`shop_variantId_locationId: {...}`) are flattened.
 */
export type Row = Record<string, unknown>;

const OPS = new Set(["in", "notIn", "lt", "lte", "gt", "gte", "not", "contains", "startsWith", "equals"]);

function norm(v: unknown): unknown {
  if (v instanceof Date) return v.getTime();
  if (v && typeof v === "object" && "toNumber" in (v as object)) return (v as { toNumber: () => number }).toNumber();
  return v;
}

function isOpObject(c: unknown): c is Record<string, unknown> {
  return !!c && typeof c === "object" && !(c instanceof Date) && !Array.isArray(c) && Object.keys(c).some((k) => OPS.has(k));
}

/** `{ a_b: { a: 1, b: 2 } }` → `{ a: 1, b: 2 }` (compound unique selectors). */
function flattenWhere(where: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(where)) {
    if (k !== "OR" && k !== "AND" && k !== "NOT" && v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) && !isOpObject(v)) {
      Object.assign(out, v);
    } else out[k] = v;
  }
  return out;
}

export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  const w = flattenWhere(where);
  return Object.entries(w).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === "OR") return (cond as Row[]).some((x) => matches(row, x));
    if (k === "AND") return (Array.isArray(cond) ? cond : [cond]).every((x) => matches(row, x as Row));
    if (k === "NOT") return !matches(row, cond as Row);
    const v = norm(row[k]);
    if (isOpObject(cond)) {
      return Object.entries(cond).every(([op, arg]) => {
        const a = norm(arg);
        switch (op) {
          case "equals":
            return v === a;
          case "in":
            return (arg as unknown[]).map(norm).includes(v);
          case "notIn":
            return !(arg as unknown[]).map(norm).includes(v);
          case "lt":
            return v != null && (v as number) < (a as number);
          case "lte":
            return v != null && (v as number) <= (a as number);
          case "gt":
            return v != null && (v as number) > (a as number);
          case "gte":
            return v != null && (v as number) >= (a as number);
          case "not":
            return a === null ? v != null : v !== a;
          case "contains":
            return typeof row[k] === "string" && (row[k] as string).includes(arg as string);
          case "startsWith":
            return typeof row[k] === "string" && (row[k] as string).startsWith(arg as string);
          default:
            return false;
        }
      });
    }
    return v === norm(cond);
  });
}

function pick(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, on] of Object.entries(select)) if (on) out[k] = row[k];
  return out;
}

function sortRows(rows: Row[], orderBy?: Row | Row[]): Row[] {
  if (!orderBy) return rows;
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((x, y) => {
    for (const o of list) {
      const [k, dir] = Object.entries(o)[0] as [string, "asc" | "desc"];
      const a = norm(x[k]) as number;
      const b = norm(y[k]) as number;
      if (a === b) continue;
      const c = a == null ? -1 : b == null ? 1 : a < b ? -1 : 1;
      return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

export type FakeDb = {
  tables: Record<string, Row[]>;
  calls: { table: string; op: string; args: unknown }[];
  client: Record<string, unknown>;
  reset: () => void;
};

/** `keys[table]` = the columns of its primary / unique key, used by createMany skipDuplicates. */
export function createFakePrisma(keys: Record<string, string[]> = {}, updatedAtTables: string[] = []): FakeDb {
  const tables: Record<string, Row[]> = {};
  const calls: { table: string; op: string; args: unknown }[] = [];
  let clock = 0;
  const stamp = (table: string, row: Row) => {
    if (updatedAtTables.includes(table)) row.updatedAt = new Date(Date.now() + clock++);
    return row;
  };

  function model(table: string) {
    const rows = () => (tables[table] ??= []);
    const log = (op: string, args: unknown) => calls.push({ table, op, args });
    const sameKey = (a: Row, b: Row) => (keys[table] ?? ["id"]).every((k) => norm(a[k]) === norm(b[k]));
    return {
      findMany: async (args: { where?: Row; select?: Record<string, boolean>; orderBy?: Row | Row[]; distinct?: string[]; take?: number } = {}) => {
        log("findMany", args);
        let list = sortRows(rows().filter((r) => matches(r, args.where)), args.orderBy);
        if (args.distinct) {
          const seen = new Set<string>();
          list = list.filter((r) => {
            const k = JSON.stringify(args.distinct!.map((d) => norm(r[d])));
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
        if (args.take !== undefined) list = list.slice(0, args.take);
        return list.map((r) => pick(r, args.select));
      },
      findFirst: async (args: { where?: Row; select?: Record<string, boolean>; orderBy?: Row | Row[] } = {}) => {
        log("findFirst", args);
        const r = sortRows(rows().filter((x) => matches(x, args.where)), args.orderBy)[0];
        return r ? pick(r, args.select) : null;
      },
      findUnique: async (args: { where: Row; select?: Record<string, boolean> }) => {
        log("findUnique", args);
        const r = rows().find((x) => matches(x, args.where));
        return r ? pick(r, args.select) : null;
      },
      count: async (args: { where?: Row } = {}) => {
        log("count", args);
        return rows().filter((r) => matches(r, args.where)).length;
      },
      create: async ({ data }: { data: Row }) => {
        log("create", data);
        const r = stamp(table, { ...data });
        rows().push(r);
        return r;
      },
      createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
        log("createMany", { count: data.length, skipDuplicates });
        let count = 0;
        for (const d of data) {
          const dup = rows().some((r) => sameKey(r, d));
          if (dup && skipDuplicates) continue;
          if (dup) throw new Error(`unique constraint failed on ${table}`);
          rows().push(stamp(table, { ...d }));
          count++;
        }
        return { count };
      },
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        log("upsert", { where });
        const r = rows().find((x) => matches(x, where));
        if (r) return stamp(table, Object.assign(r, update));
        const n = stamp(table, { ...create });
        rows().push(n);
        return n;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        log("update", { where, data });
        const r = rows().find((x) => matches(x, where));
        if (!r) throw new Error(`record to update not found in ${table}`);
        return stamp(table, Object.assign(r, data));
      },
      updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
        log("updateMany", { where, data });
        let count = 0;
        for (const r of rows()) if (matches(r, where)) (stamp(table, Object.assign(r, data)), count++);
        return { count };
      },
      deleteMany: async (args: { where?: Row } = {}) => {
        log("deleteMany", args);
        const keep = rows().filter((r) => !matches(r, args.where));
        const count = rows().length - keep.length;
        tables[table] = keep;
        return { count };
      },
      aggregate: async (args: { where?: Row; _max?: Record<string, boolean>; _min?: Record<string, boolean> }) => {
        log("aggregate", args);
        const list = rows().filter((r) => matches(r, args.where));
        const agg = (fields: Record<string, boolean> | undefined, pickFn: (a: unknown, b: unknown) => boolean) => {
          if (!fields) return undefined;
          const out: Row = {};
          for (const f of Object.keys(fields)) {
            let best: unknown = null;
            for (const r of list) if (r[f] != null && (best == null || pickFn(norm(r[f]), norm(best)))) best = r[f];
            out[f] = best;
          }
          return out;
        };
        return {
          _max: agg(args._max, (a, b) => (a as number) > (b as number)),
          _min: agg(args._min, (a, b) => (a as number) < (b as number)),
        };
      },
      groupBy: async (args: {
        by: string[];
        where?: Row;
        _sum?: Record<string, boolean>;
        _max?: Record<string, boolean>;
        _min?: Record<string, boolean>;
        _count?: Record<string, boolean> | boolean;
      }) => {
        log("groupBy", args);
        const groups = new Map<string, Row[]>();
        for (const r of rows().filter((x) => matches(x, args.where))) {
          const k = JSON.stringify(args.by.map((b) => norm(r[b])));
          (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
        }
        return [...groups.values()].map((list) => {
          const out: Row = {};
          for (const b of args.by) out[b] = list[0][b];
          if (args._sum) {
            const s: Row = {};
            for (const f of Object.keys(args._sum)) s[f] = list.reduce((a, r) => a + Number(norm(r[f]) ?? 0), 0);
            out._sum = s;
          }
          if (args._max) {
            const m: Row = {};
            for (const f of Object.keys(args._max)) {
              let best: unknown = null;
              for (const r of list) if (r[f] != null && (best == null || (norm(r[f]) as number) > (norm(best) as number))) best = r[f];
              m[f] = best;
            }
            out._max = m;
          }
          if (args._min) {
            const m: Row = {};
            for (const f of Object.keys(args._min)) {
              let best: unknown = null;
              for (const r of list) if (r[f] != null && (best == null || (norm(r[f]) as number) < (norm(best) as number))) best = r[f];
              m[f] = best;
            }
            out._min = m;
          }
          if (args._count) {
            if (args._count === true) out._count = list.length;
            else {
              const c: Row = {};
              for (const f of Object.keys(args._count)) c[f] = f === "_all" ? list.length : list.filter((r) => r[f] != null).length;
              out._count = c;
            }
          }
          return out;
        });
      },
    };
  }

  const cache = new Map<string, ReturnType<typeof model>>();
  const client = new Proxy(
    {},
    {
      get: (_t, name: string) => {
        if (name === "$transaction") {
          return async (arg: unknown) => {
            if (Array.isArray(arg)) return Promise.all(arg);
            if (typeof arg === "function") return (arg as (tx: unknown) => unknown)(client);
            return arg;
          };
        }
        if (name === "then") return undefined;
        if (!cache.has(name)) cache.set(name, model(name));
        return cache.get(name);
      },
    },
  ) as Record<string, unknown>;

  return {
    tables,
    calls,
    client,
    reset: () => {
      for (const k of Object.keys(tables)) delete tables[k];
      calls.length = 0;
    },
  };
}
