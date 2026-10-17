/**
 * End-to-end simulation harness (owner 2026-10-17): a simulated store (lib/sim) is written the
 * way the sync writes a real one (services/sample-data writeSimStore → the sync's writers), the
 * REAL compute runs, then the REAL screen loaders (Dashboard, Order now, Next 13 weeks, Season
 * plan, Open orders, a purchase order, the supplier order builder, Products, a product page,
 * Settings), the Monday email and the Sidekick tools read it — and the business invariants hold
 * across them (`checkInvariants`). Every screen also renders (SSR) in English and German.
 *
 * The database is whatever the test file mocks app/db.server with: the in-memory fake (always) or
 * real Postgres through psql (tests/helpers/pg-prisma, when reachable).
 */
import { expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ComponentType } from "react";
import { createRoutesStub, Outlet } from "react-router";
import prisma from "../../app/db.server";
import { simulateStore, simDay, VARIANTS_PER_PRODUCT, W1, W2, POS, type SimSize, type SimStore } from "../../app/lib/sim/store-sim-shared";
import { simVariantsOf } from "../../app/lib/sim/sim-rows-shared";
import { hash32 } from "../../app/lib/sim/rng-shared";
import { writeSimStore, type WriteReport } from "../../app/services/sample-data.server";
import { computeShop, type ComputeResult } from "../../app/services/compute.server";
import { computeOrderPlan, clearOrderPlanCache, type OrderPlanDetail } from "../../app/models/order-plan.server";
import { allProducts } from "../../app/models/products.server";
import { runMondayEmails, mondayOrders } from "../../app/services/monday.server";
import { runSidekickTool } from "../../app/services/sidekick.server";
import { LocaleProvider, translate, type Locale } from "../../app/lib/i18n";
import { SampleProvider } from "../../app/components/sample";
import { thisWeek, planWeeks } from "../../app/lib/order-plan-shared";
import { cashTotals, dueDay, ordersDue, variantLine, type PlanEvent } from "../../app/lib/engine/forward-plan-shared";
import { orderTotals } from "../../app/lib/reorder-shared";
import { DRAFT_EXPIRY_DAYS } from "../../app/lib/supplier-shared";
import { addDays } from "../../app/lib/engine/dates-shared";
import type { PlanCode } from "../../app/lib/plan-shared";
import { state } from "./mocks";
import { facts } from "../../app/services/facts-store.server";
import { POOL_LOCATION_SELECT, demandScope, demandWhere } from "../../app/lib/compute-shared";
import { SEASON } from "../../app/lib/engine/season-shared";
import { SPIKE_CAP, robustCap } from "../../app/lib/engine/outliers-shared";
import { readSettings } from "../../app/lib/settings-shared";
import { dayDate } from "../../app/lib/sync/facts-shared";

import * as Home from "../../app/routes/app._index";
import * as Reorder from "../../app/routes/app.reorder";
import * as Calendar from "../../app/routes/app.reorder_.calendar";
import * as Season from "../../app/routes/app.reorder_.season";
import * as Orders from "../../app/routes/app.reorder_.orders";
import * as OrderPage from "../../app/routes/app.reorder_.$id";
import * as Builder from "../../app/routes/app.reorder_.build";
import * as Products from "../../app/routes/app.products";
import * as Product from "../../app/routes/app.products_.$variantId";
import * as Settings from "../../app/routes/app.settings";
import * as Suppliers from "../../app/routes/app.settings_.suppliers";
import * as Locations from "../../app/routes/app.settings_.locations";
import * as Alerts from "../../app/routes/app.settings_.alerts";
import * as Import from "../../app/routes/app.settings_.import";

/** Monday 09:00 in Madrid: the Monday email is due, every screen reads the same day. */
export const E2E_NOW = new Date("2026-10-19T07:00:00.000Z");
export const E2E_TODAY = "2026-10-19";

type RouteModule = { loader: (args: never) => Promise<unknown>; default: ComponentType };

export type Screen = { id: string; path: string; url: string; mod: RouteModule; params?: Record<string, string>; data: unknown };

export type Loaded = { key: string; store: SimStore; report: WriteReport; compute: ComputeResult; ms: { write: number; compute: number } };

/** Simulate a store and write it under `key` as the sync would, then compute it. */
export async function loadSimStore(key: string, size: SimSize, opts: { seed?: number; settings?: Record<string, unknown> } = {}): Promise<Loaded> {
  // Each store its own seed, so its own id range (ids are global keys, as Shopify's are).
  const store = simulateStore({ size, today: E2E_TODAY, seed: opts.seed ?? hash32(key) });
  // performance.now: the tests' Date is a fake clock.
  let t = performance.now();
  const report = await writeSimStore(key, store, { now: E2E_NOW, settings: opts.settings });
  const write = Math.round(performance.now() - t);
  t = performance.now();
  const compute = await computeShop(key, { now: () => E2E_NOW.getTime() });
  return { key, store, report, compute, ms: { write, compute: Math.round(performance.now() - t) } };
}

async function load(mod: RouteModule, url: string, params: Record<string, string> = {}): Promise<unknown> {
  const request = new Request(`https://keha.test${url}`);
  return mod.loader({ request, params, context: {} } as never);
}

export type Screens = {
  detail: OrderPlanDetail;
  screens: Screen[];
  home: Home.HomeLoaderData;
  reorder: Reorder.ReorderPageData;
  calendar: Calendar.CalendarPageData;
  builders: Builder.BuilderPageData[];
  products: Awaited<ReturnType<typeof allProducts>>;
  monday: Awaited<ReturnType<typeof mondayOrders>>;
  mondayResult: string;
  sidekick: { plan7: Record<string, unknown>; plan91: Record<string, unknown>; stock: Record<string, unknown>; money: Record<string, unknown> };
};

/** Every screen's loader for `key` (as the store `shop`, plan `plan`), plus the email and Sidekick. */
export async function collectScreens(key: string, store: SimStore, plan: PlanCode = "growth"): Promise<Screens> {
  state.shop = key;
  state.plan = plan;
  clearOrderPlanCache();
  const detail = await computeOrderPlan(key, E2E_NOW);
  const screens: Screen[] = [];
  const add = async (id: string, mod: RouteModule, path: string, url: string, params?: Record<string, string>) => {
    const data = await load(mod, url, params);
    screens.push({ id, mod, path, url, params, data });
    return data;
  };
  const home = (await add("dashboard", Home as RouteModule, "/app", "/app")) as Home.HomeLoaderData;
  const reorder = (await add("order-now", Reorder as RouteModule, "/app/reorder", "/app/reorder")) as Reorder.ReorderPageData;
  const calendar = (await add("next-13-weeks", Calendar as RouteModule, "/app/reorder/calendar", "/app/reorder/calendar")) as Calendar.CalendarPageData;
  await add("season-plan", Season as RouteModule, "/app/reorder/season", "/app/reorder/season");
  await add("open-orders", Orders as RouteModule, "/app/reorder/orders", "/app/reorder/orders");
  const pos = await prisma.purchaseOrder.findMany({ where: { shop: key }, select: { id: true, status: true, source: true }, orderBy: { id: "asc" } });
  for (const status of ["sent", "confirmed", "draft"]) {
    const po = pos.find((p) => p.status === status && p.source === "keha");
    if (po) await add(`purchase-order-${status}`, OrderPage as RouteModule, "/app/reorder/:id", `/app/reorder/${po.id}`, { id: po.id });
  }
  const builders: Builder.BuilderPageData[] = [];
  for (const k of Object.keys(detail.data.suppliers).sort()) {
    builders.push((await add(`build-${k}`, Builder as RouteModule, "/app/reorder/build", `/app/reorder/build?supplier=${encodeURIComponent(k)}`)) as Builder.BuilderPageData);
  }
  await add("products", Products as RouteModule, "/app/products", "/app/products");
  const sample = [store.variants.find((v) => v.product.lifecycle === "normal" && v.product.tracked && !v.product.isBundle), store.variants.find((v) => v.product.noReorder), store.variants.find((v) => v.inventoryPolicy === "CONTINUE")];
  for (const v of sample) {
    if (!v) continue;
    const n = v.id.replace(/^.*\//, "");
    await add(`product-${n}`, Product as RouteModule, "/app/products/:variantId", `/app/products/${n}`, { variantId: n });
  }
  await add("settings", Settings as RouteModule, "/app/settings", "/app/settings");
  await add("settings-suppliers", Suppliers as RouteModule, "/app/settings/suppliers", "/app/settings/suppliers");
  await add("settings-locations", Locations as RouteModule, "/app/settings/locations", "/app/settings/locations");
  await add("settings-alerts", Alerts as RouteModule, "/app/settings/alerts", "/app/settings/alerts");
  // Settings → Import & export (R5): the counts of what each template holds, read under the same key.
  const imp = (await add("settings-import", Import as RouteModule, "/app/settings/import", "/app/settings/import")) as { enabled: boolean; counts: { suppliers: number; variants: number } };
  expect(imp.counts.variants).toBe(await prisma.variant.count({ where: { shop: key } }));

  const products = await allProducts(key, { status: null, collection: null, vendor: null, q: null } as never, true, "online", E2E_NOW);
  const monday = await mondayOrders(key, plan, "en", E2E_NOW);
  state.emails = [];
  const mondayResult = await runMondayEmails(key, E2E_NOW);
  const sk = async (tool: string, q: string) => (await runSidekickTool(key, tool as never, new URLSearchParams(q), E2E_NOW)) as unknown as Record<string, unknown>;
  const sidekick = {
    plan7: await sk("get_order_plan", "within_days=7"),
    plan91: await sk("get_order_plan", "within_days=91"),
    stock: await sk("get_product_stock", `query=${encodeURIComponent(store.products.find((p) => p.lifecycle === "normal" && p.tracked && !p.isBundle)!.title.split(" ")[0]!)}`),
    money: await sk("get_money_at_stake", ""),
  };
  return { detail, screens, home, reorder, calendar, builders, products, monday, mondayResult, sidekick };
}

/** Every number in a loader's data is finite; quantities and money are never negative. */
export function finiteAndNonNegative(label: string, value: unknown, path = ""): string[] {
  const bad: string[] = [];
  const walk = (v: unknown, p: string, key: string) => {
    if (typeof v === "number") {
      if (!Number.isFinite(v)) bad.push(`${label}${p}: ${v}`);
      else if (/^(qty|units|suggested|orderQty|cash|cost|amount|base|topUp|unitCost|unitCostStore|price|rounded)$/.test(key) && v < 0) bad.push(`${label}${p}: ${v} < 0`);
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`, key));
    else if (v && typeof v === "object" && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`, k);
  };
  walk(value, path, "");
  return bad;
}

const eventsBy = (events: readonly PlanEvent[]) => {
  const m = new Map<string, PlanEvent[]>();
  for (const e of events) (m.get(e.variantId) ?? m.set(e.variantId, []).get(e.variantId)!).push(e);
  return m;
};

/** The business invariants across the screens (see the module header). Returns counts for the report. */
export async function checkInvariants(loaded: Loaded, s: Screens): Promise<Record<string, number>> {
  const { key, store } = loaded;
  const plan = s.detail.data;
  const today = plan.today;
  expect(today).toBe(E2E_TODAY);
  expect(s.home.state).toBe("ready");
  const counts: Record<string, number> = {};

  // ── Metrics: nothing NaN / infinite / negative; statuses are the engine's ──
  const metrics = await prisma.variantMetric.findMany({ where: { shop: key, scope: "online" } });
  expect(metrics.length).toBeGreaterThan(store.variants.length * 0.8);
  const STATUSES = new Set(["out", "not_enough_data", "dead", "running_low", "too_much", "healthy"]);
  for (const m of metrics) {
    expect(STATUSES.has(m.status), m.status).toBe(true);
    for (const [k, v] of [["rate", m.rate], ["sigma", m.sigma], ["daysLeft", m.daysLeft]] as const) if (v !== null) expect(Number.isFinite(v) && v >= 0, `${m.variantId} ${k}=${v}`).toBe(true);
    if (m.orderQty !== null) expect(Number.isInteger(m.orderQty) && m.orderQty >= 0, `${m.variantId} orderQty=${m.orderQty}`).toBe(true);
  }
  counts.metrics = metrics.length;
  const metricOf = new Map(metrics.map((m) => [m.variantId, m]));
  const inputsOf = (id: string) => (metricOf.get(id)?.inputs ?? {}) as Record<string, unknown>;

  // ── Every loader: finite numbers, no negative quantity or money ──
  const bad = s.screens.flatMap((x) => finiteAndNonNegative(x.id, x.data));
  bad.push(...finiteAndNonNegative("sidekick", s.sidekick), ...finiteAndNonNegative("monday", s.monday), ...finiteAndNonNegative("products", s.products));
  expect(bad).toEqual([]);

  // ── Plan events: whole units, real dates ──
  expect(plan.events.length).toBeGreaterThan(0);
  for (const e of plan.events) {
    expect(Number.isInteger(e.qty) && e.qty > 0, `${e.variantId} qty ${e.qty}`).toBe(true);
    expect(e.orderBy >= today && e.arrives >= e.orderBy, `${e.variantId} ${e.orderBy} → ${e.arrives}`).toBe(true);
  }
  counts.events = plan.events.length;

  // ── One order-by date per variant on every screen ──
  const byVariant = eventsBy(plan.events);
  const draftVariants = new Set(store.purchaseOrders.filter((o) => o.status === "draft").flatMap((o) => o.lines.map((l) => store.variants[l.variantIdx]!.id)));
  const orderNowLines = new Map(s.reorder.groups.flatMap((g) => g.lines).map((l) => [l.variantId, l]));
  const productRows = new Map(s.products.map((r) => [r.id, r]));
  let checkedDates = 0;
  for (const [id, evs] of byVariant) {
    const line = variantLine(evs, today)!;
    const row = productRows.get(id);
    expect(row, `Products row for ${id}`).toBeTruthy();
    // Products' "To order" is Order now's line (M4).
    expect([row!.orderQty, row!.orderBy, row!.overdue], `Products ${id}`).toEqual([line.qty, line.orderBy, line.overdue]);
    const ol = orderNowLines.get(id);
    if (evs.some((e) => e.orderBy <= addDays(today, 6))) {
      expect(ol, `Order now line for ${id}`).toBeTruthy();
      expect([ol!.suggested, ol!.orderBy, ol!.overdue], `Order now ${id}`).toEqual([line.qty, line.orderBy, line.overdue]);
    }
    // The plan's deadline is compute's order-by date (one date, computed once) — except where a
    // draft made since the run is netted by the plan (H2: compute counts sent orders only).
    const st = s.detail.state.get(id);
    const stored = metricOf.get(id)?.orderBy;
    if (st?.deadline && stored && !draftVariants.has(id)) expect(st.deadline, `deadline ${id}`).toBe(stored.toISOString().slice(0, 10));
    checkedDates++;
  }
  counts.datesChecked = checkedDates;
  // Next 13 weeks and the Dashboard show the same orders.
  const sig = (e: PlanEvent) => `${e.variantId}|${e.orderBy}|${e.qty}|${e.cost}`;
  expect(s.calendar.plan.events.map(sig)).toEqual(plan.events.map(sig));
  const dash = s.home.orderPlan;
  expect(dash?.kind).toBe("full");
  if (dash?.kind === "full") expect(dash.plan.events.map(sig)).toEqual(plan.events.map(sig));

  // ── Order now == Dashboard this week == Monday email == Sidekick ──
  const week = thisWeek(plan);
  const nameOf = (k: string) => (plan.suppliers[k]?.name || "").trim();
  const dashBy = new Map(week.suppliers.map((x) => [x.supplierKey, { units: x.units, cash: x.cash, ...ordersDue(x.events) }]));
  const nowBy = new Map(
    s.reorder.groups.map((g) => {
      const t = orderTotals(g, g.lines, (id) => g.lines.find((l) => l.variantId === id)!.suggested);
      return [g.key, { units: t.units, cash: t.cost, orderBy: g.orderBy, overdue: g.overdue }];
    }),
  );
  expect([...nowBy.keys()].sort()).toEqual([...dashBy.keys()].sort());
  for (const [k, d] of dashBy) expect(nowBy.get(k), `Order now vs Dashboard ${k}`).toEqual(d);
  expect(s.monday?.kind).toBe("plan");
  if (s.monday?.kind === "plan") {
    const mon = new Map(s.monday.lines.map((l) => [l.name.trim(), { units: l.units, cash: l.cash, orderBy: l.orderBy, overdue: l.overdue }]));
    for (const [k, d] of dashBy) expect(mon.get(nameOf(k)) ?? mon.get(""), `Monday email vs Dashboard ${k}`).toEqual(d);
  }
  // Sidekick: one result per supplier (a long answer is cut to its size budget and says so),
  // each with the Dashboard's units, cash and order-by date; the totals cover every supplier.
  const skResults = (s.sidekick.plan7.results as { name: string; _meta: Record<string, unknown> }[]) ?? [];
  expect(skResults.length).toBeGreaterThan(0);
  expect(skResults.length).toBeLessThanOrEqual(dashBy.size);
  if (skResults.length < dashBy.size) expect(String(s.sidekick.plan7.note ?? "")).toContain(`Showing ${skResults.length} of ${dashBy.size}`);
  const keyByName = new Map([...dashBy.keys()].map((k) => [nameOf(k), k]));
  for (const r of skResults) {
    const d = dashBy.get(keyByName.get(r.name.trim()) ?? "");
    expect(d, `Sidekick result ${r.name}`).toBeTruthy();
    expect([r._meta.units, r._meta.cost ?? null, r._meta.order_by, r._meta.overdue ?? false], `Sidekick ${r.name}`).toEqual([d!.units, d!.cash, d!.orderBy, d!.overdue]);
  }
  const skWeek = s.sidekick.plan7.totals as { suppliers: number; units: number; cash: number | null };
  expect([skWeek.suppliers, skWeek.units]).toEqual([dashBy.size, week.totals.units]);
  expect(skWeek.cash ?? 0).toBeCloseTo(week.totals.cash ?? 0, 2);
  counts.thisWeekSuppliers = dashBy.size;
  counts.thisWeekUnits = week.totals.units;

  // The Monday email went out with the same orders: every supplier due this week is in it.
  expect(s.mondayResult).toBe("sent");
  expect(state.emails).toHaveLength(1);
  const mail = `${state.emails[0]!.html ?? ""}\n${state.emails[0]!.text ?? ""}`;
  for (const k of dashBy.keys()) expect(mail, `Monday email names ${nameOf(k)}`).toContain(nameOf(k) || "No vendor");

  // ── Cash totals agree: the weeks add up to the plan, Sidekick's 13 weeks to the same ──
  const total = cashTotals(plan.events);
  const weeks = planWeeks(plan);
  expect(weeks.reduce((a, w) => a + w.units, 0)).toBe(total.units);
  expect(Math.round(weeks.reduce((a, w) => a + (w.cash ?? 0), 0) * 100) / 100).toBeCloseTo(total.cash ?? 0, 2);
  const skTotals = s.sidekick.plan91.totals as { units: number; cash: number | null } | undefined;
  expect(skTotals?.units).toBe(total.units);
  expect(skTotals?.cash ?? 0).toBeCloseTo(total.cash ?? 0, 2);
  counts.planUnits = total.units;
  counts.planCash = Math.round(total.cash ?? 0);

  // ── Minimums met in every batch (per line, per style, per order in units and money) ──
  let batches = 0;
  for (const b of plan.batches ?? []) {
    const sup = plan.suppliers[b.supplierKey];
    const evs = plan.events.filter((e) => e.supplierKey === b.supplierKey && e.orderBy >= b.from && e.orderBy <= b.to);
    if (!evs.length || !sup) continue;
    batches++;
    for (const e of evs) {
      const v = plan.variants[e.variantId];
      if (v?.pack && v.pack > 1) expect(e.qty % v.pack, `case pack ${e.variantId} ${e.qty}/${v.pack}`).toBe(0);
      if (v?.moq) expect(e.qty, `MOQ ${e.variantId}`).toBeGreaterThanOrEqual(v.moq);
    }
    const units = evs.reduce((a, e) => a + e.qty, 0);
    if (sup.minOrderTotal) expect(units, `order minimum ${b.supplierKey} ${b.from}`).toBeGreaterThanOrEqual(sup.minOrderTotal);
    if (sup.minOrderValueStore && evs.every((e) => e.cost !== null)) {
      expect(evs.reduce((a, e) => a + (e.cost ?? 0), 0) + 0.01, `order value ${b.supplierKey} ${b.from}`).toBeGreaterThanOrEqual(sup.minOrderValueStore);
    }
    if (sup.minOrderScope === "product" && sup.minOrder) {
      const perStyle = new Map<string, number>();
      for (const e of evs) perStyle.set(e.productId, (perStyle.get(e.productId) ?? 0) + e.qty);
      for (const [pid, n] of perStyle) expect(n, `style minimum ${pid}`).toBeGreaterThanOrEqual(sup.minOrder);
    }
  }
  expect(batches).toBeGreaterThan(0);
  counts.batches = batches;

  // ── Seasonal items out of season are never Dead / Too much ──
  // What compute reads for it (M3): units each variant sold over the coming deadDays days LAST
  // YEAR, pool demand. Read here as compute reads it (the stored inputs no longer carry it, R1).
  const shopRow = await prisma.shop.findUnique({ where: { domain: key }, select: { settings: true } });
  const aheadFrom = addDays(today, -SEASON.yearShiftDays);
  const aheadTo = addDays(aheadFrom, readSettings(shopRow?.settings).deadDays - 1);
  const demand = demandWhere(demandScope(await prisma.location.findMany({ where: { shop: key }, select: POOL_LOCATION_SELECT })));
  const aheadG = await facts.salesDaily.groupBy({ by: ["variantId"], where: { shop: key, ...demand, day: { gte: dayDate(aheadFrom), lte: dayDate(aheadTo) } }, _sum: { sold: true } });
  const soldAhead = new Map(aheadG.map((g) => [g.variantId, Number(g._sum.sold ?? 0)]));
  let offSeason = 0;
  for (const m of metrics) {
    const ahead = soldAhead.get(m.variantId);
    if (typeof ahead === "number" && ahead > 0) {
      offSeason++;
      expect(["dead", "too_much"].includes(m.status), `${m.variantId} off season but ${m.status}`).toBe(false);
    }
  }
  const summer = store.variants.filter((v) => v.product.season === "summer" && v.product.status === "ACTIVE" && v.product.tracked && !v.product.isBundle);
  expect(summer.filter((v) => (soldAhead.get(v.id) ?? 0) > 0).length).toBeGreaterThan(0);
  counts.offSeason = offSeason;

  // ── Backorders vs lost sales ──
  let owed = 0;
  let lost = 0;
  for (const sn of store.stockNow) {
    const v = store.variants[sn.variantIdx]!;
    if (v.inventoryPolicy !== "CONTINUE" || sn.available >= 0) continue;
    const inp = inputsOf(v.id);
    if (!metricOf.has(v.id) || v.product.noReorder) continue;
    // Oversold: the backlog is owed, nothing is "missed".
    expect(inp.sellsWhenOut, `${v.id} sells when out`).toBe(true);
    for (const e of byVariant.get(v.id) ?? []) if (e.why) expect(e.why.missed ?? 0).toBe(0);
    owed++;
  }
  for (const [id, evs] of byVariant) {
    const v = store.variants.find((x) => x.id === id)!;
    if (v.inventoryPolicy !== "DENY") continue;
    expect(inputsOf(id).sellsWhenOut, `${id} DENY`).toBe(false);
    if (evs.some((e) => (e.why?.missed ?? 0) > 0)) lost++;
  }
  expect(owed + lost).toBeGreaterThan(0);
  counts.backorderVariants = owed;
  counts.lostSalesVariants = lost;

  // ── Sold-out days don't lower the pace: the stored rate is the engine's in-stock pace,
  // re-derived here from the simulator's own sales and stock (28/56/90-day windows, a sold-out
  // day = pool stock ≤ 0 and nothing sold) — and never below the naive average that counts
  // sold-out days as zero-sale days.
  const D = store.meta.days;
  const WINDOWS = [
    { days: 28, weight: 0.5 },
    { days: 56, weight: 0.3 },
    { days: 90, weight: 0.2 },
  ];
  let paced = 0;
  let excluded = 0;
  for (const v of store.variants) {
    const m = metricOf.get(v.id);
    if (!m || m.rate === null || inputsOf(v.id).pace) continue;
    const raw = (d: number) => {
      const i = v.idx * D + d;
      const sold = store.sold[0]![i]! + store.sold[1]![i]! + store.sold[2]![i]! - store.returned[0]![i]!;
      const pool = [W1, W2, POS].reduce((a, loc) => a + (v.at[loc] ? store.stock[loc]![i]! : 0), 0);
      return { sold, ended: pool <= 0 };
    };
    // R4 (forecast quality): the day a variant ran out (it ended at 0 but sold, the day before
    // ended with stock) is PARTIAL — counted at least at the window's full-day pace; one-off
    // spikes are capped at median + 4 × max(1.4826 × MAD, √mean) of the in-stock full days of the
    // 90-day series compute reads (older history only for the out-of-stock-most-of-the-window
    // variants, whose stored pace these checks skip).
    const day = (d: number) => {
      const x = raw(d);
      // (The day before must be in the 90-day series compute reads: its first day is never partial.)
      const partial = x.ended && x.sold > 0 && d > Math.max(v.firstStock, D - 90) && !raw(d - 1).ended;
      return { sold: x.sold, out: x.ended && !(x.sold > 0), partial };
    };
    const capValues: number[] = [];
    for (let d = D - 1; d >= Math.max(v.firstStock, D - 90) && capValues.length < SPIKE_CAP.windowDays; d--) {
      const x = day(d);
      if (!x.out && !x.partial && x.sold >= 0) capValues.push(x.sold);
    }
    const cap = (inputsOf(v.id).spikes as { off?: boolean } | undefined)?.off ? null : robustCap(capValues);
    const capped = (n: number) => (cap !== null && n > cap ? cap : n);
    let num = 0;
    let den = 0;
    let naiveNum = 0;
    let soldOutDays = 0;
    for (const w of WINDOWS) {
      let inStock = 0;
      let soldIn = 0;
      let data = 0;
      let soldAll = 0;
      let full = 0;
      const partials: number[] = [];
      for (let d = Math.max(D - w.days, v.firstStock); d < D; d++) {
        const x = day(d);
        data++;
        soldAll += capped(x.sold);
        if (x.out) {
          if (w.days === 90) soldOutDays++;
        } else {
          inStock++;
          if (x.partial) partials.push(capped(x.sold));
          else {
            full++;
            soldIn += capped(x.sold);
          }
        }
      }
      const fullPace = full > 0 ? Math.max(0, soldIn / full) : 0;
      for (const p of partials) soldIn += Math.max(p, fullPace);
      if (inStock >= 7) {
        num += w.weight * Math.max(0, soldIn / inStock);
        den += w.weight;
        naiveNum += w.weight * Math.max(0, soldAll / data);
      }
    }
    if (!den) continue;
    paced++;
    expect(m.rate, `${v.id} pace`).toBeCloseTo(num / den, 6);
    expect(m.rate + 1e-9, `${v.id} pace vs naive`).toBeGreaterThanOrEqual(naiveNum / den);
    if (soldOutDays > 0 && m.rate > naiveNum / den + 1e-9) excluded++;
  }
  expect(paced).toBeGreaterThan(store.variants.length * 0.5);
  expect(excluded).toBeGreaterThan(0);
  counts.paceRederived = paced;
  counts.paceAboveNaiveAfterStockOuts = excluded;

  // ── Drafts: a fresh draft is netted (on order), a draft older than 14 days isn't ──
  const drafts = await prisma.purchaseOrder.findMany({ where: { shop: key, source: "keha", status: "draft" } });
  const fresh = drafts.find((o) => o.createdAt.getTime() > E2E_NOW.getTime() - DRAFT_EXPIRY_DAYS * 86_400_000);
  const stale = drafts.find((o) => o.createdAt.getTime() <= E2E_NOW.getTime() - DRAFT_EXPIRY_DAYS * 86_400_000);
  expect(fresh && stale).toBeTruthy();
  expect(s.reorder.staleDrafts).toBe(1);
  const linesOf = (o: { lines: unknown }) => (o.lines as { variantId: string; qty: number }[]).map((l) => [l.variantId, l.qty] as const);
  for (const [id, qty] of linesOf(fresh!)) {
    const l = orderNowLines.get(id);
    if (l) expect(l.onOrder, `fresh draft on order ${id}`).toBeGreaterThanOrEqual(qty);
  }
  // The plan without each draft: removing the fresh one orders more (or earlier); the stale one changes nothing.
  const without = async (po: (typeof drafts)[number]) => {
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    clearOrderPlanCache();
    try {
      return (await computeOrderPlan(key, E2E_NOW)).data;
    } finally {
      const { id, ...rest } = po;
      await prisma.purchaseOrder.create({ data: { id, ...rest, lines: po.lines as never } as never });
      clearOrderPlanCache();
    }
  };
  const unitsFor = (events: readonly PlanEvent[], ids: ReadonlySet<string>) => events.filter((e) => ids.has(e.variantId)).reduce((a, e) => a + e.qty, 0);
  const freshIds = new Set(linesOf(fresh!).map(([id]) => id));
  const noFresh = await without(fresh!);
  expect(unitsFor(noFresh.events, freshIds), "without the fresh draft the plan orders more").toBeGreaterThan(unitsFor(plan.events, freshIds));
  const staleIds = new Set(linesOf(stale!).map(([id]) => id));
  const noStale = await without(stale!);
  expect(noStale.events.filter((e) => staleIds.has(e.variantId)).map(sig)).toEqual(plan.events.filter((e) => staleIds.has(e.variantId)).map(sig));
  counts.freshDraftUnitsNetted = unitsFor(noFresh.events, freshIds) - unitsFor(plan.events, freshIds);

  // ── "Don't reorder" is respected everywhere ──
  const noReorder = store.variants.filter((v) => v.product.noReorder && v.product.tracked && !v.product.isBundle);
  expect(noReorder.length).toBeGreaterThan(0);
  for (const v of noReorder) {
    expect(byVariant.has(v.id), `no order for ${v.id}`).toBe(false);
    expect(metricOf.get(v.id)?.orderBy ?? null).toBeNull();
    expect(orderNowLines.has(v.id)).toBe(false);
    const row = productRows.get(v.id);
    if (row) expect([row.orderQty ?? null, row.orderBy ?? null]).toEqual([null, null]);
    for (const b of s.builders) if (b.enabled && b.view) expect(b.view.lines.some((l) => l.variantId === v.id)).toBe(false);
  }
  expect(plan.notReordered).toBe(new Set(noReorder.map((v) => v.product.id)).size);
  counts.noReorderVariants = noReorder.length;

  // Nothing reached Shopify's write APIs (sample data and these reads never mutate the store).
  expect(state.graphql.filter((q) => /mutation/i.test(q))).toEqual([]);
  return counts;
}

/** Every screen renders on the server, in `locale`, with its own loader data. */
export function renderScreens(screens: readonly Screen[], locale: Locale, sample = false): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of screens) {
    const Shell = () =>
      createElement(LocaleProvider, {
        defaultLocale: locale,
        children: createElement(SampleProvider, { value: { on: sample }, children: createElement("div", { className: "keha-content" }, createElement(Outlet)) }),
      });
    const Stub = createRoutesStub([{ id: "shell", path: "/", Component: Shell, children: [{ id: "screen", path: s.path, Component: s.mod.default, loader: () => s.data }] }]);
    const html = renderToString(createElement(Stub, { initialEntries: [s.url], hydrationData: { loaderData: { screen: s.data } } }));
    expect(html.length, s.id).toBeGreaterThan(200);
    expect(html, `${s.id} rendered an error`).not.toMatch(/Unexpected Application Error|Error: /);
    out.set(s.id, html);
  }
  return out;
}

/** The text a screen must contain in `locale` (translated keys). */
export function expectTranslated(html: string, locale: Locale, keys: readonly string[]): void {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  for (const k of keys) {
    const t = translate(locale, k);
    expect(html.includes(t) || html.includes(esc(t)), `"${t}" (${locale})`).toBe(true);
  }
}

export { simDay, simVariantsOf, VARIANTS_PER_PRODUCT, dueDay };
