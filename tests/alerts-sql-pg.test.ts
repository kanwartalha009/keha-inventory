/**
 * The alerts job's SQL aggregations (perf 2026-10-18, lib/alerts-sql-shared) on real Postgres 16
 * through psql, against the in-memory logic they replace (every metric and every stock-now row read,
 * then lib/alerts-shared fullyOut / lib/flow-shared deadProductIds and the rules' filters) on a
 * random store: the same products and the same candidate rows. Also the fake-raw emulation the
 * unit tests use (tests/helpers/fake-raw) on the same rows. Skipped without Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_AVAILABLE, bind, dropDb, freshDb, psql } from "./helpers/pg";
import { SQL_ALERT_METRICS, SQL_FULLY_OUT_PRODUCTS, textArrayLiteral } from "../app/lib/alerts-sql-shared";
import { fullyOut } from "../app/lib/alerts-shared";
import { deadProductIds } from "../app/lib/flow-shared";
import { fakeRaw } from "./helpers/fake-raw";
import type { FakeDb, Row } from "./helpers/fake-prisma";

const DB = "keha_alerts_sql";
const S = "alerts-sql.myshopify.com";
const POOL = ["gid://shopify/Location/1", "gid://shopify/Location/2"];
const STATUSES = ["healthy", "running_low", "out", "dead", "too_much", "not_enough_data"];

/** A deterministic store: 60 products × 1–4 variants, some draft / untracked / bundle, stock now at 3 locations, metrics. */
function store() {
  let x = 20261018;
  const rnd = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0), x / 2 ** 32);
  const variants: Row[] = [];
  const stockNow: Row[] = [];
  const metrics: Row[] = [];
  let n = 0;
  for (let p = 1; p <= 60; p++) {
    const allDead = rnd() < 0.15;
    const allOut = rnd() < 0.2;
    for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) {
      const id = `gid://shopify/ProductVariant/${++n}`;
      const kind = rnd();
      variants.push({ id, shop: S, productId: `gid://shopify/Product/${p}`, productTitle: `P${p}`, variantTitle: `V${k}`, handle: `p-${p}`, collections: [], tracked: kind > 0.05, isBundle: kind > 0.05 && kind < 0.08, status: kind > 0.08 && kind < 0.12 ? "DRAFT" : "ACTIVE" });
      for (const loc of [...POOL, "gid://shopify/Location/9"]) {
        if (rnd() < 0.1) continue; // no row at this location
        stockNow.push({ shop: S, variantId: id, locationId: loc, available: allOut && rnd() < 0.9 ? -Math.floor(rnd() * 2) : Math.floor(rnd() * 8) - 2, incoming: 0, committed: 0, onHand: 0 });
      }
      if (rnd() < 0.1) continue; // no metric
      const qty = rnd() < 0.5 ? Math.floor(rnd() * 20) : null;
      metrics.push({
        shop: S,
        variantId: id,
        scope: rnd() < 0.9 ? "online" : POOL[0],
        status: allDead ? "dead" : STATUSES[Math.floor(rnd() * STATUSES.length)],
        role: ["A", "B", "C"][Math.floor(rnd() * 3)],
        daysLeft: rnd() < 0.15 ? null : rnd() * 500,
        orderQty: qty,
        orderBy: rnd() < 0.7 ? new Date(Date.UTC(2026, 10, 1 + Math.floor(rnd() * 60))) : null,
        computedAt: new Date("2026-10-18T03:00:00Z"),
      });
    }
  }
  return { variants, stockNow, metrics };
}

const lit = (v: unknown): string => (v === null || v === undefined ? "NULL" : v instanceof Date ? `'${v.toISOString()}'` : typeof v === "number" || typeof v === "boolean" ? String(v) : Array.isArray(v) ? `'${textArrayLiteral(v as string[])}'` : `'${String(v).replace(/'/g, "''")}'`);
const insert = (table: string, rows: Row[], cols: string[]) =>
  rows.length ? `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES ${rows.map((r) => `(${cols.map((c) => lit(r[c])).join(",")})`).join(",")}` : "SELECT 1";

/** The logic the SQL replaces (alerts.server before perf #7), in memory. */
function reference(data: ReturnType<typeof store>) {
  const plannedVariants = data.variants.filter((v) => v.tracked && !v.isBundle && v.status === "ACTIVE");
  const catalog = new Map<string, string[]>();
  for (const v of plannedVariants) (catalog.get(v.productId as string) ?? catalog.set(v.productId as string, []).get(v.productId as string)!).push(v.id as string);
  const available = new Map<string, number>();
  for (const s of data.stockNow) if (POOL.includes(s.locationId as string)) available.set(s.variantId as string, (available.get(s.variantId as string) ?? 0) + (s.available as number));
  const outNow = new Map([...available].map(([v, a]) => [v, a <= 0] as const));
  const fullyOutIds = [...catalog].filter(([, ids]) => fullyOut(ids, outNow)).map(([p]) => p).sort();
  const productOf = new Map(plannedVariants.map((v) => [v.id as string, v.productId as string]));
  const rows: Row[] = data.metrics.filter((m) => m.scope === "online" && productOf.has(m.variantId as string)).map((m) => ({ ...m, productId: productOf.get(m.variantId as string)! }));
  const candidates = rows
    .filter((m) => (m.role === "A" && m.daysLeft != null && (m.daysLeft as number) < 365) || ((m.status === "running_low" || m.status === "out") && m.orderQty != null && (m.orderQty as number) > 0 && m.daysLeft != null && m.orderBy != null))
    .map((m) => m.variantId as string)
    .sort();
  const dead = [...deadProductIds(rows as { productId: string; status: string }[])].sort();
  // The rows the query returns: the candidates and every row of a dead product.
  const returned = [...new Set([...candidates, ...rows.filter((m) => dead.includes(m.productId as string)).map((m) => m.variantId as string)])].sort();
  return { fullyOutIds, candidates, dead, returned };
}

describe.skipIf(!PG_AVAILABLE)("alerts SQL on Postgres", () => {
  const data = store();
  beforeAll(() => {
    freshDb(DB);
    psql(DB, insert("Variant", data.variants.map((v) => ({ ...v, updatedAt: new Date() })), ["id", "shop", "productId", "productTitle", "variantTitle", "handle", "collections", "tracked", "isBundle", "status", "updatedAt"]));
    psql(DB, insert("StockNow", data.stockNow.map((s) => ({ ...s, updatedAt: new Date() })), ["shop", "variantId", "locationId", "available", "incoming", "committed", "onHand", "updatedAt"]));
    psql(DB, insert("VariantMetric", data.metrics.map((m) => ({ ...m, neverRunsOut: false, inputs: "{}" })), ["shop", "variantId", "scope", "status", "role", "daysLeft", "orderQty", "orderBy", "computedAt", "neverRunsOut", "inputs"]));
  }, 120_000);
  afterAll(() => dropDb(DB));

  const want = reference(data);
  it("finds the same fully-out products, candidate metrics and dead products as the in-memory logic", () => {
    expect(want.fullyOutIds.length).toBeGreaterThan(2);
    expect(want.candidates.length).toBeGreaterThan(10);
    expect(want.dead.length).toBeGreaterThan(2);
    const out = psql(DB, bind(SQL_FULLY_OUT_PRODUCTS, [S, textArrayLiteral(POOL)])).map((r) => r.productId as string).sort();
    expect(out).toEqual(want.fullyOutIds);
    const metrics = psql(DB, bind(SQL_ALERT_METRICS, [S, "online"]));
    expect(metrics.map((r) => r.variantId as string).sort()).toEqual(want.returned);
    expect(want.returned.length).toBeGreaterThan(want.candidates.length);
    expect(metrics.every((r) => typeof r.productId === "string" && (r.productId as string).startsWith("gid://shopify/Product/"))).toBe(true);
    expect([...new Set(metrics.filter((r) => r.dead === "t").map((r) => r.productId as string))].sort()).toEqual(want.dead);
  });

  it("the unit tests' emulation (fake-raw) answers the same", async () => {
    const db = { tables: { variant: data.variants, stockNow: data.stockNow, variantMetric: data.metrics } } as unknown as FakeDb;
    const q = fakeRaw(() => db).$queryRawUnsafe;
    expect(((await q(SQL_FULLY_OUT_PRODUCTS, S, POOL)) as Row[]).map((r) => r.productId).sort()).toEqual(want.fullyOutIds);
    const rows = (await q(SQL_ALERT_METRICS, S, "online")) as Row[];
    expect(rows.map((r) => r.variantId).sort()).toEqual(want.returned);
    expect([...new Set(rows.filter((r) => r.dead === true).map((r) => r.productId))].sort()).toEqual(want.dead);
  });
});
