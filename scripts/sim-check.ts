/**
 * Store simulator report (`npm run sim:check`): simulates a store (lib/sim), prints what it holds
 * (counts, totals, seasons, suppliers, purchase orders, sample lines) and — by default — runs it
 * through the app: written by the sync's own writers (services/sample-data writeSimStore) into an
 * in-memory database (tests/helpers/fake-prisma), the real compute, then the order plan, the money
 * at stake and the action list, for a human to read.
 *
 *   npm run sim:check                         S store, full pipeline (≈ 1 minute)
 *   npm run sim:check -- --size M             M store, report only (add --pipeline for the run)
 *   npm run sim:check -- --products 120 --seed 7 --today 2026-03-02
 *   npm run sim:check -- --no-pipeline        the simulation only (seconds)
 *
 * Not part of the app build or of the tests. Nothing here reaches Shopify or a real database.
 */
import { register } from "node:module";

// The Shopify app object needs real credentials; nothing here uses it (no Admin API calls).
const HOOKS = `
export async function load(url, context, next) {
  if (/\\/app\\/shopify\\.server\\.ts$/.test(url.split("?")[0])) {
    return { format: "module", shortCircuit: true, source: "const no = () => { throw new Error('sim-check: Shopify is not available'); };\\nexport const authenticate = { admin: no };\\nexport const unauthenticated = { admin: no };\\nexport default {};" };
  }
  return next(url, context);
}`;
register("data:text/javascript," + encodeURIComponent(HOOKS));

type Args = { size: "S" | "M" | "L"; products?: number; seed?: number; today: string; pipeline: boolean };

function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i > -1 ? argv[i + 1] : undefined;
  };
  const size = (get("size") ?? "S").toUpperCase();
  if (size !== "S" && size !== "M" && size !== "L") throw new Error("--size is S, M or L");
  const today = get("today") ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("--today is YYYY-MM-DD");
  const products = get("products") ? Number(get("products")) : undefined;
  const seed = get("seed") ? Number(get("seed")) : undefined;
  const pipeline = argv.includes("--no-pipeline") ? false : argv.includes("--pipeline") ? true : size === "S" && (products ?? 60) <= 200;
  return { size, products, seed, today, pipeline };
}

const args = parseArgs(process.argv.slice(2));

// The app's database: the in-memory stand-in (installed before any app module loads).
const { createFakePrisma } = await import("../tests/helpers/fake-prisma");
const { fakeRaw } = await import("../tests/helpers/fake-raw");
const db = createFakePrisma(
  {
    variantMetric: ["shop", "variantId", "scope"],
    moneyAtStake: ["shop", "day"],
    action: ["shop", "dedupeKey"],
    stockNow: ["shop", "variantId", "locationId"],
    sessionsDaily: ["shop", "day", "landingPath", "trafficType"],
    shopDaily: ["shop", "day"],
    shop: ["domain"],
  },
  ["variant", "supplier", "purchaseOrder", "stockNow", "action"],
  fakeRaw(() => db),
);
(globalThis as unknown as { prismaGlobal: unknown }).prismaGlobal = db.client;

const { simulateStore, simPrice, CHANNELS, W1, W2, POS } = await import("../app/lib/sim/store-sim-shared");
const { simMonths, simPurchaseOrderRows, simSalesRows, simSessionsRows, simStockRows } = await import("../app/lib/sim/sim-rows-shared");

const fmt = (n: number, d = 0) => n.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
const line = (label: string, value: string) => console.log(`  ${label.padEnd(34)} ${value}`);
const head = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

const t0 = performance.now();
const store = simulateStore({ size: args.size, products: args.products, seed: args.seed, today: args.today });
const simMs = Math.round(performance.now() - t0);
const D = store.meta.days;
const sum = (a: Int32Array) => a.reduce((x, y) => x + y, 0);

head(`Simulated store — ${store.meta.size} (seed ${store.meta.seed}), history ${store.meta.from} … ${store.meta.yesterday} (${D} days), simulated in ${simMs} ms`);
line("Products / variants", `${fmt(store.products.length)} / ${fmt(store.variants.length)}`);
line("Locations", store.locations.map((l) => `${l.name} (${l.role}${l.online ? ", online" : ""})`).join(", "));
line("Currency / time zone", `${store.meta.currency} / ${store.meta.timezone}`);
const life = new Map<string, number>();
for (const p of store.products) life.set(p.lifecycle, (life.get(p.lifecycle) ?? 0) + 1);
line("Product lifecycles", [...life].map(([k, n]) => `${k} ${n}`).join(", "));
line("Policies", `CONTINUE ${store.variants.filter((v) => v.inventoryPolicy === "CONTINUE").length}, DENY ${store.variants.filter((v) => v.inventoryPolicy === "DENY").length}`);
line("Missing cost prices", `${store.variants.filter((v) => v.cost === null && v.product.tracked).length} variants`);
line("Bundles / untracked / POS-only", `${store.products.filter((p) => p.isBundle).length} / ${store.products.filter((p) => !p.tracked).length} / ${store.products.filter((p) => p.posOnly).length} products`);

head("Suppliers");
for (const s of store.suppliers) {
  const n = store.variants.filter((v) => (v.supplierId ? v.supplierId === s.id : s.vendorMatch.includes(v.product.vendor))).length;
  const min = [s.minOrder ? `min ${s.minOrder}/${s.minOrderScope === "product" ? "style" : "variant"}` : null, s.minOrderTotal ? `order ≥ ${s.minOrderTotal} units` : null, s.minOrderValue ? `order ≥ ${s.currency} ${fmt(s.minOrderValue)}` : null, s.casePack ? `packs of ${s.casePack}` : null].filter(Boolean).join(", ");
  line(`${s.name} (${s.country})`, `lead ${s.leadTimeDays} d (transit ${s.transitDays}), every ${s.orderCycleDays} d, ${s.currency}${s.exchangeRate ? ` @ ${s.exchangeRate}` : ""}; ${min || "no minimums"}; ${n} variants${s.viaShopify ? "; Shopify POs" : ""}`);
}

head("Sales and stock");
const units = CHANNELS.map((_, ch) => sum(store.sold[ch]!));
CHANNELS.forEach((c, ch) => line(`Units sold — ${c}`, fmt(units[ch]!)));
line("Units returned (restocked)", fmt(sum(store.returned[0]!)));
line("Demand lost while sold out (DENY)", fmt(sum(store.truth.lost)));
let revenue = 0;
for (const v of store.variants) for (let d = 0; d < D; d++) revenue += (store.sold[0]![v.idx * D + d]! + store.sold[1]![v.idx * D + d]! + store.sold[2]![v.idx * D + d]!) * simPrice(v);
line("Gross sales", `${store.meta.currency} ${fmt(revenue)}`);
let stockUnits = 0;
let stockValue = 0;
let outNow = 0;
let oversold = 0;
for (const sn of store.stockNow) {
  const v = store.variants[sn.variantIdx]!;
  stockUnits += sn.onHand;
  stockValue += sn.onHand * (v.cost ?? 0);
}
for (const v of store.variants) {
  if (!v.product.tracked || v.product.isBundle || v.firstStock >= D) continue;
  const pool = [W1, W2, POS].reduce((a, loc) => a + (v.at[loc] ? store.stock[loc]![v.idx * D + D - 1]! : 0), 0);
  if (pool <= 0) outNow++;
  if (pool < 0) oversold++;
}
line("Stock now (on hand)", `${fmt(stockUnits)} units, ${store.meta.currency} ${fmt(stockValue)} at cost`);
line("Out of stock yesterday", `${outNow} variants (${oversold} oversold, backorders owed)`);
const months = simMonths(store);
const rows = { stock: 0, location: 0, channel: 0, sessions: 0 };
for (const m of months) {
  rows.stock += simStockRows(store, m).length;
  rows.location += simSalesRows(store, m, "location").length;
  rows.channel += simSalesRows(store, m, "channel").length;
  rows.sessions += simSessionsRows(store, m).length;
}
line("ShopifyQL rows (14 months)", `stock ${fmt(rows.stock)}, sales by location ${fmt(rows.location)}, by channel ${fmt(rows.channel)}, visits ${fmt(rows.sessions)}`);

head("Seasons (units per quarter, all channels)");
const quarters: { label: string; from: number; to: number }[] = [];
for (let d = 0; d < D; d += 91) quarters.push({ label: `${store.meta.from > "" ? new Date(Date.parse(store.meta.from) + d * 86_400_000).toISOString().slice(0, 7) : ""}`, from: d, to: Math.min(D, d + 91) });
console.log(`  ${"".padEnd(10)} ${quarters.map((q) => q.label.padStart(9)).join(" ")}`);
for (const season of ["winter", "summer", "all"] as const) {
  const vs = store.variants.filter((v) => v.product.season === season);
  const per = quarters.map((q) => {
    let n = 0;
    for (const v of vs) for (let d = q.from; d < q.to; d++) n += store.sold[0]![v.idx * D + d]! + store.sold[1]![v.idx * D + d]! + store.sold[2]![v.idx * D + d]!;
    return n;
  });
  console.log(`  ${season.padEnd(10)} ${per.map((n) => fmt(n).padStart(9)).join(" ")}`);
}

head("Purchase orders");
for (const o of simPurchaseOrderRows(store)) {
  const u = o.lines.reduce((a, l) => a + l.qty, 0);
  line(`${o.number} ${o.supplierName}`, `${o.source}, ${o.status}, ${o.lines.length} lines, ${fmt(u)} units${o.confirmedShipDate ? `, ships ${o.confirmedShipDate.toISOString().slice(0, 10)}` : ""}${o.expectedDate ? `, expected ${o.expectedDate.toISOString().slice(0, 10)}` : ""}`);
}

head("Sample lines (last 28 days)");
const picks = [
  store.variants.find((v) => v.product.season === "winter" && v.product.lifecycle === "normal"),
  store.variants.find((v) => v.product.season === "summer" && v.product.lifecycle === "normal"),
  store.variants.find((v) => v.product.lifecycle === "oversold"),
  store.variants.find((v) => v.product.lifecycle === "flop"),
  store.variants.find((v) => v.product.noReorder),
].filter((v): v is NonNullable<typeof v> => !!v);
for (const v of picks) {
  let sold = 0;
  for (let d = D - 28; d < D; d++) sold += store.sold[0]![v.idx * D + d]! + store.sold[1]![v.idx * D + d]! + store.sold[2]![v.idx * D + d]!;
  const pool = [W1, W2, POS].reduce((a, loc) => a + (v.at[loc] ? store.stock[loc]![v.idx * D + D - 1]! : 0), 0);
  line(`${v.product.title} — ${v.variantTitle}`, `${v.product.lifecycle}, ${v.inventoryPolicy}, sold ${sold}, stock ${pool}, expected ${store.truth.rateNow[v.idx]!.toFixed(2)}/day`);
}

if (!args.pipeline) {
  console.log("\n(--no-pipeline: the simulation only)");
  process.exit(0);
}

// ── Through the app ────────────────────────────────────────────────────────────────────────
console.log("");
const origLog = console.log;
console.log = () => {};
// The compact facts and the catalog's bulk writes over the in-memory tables (R1's facts store API).
const { useFakeFacts } = await import("../tests/helpers/fake-facts");
useFakeFacts(db);
const { writeSimStore } = await import("../app/services/sample-data.server");
const { computeShop } = await import("../app/services/compute.server");
const { loadOrderPlan } = await import("../app/models/order-plan.server");
const { thisWeek, planWeeks, supplierName } = await import("../app/lib/order-plan-shared");
const { cashTotals, dueDay, dueNote, ordersDue } = await import("../app/lib/engine/forward-plan-shared");
const { dueText } = await import("../app/lib/order-plan-shared");
const { addDays: addDaysTo } = await import("../app/lib/engine/dates-shared");
const KEY = "sim-check.myshopify.com";
const now = new Date(`${store.meta.today}T07:00:00.000Z`);
let t = performance.now();
const report = await writeSimStore(KEY, store, { now });
const writeMs = Math.round(performance.now() - t);
t = performance.now();
const computed = await computeShop(KEY, { now: () => now.getTime(), plan: async () => "growth" });
const computeMs = Math.round(performance.now() - t);
const plan = await loadOrderPlan(KEY, now);
console.log = origLog;

head(`Through the app (Growth): written in ${fmt(writeMs)} ms, computed in ${fmt(computeMs)} ms`);
line("Rows written", `${Object.entries(report.facts).map(([k, n]) => `${k} ${fmt(n)}`).join(", ")}; ${report.stockNow} stock now, ${report.purchaseOrders} purchase orders`);
const statuses = new Map<string, number>();
for (const m of db.tables.variantMetric ?? []) if (m.scope === "online") statuses.set(m.status as string, (statuses.get(m.status as string) ?? 0) + 1);
line("Variants computed", `${computed.variants} — ${[...statuses].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
const money = (db.tables.moneyAtStake ?? [])[0];
if (money) line("Money at stake", ["atRisk", "lost90", "cashStuck", "soldOutTraffic"].map((k) => `${k} ${money[k] === null ? "—" : fmt(Number(money[k]))}`).join(", "));
const kinds = new Map<string, number>();
for (const a of db.tables.action ?? []) kinds.set(a.kind as string, (kinds.get(a.kind as string) ?? 0) + 1);
line("Actions", [...kinds].map(([k, n]) => `${k} ${n}`).join(", ") || "none");
const week = thisWeek(plan);
line("Due this week", `${week.suppliers.length} suppliers, ${fmt(week.totals.units)} units, ${week.totals.cash === null ? "—" : `${plan.currency} ${fmt(week.totals.cash)}`}`);
for (const s of week.suppliers) {
  const due = ordersDue(s.events);
  // The app's own label rule (forward-plan dueState): "Due today" is never overdue.
  line(`  ${supplierName(plan, s.supplierKey, (x) => x)}`, `${fmt(s.units)} units, ${s.cash === null ? "—" : fmt(s.cash)}, ${dueText(due.orderBy, plan.today, (x) => x, "en-GB", due.overdue, dueNote(s.events))}`);
}
const total = cashTotals(plan.events);
line("Order calendar", `${fmt(total.lines)} orders, ${fmt(total.units)} units, ${plan.currency} ${fmt(total.cash ?? 0)} (${total.missingCost} lines without a cost)`);
line("Weekly cash", planWeeks(plan).map((w) => fmt(w.cash ?? 0)).join(" · "));
line("Can't plan yet / dead / don't reorder", `${plan.cantPlan.noData} / ${plan.cantPlan.dead} / ${plan.notReordered ?? 0} products`);
// Sanity (engine work 2026-10-17): no date months back for a product still selling, no tiny need
// raised to a full minimum per style, seasonal products waiting for their season.
const firstOf = new Map<string, (typeof plan.events)[number]>();
for (const e of plan.events) if (!firstOf.has(e.variantId) || e.orderBy < firstOf.get(e.variantId)!.orderBy) firstOf.set(e.variantId, e);
const metricOf = new Map((db.tables.variantMetric ?? []).filter((m) => m.scope === "online").map((m) => [m.variantId as string, m]));
let late = 0;
for (const e of firstOf.values()) {
  const i = (metricOf.get(e.variantId)?.inputs ?? {}) as { leadTimeDays?: number };
  const due = dueDay(e);
  if (e.overdue && due && due < addDaysTo(plan.today, -(i.leadTimeDays ?? 0))) late++;
}
const nextSeason = [...firstOf.values()].filter((e) => e.nextSeason);
line("Next season orders", `${nextSeason.length} products, first by ${nextSeason.map((e) => e.orderBy).sort()[0] ?? "—"}`);
line("Overdue since more than a lead time", `${late} (must be 0)`);
line("Held back below a style minimum", `${(plan.belowMinimum ?? []).length} styles${(plan.belowMinimum ?? []).slice(0, 3).map((b) => ` · ${b.productTitle} ${b.units}/${b.styleMin}`).join("")}`);
head("Sample plan lines");
for (const e of plan.events.slice(0, 8)) {
  const v = plan.variants[e.variantId];
  line(`${v?.productTitle ?? e.variantId} — ${v?.variantTitle ?? ""}`, `${e.qty} units, ${dueText(dueDay(e), plan.today, (x) => x, "en-GB", e.overdue, dueNote([e]))}, arrives ${e.arrives}, ${e.cost === null ? "—" : fmt(e.cost, 2)}`);
}
