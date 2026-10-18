/**
 * The hourly alerts job (spec §6.6 "alerts", §11; task 2.6): instant alerts by
 * email (every plan) and Slack (Growth), and the Shopify Flow triggers (Growth).
 * Rules and wording: app/lib/alerts-shared.ts (instant), app/lib/flow-shared.ts (Flow).
 *
 * Reads only the database (VariantMetric, Variant, StockNow, StockDaily,
 * SessionsDaily, AlertLog). Metric-based rules (best seller running out, Flow)
 * are skipped when the metrics are over 36 h old — never alert on stale numbers.
 *
 * Perf 2026-10-18 (#7): Postgres aggregates and returns only the candidates (lib/alerts-sql-shared:
 * products fully out now, the metrics a rule can use, the dead products) and the catalog of those
 * products — not every metric and every stock-now row of the store every hour. The rules are the
 * same functions on the same rows.
 *
 * Instant alerts: respects Settings → Alerts "Send instant alerts" (also turned
 * off by the alert email's unsubscribe link / List-Unsubscribe). Email goes to
 * the Monday email recipients (else the store owner), in the store's language,
 * once per UTC hour per store (OwnerEmailLog kind "alert") with all new alerts;
 * an AlertLog row per product and channel is written only after a successful
 * send, so a failed send is tried again next hour and a product is alerted at
 * most once per 7 days on each channel.
 *
 * Flow triggers (Growth, not tied to the instant-alerts switch: the merchant opts
 * in by building a workflow): "Product needs reorder" / "Product went dead",
 * once per product per episode (lib/flow-shared episodeStep), at most
 * MAX_FLOW_PER_TICK per store per tick. A trigger Shopify rejects is logged
 * as "flow_rejected" and retried after 24 h, at most 7 times in 30 days.
 */
import prisma from "../db.server";
import { facts } from "./facts-store.server";
import { latestMetricRun } from "./metric-writes.server";
import { SAMPLE_SUFFIX } from "../lib/sample-mode-shared";
import { enqueueJob } from "./jobs/queue.server";
import { adminAppUrl } from "../lib/admin-url.server";
import { toSupportedLocale } from "../lib/i18n";
import {
  ALERT_COOLDOWN_DAYS,
  ALERT_EMAIL_KIND,
  INSTANT_ALERT_KINDS,
  alertLine,
  alertMessage,
  composeAlertEmail,
  lowBestSellers,
  pickAlerts,
  sellOutsStarted,
  fullyOut,
  variantLabel,
  type AlertChannel,
  type InstantAlert,
  type MetricLite,
} from "../lib/alerts-shared";
import { POOL_LOCATION_SELECT, poolLocationIds, pooledOutOfStock, productHandleFromPath, SCOPE_ONLINE } from "../lib/compute-shared";
import { hasFeature, type PlanCode } from "../lib/plan-shared";
import { variantNumericId } from "../lib/products-shared";
import { readSettings, type ShopSettings } from "../lib/settings-shared";
import { buildSlackAlerts } from "../lib/slack-shared";
import {
  FLOW_ENDED,
  FLOW_FIRED,
  FLOW_LOG_KIND,
  FLOW_REJECTED,
  FLOW_REJECTION_WINDOW_DAYS,
  FLOW_NEEDS_REORDER,
  FLOW_WENT_DEAD,
  MAX_FLOW_PER_TICK,
  episodeStep,
  needsReorderPayload,
  needsReorderProducts,
  productCash,
  variantCash,
  wentDeadPayload,
  type FlowHandle,
} from "../lib/flow-shared";
import { unauthenticated } from "../shopify.server";
import { fireFlowTrigger, type AdminGraphql } from "./flow.server";
import { dayDate } from "../lib/sync/facts-shared";
import { addDays } from "../lib/sync/shopifyql-shared";
import { localDate, safeTimeZone } from "../lib/sync/store-time-shared";
import { planFor } from "./entitlements.server";
import { emailUnsubscribeUrl, ownerContact, sendOwnerEmailOnce } from "./owner-email.server";
import { listUnsubscribeHeaders } from "../lib/owner-email-shared";
import { deliverSlack } from "./slack.server";
import { SQL_ALERT_METRICS, SQL_FULLY_OUT_PRODUCTS } from "../lib/alerts-sql-shared";

type RawQuery = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
const raw: RawQuery = (sql, params) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);

const DAY_MS = 24 * 60 * 60 * 1000;
/** Metrics older than this are not alerted on (same bound as the Monday email on paid plans). */
export const MAX_METRIC_AGE_MS = 36 * 60 * 60 * 1000;

export type AlertsShopRow = {
  domain: string;
  currency: string;
  timezone: string;
  locale: string;
  uninstalledAt: Date | null;
  settings: unknown;
};

export type InstantResult = {
  status: "sent" | "nothing" | "off" | "failed";
  email?: string;
  slack?: string;
  alerts?: number;
};

/** The store's tracked, active, non-bundle variants grouped by product (what compute plans). */
export type CatalogProduct = { title: string; handle: string; variantIds: string[]; variantTitles: Map<string, string> };

/** The planned catalog — only of `productIds` when given (the alert candidates). */
export async function loadCatalog(shop: string, productIds?: readonly string[]): Promise<Map<string, CatalogProduct>> {
  if (productIds && !productIds.length) return new Map();
  const variants = await prisma.variant.findMany({
    where: { shop, tracked: true, isBundle: false, status: "ACTIVE", ...(productIds ? { productId: { in: [...productIds] } } : {}) },
    select: { id: true, productId: true, productTitle: true, variantTitle: true, handle: true },
  });
  const out = new Map<string, CatalogProduct>();
  for (const v of variants) {
    let p = out.get(v.productId);
    if (!p) out.set(v.productId, (p = { title: v.productTitle, handle: v.handle, variantIds: [], variantTitles: new Map() }));
    p.variantIds.push(v.id);
    const label = variantLabel(v.variantTitle);
    if (label) p.variantTitles.set(v.id, label);
  }
  for (const p of out.values()) p.variantIds.sort();
  return out;
}

export type MetricRowLite = {
  variantId: string;
  productId: string;
  status: string;
  role: string;
  daysLeft: number | null;
  orderQty: number | null;
  orderBy: Date | null;
  computedAt: Date;
};

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));

export type AlertMetrics = {
  /** The planned variants' online metrics a rule can use (SQL_ALERT_METRICS, a superset of what the rules keep), with their product. */
  rows: MetricRowLite[];
  /** Products whose every planned variant with a metric is Dead → those variants. */
  dead: Map<string, string[]>;
  /** The latest run is fresh enough to alert on. */
  fresh: boolean;
};

/** The online-pool metrics the rules can use (perf #7: candidates only), and whether they are fresh enough. */
export async function loadMetrics(shop: string, now: Date): Promise<AlertMetrics> {
  const [rowsRaw, any] = await Promise.all([
    raw(SQL_ALERT_METRICS, [shop, SCOPE_ONLINE]),
    prisma.variantMetric.findFirst({ where: { shop, scope: SCOPE_ONLINE }, select: { variantId: true } }),
  ]);
  const rows: MetricRowLite[] = rowsRaw.map((r) => ({
    variantId: String(r.variantId),
    productId: String(r.productId),
    status: String(r.status),
    role: String(r.role),
    daysLeft: numOrNull(r.daysLeft),
    orderQty: numOrNull(r.orderQty),
    orderBy: dateOrNull(r.orderBy),
    computedAt: dateOrNull(r.computedAt) ?? new Date(0),
  }));
  // The rows of products whose every planned variant with a metric is Dead come flagged (dead).
  const dead = new Map<string, string[]>();
  for (const r of rowsRaw) if (r.dead === true || r.dead === "t") (dead.get(String(r.productId)) ?? dead.set(String(r.productId), []).get(String(r.productId))!).push(String(r.variantId));
  for (const ids of dead.values()) ids.sort();
  // The latest run, not the rows' computedAt (unchanged rows keep the run that last changed them).
  const newest = any ? ((await latestMetricRun(shop, SCOPE_ONLINE))?.getTime() ?? 0) : 0;
  return { rows, dead, fresh: newest > 0 && now.getTime() - newest <= MAX_METRIC_AGE_MS };
}

/** Products fully out now over the pool (every planned variant has stock-now rows, Σ available ≤ 0). */
async function fullyOutProducts(shop: string): Promise<{ pool: string[]; products: string[] }> {
  const locations = await prisma.location.findMany({ where: { shop }, select: POOL_LOCATION_SELECT });
  const pool = poolLocationIds(locations);
  if (!pool.length) return { pool, products: [] };
  return { pool, products: (await raw(SQL_FULLY_OUT_PRODUCTS, [shop, pool])).map((r) => String(r.productId)) };
}

/** VariantMetric.inputs for a few variants (the heavy JSON is read only where needed). */
export async function loadInputs(shop: string, variantIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  if (!variantIds.length) return new Map();
  const rows = await prisma.variantMetric.findMany({
    where: { shop, scope: SCOPE_ONLINE, variantId: { in: variantIds } },
    select: { variantId: true, inputs: true },
  });
  return new Map(rows.map((r) => [r.variantId, (r.inputs && typeof r.inputs === "object" ? r.inputs : {}) as Record<string, unknown>]));
}

const finiteNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Rule (a) input: A-role metrics with their lead time (VariantMetric.inputs, else the shop default). */
async function bestSellerMetrics(
  shop: string,
  catalog: Map<string, CatalogProduct>,
  metrics: MetricRowLite[],
  settings: ShopSettings,
): Promise<MetricLite[]> {
  const productOf = new Map<string, string>();
  for (const [pid, p] of catalog) for (const v of p.variantIds) productOf.set(v, pid);
  // A lead time is at most 365 days (Settings bounds), so anything with more days left can't qualify.
  const a = metrics.filter((m) => m.role === "A" && m.daysLeft != null && m.daysLeft < 365 && productOf.has(m.variantId));
  const inputs = await loadInputs(shop, a.map((m) => m.variantId));
  return a.map((m) => ({
    variantId: m.variantId,
    productId: productOf.get(m.variantId)!,
    role: m.role,
    daysLeft: m.daysLeft,
    leadTimeDays: finiteNum(inputs.get(m.variantId)?.leadTimeDays) ?? settings.leadTimeDays,
  }));
}

/** Rule (b): products fully out now that were not fully out on the last stock day, with ≥ 50 sessions a week. */
async function startedSellOuts(
  shop: string,
  timezone: string,
  catalog: Map<string, CatalogProduct>,
  out: { pool: string[]; products: string[] },
  now: Date,
): Promise<Map<string, number>> {
  const pool = out.pool;
  if (!pool.length) return new Map();
  // Out now = nothing left to sell: Σ Shopify available over the pool ≤ 0 (the planning position
  // compute's "Out" uses; on hand that is all committed to orders can't be sold either) — for every
  // planned variant of the product (SQL_FULLY_OUT_PRODUCTS).
  const outNow = new Map<string, boolean>();
  for (const pid of out.products) for (const v of catalog.get(pid)?.variantIds ?? []) outNow.set(v, true);
  const candidates = [...catalog].filter(([, p]) => fullyOut(p.variantIds, outNow));
  if (!candidates.length) return new Map();

  const last = await facts.stockDaily.findFirst({
    where: { shop, locationId: { in: pool } },
    orderBy: { day: "desc" },
    select: { day: true },
  });
  if (!last) return new Map();
  const variantIds = candidates.flatMap(([, p]) => p.variantIds);
  const prevRows = await facts.stockDaily.findMany({
    where: { shop, day: last.day, locationId: { in: pool }, variantId: { in: variantIds } },
    select: { variantId: true, endUnits: true, outOfStock: true },
  });
  const agg = new Map<string, { endUnits: number; reported: number; outReported: number }>();
  for (const r of prevRows) {
    const a = agg.get(r.variantId) ?? { endUnits: 0, reported: 0, outReported: 0 };
    a.endUnits += r.endUnits;
    a.reported += 1;
    if (r.outOfStock) a.outReported += 1;
    agg.set(r.variantId, a);
  }
  const outPrev = new Map([...agg].map(([v, a]) => [v, pooledOutOfStock(a)] as const));

  // Landing sessions over the last 7 store-local days (up to yesterday).
  const today = localDate(now, safeTimeZone(timezone));
  const sessionRows = await facts.sessionsDaily.findMany({
    where: { shop, day: { gte: dayDate(addDays(today, -7)), lte: dayDate(addDays(today, -1)) }, landingPath: { contains: "/products/" } },
    select: { landingPath: true, sessions: true },
  });
  const sessions = new Map<string, number>();
  for (const r of sessionRows) {
    const h = productHandleFromPath(r.landingPath);
    if (h) sessions.set(h, (sessions.get(h) ?? 0) + r.sessions);
  }
  return sellOutsStarted(
    candidates.map(([productId, p]) => ({ productId, handle: p.handle, variantIds: p.variantIds })),
    outNow,
    outPrev,
    sessions,
  );
}

/** Products alerted in the last 7 days, per channel. */
async function recentlyAlerted(shop: string, now: Date): Promise<Record<AlertChannel, Set<string>>> {
  const rows = await prisma.alertLog.findMany({
    where: { shop, kind: { in: [...INSTANT_ALERT_KINDS] }, sentAt: { gte: new Date(now.getTime() - ALERT_COOLDOWN_DAYS * DAY_MS) } },
    select: { productId: true, channel: true },
  });
  const out: Record<AlertChannel, Set<string>> = { email: new Set(), slack: new Set() };
  for (const r of rows) if (r.channel === "email" || r.channel === "slack") out[r.channel].add(r.productId);
  return out;
}

async function logAlerts(shop: string, alerts: InstantAlert[], channel: AlertChannel, now: Date): Promise<void> {
  await prisma.alertLog.createMany({
    data: alerts.map((a) => ({ shop, productId: a.productId, kind: a.kind, channel, sentAt: now })),
  });
}

/** Instant alerts for one store (already known installed). */
export async function runInstantAlerts(
  row: AlertsShopRow,
  settings: ShopSettings,
  plan: PlanCode,
  catalog: Map<string, CatalogProduct>,
  metrics: AlertMetrics,
  now: Date,
  fullyOutNow?: { pool: string[]; products: string[] },
): Promise<InstantResult> {
  const shop = row.domain;
  if (!settings.alerts.instant) return { status: "off" };
  const low = metrics.fresh ? lowBestSellers(await bestSellerMetrics(shop, catalog, metrics.rows, settings)) : new Map();
  const sellOuts = await startedSellOuts(shop, row.timezone, catalog, fullyOutNow ?? (await fullyOutProducts(shop)), now);
  if (!low.size && !sellOuts.size) return { status: "nothing" };

  const recent = await recentlyAlerted(shop, now);
  const forEmail = pickAlerts(catalog, low, sellOuts, recent.email);
  const slackOn = Boolean(settings.alerts.slackWebhook) && hasFeature(plan, "slack");
  const forSlack = slackOn ? pickAlerts(catalog, low, sellOuts, recent.slack) : [];
  if (!forEmail.length && !forSlack.length) return { status: "nothing" };

  const locale = toSupportedLocale(row.locale);
  const contact = await ownerContact(shop, null);
  const storeName = contact?.name || shop;
  const settingsLink = adminAppUrl(shop, "/app/settings/alerts");
  const message = (alerts: InstantAlert[]) =>
    alertMessage(
      locale,
      storeName,
      alerts.map((a) =>
        alertLine(locale, a, adminAppUrl(shop, `/app/products/${variantNumericId(a.variantId)}`), row.locale, hasFeature(plan, "forecast")),
      ),
      settingsLink,
    );

  const out: InstantResult = { status: "nothing", alerts: Math.max(forEmail.length, forSlack.length) };
  if (forEmail.length) {
    const recipients = settings.mondayEmail.recipients.map((r) => r.trim()).filter((r) => r.includes("@"));
    const to = recipients.length ? recipients : contact?.to ?? null;
    if (!to || (Array.isArray(to) && !to.length)) out.email = "no_recipient";
    else {
      // One-click unsubscribe (footer link + List-Unsubscribe): turns instant alerts off.
      const unsubscribe = emailUnsubscribeUrl(shop, "alerts", now.getTime());
      const content = composeAlertEmail(locale, message(forEmail), unsubscribe);
      out.email = await sendOwnerEmailOnce(
        shop,
        { kind: ALERT_EMAIL_KIND, periodKey: now.toISOString().slice(0, 13), ...content, headers: listUnsubscribeHeaders(unsubscribe) },
        { name: storeName, to, locale },
        now,
      );
      if (out.email === "sent") await logAlerts(shop, forEmail, "email", now);
    }
  }
  if (forSlack.length) {
    const r = await deliverSlack(shop, settings, buildSlackAlerts(message(forSlack)), now);
    out.slack = r === "skipped" ? "skipped" : r.ok ? "sent" : `failed:${r.code}`;
    if (r !== "skipped" && r.ok) await logAlerts(shop, forSlack, "slack", now);
  }
  out.status = out.email === "sent" || out.slack === "sent" ? "sent" : out.email === "failed" || out.slack?.startsWith("failed") ? "failed" : "nothing";
  return out;
}

// ---------------------------------------------------------------- Flow triggers

export type FlowResult = { status: "fired" | "nothing" | "stale" | "error"; fired?: number; rejected?: number; ended?: number };

export type FlowDeps = { getAdmin?: (shop: string) => Promise<AdminGraphql> };

const defaultAdmin = async (shop: string): Promise<AdminGraphql> => (await unauthenticated.admin(shop)).admin as unknown as AdminGraphql;

const dayKey = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Flow triggers for one store (Growth; the caller checks the plan). */
export async function runFlowTriggers(
  shop: string,
  catalog: Map<string, CatalogProduct>,
  metrics: AlertMetrics,
  now: Date,
  deps: FlowDeps = {},
): Promise<FlowResult> {
  // A stale run must not end episodes or fire on old numbers.
  if (!metrics.fresh) return { status: "stale" };
  const productOf = new Map<string, string>();
  for (const [pid, p] of catalog) for (const v of p.variantIds) productOf.set(v, pid);
  const rows = metrics.rows
    .filter((m) => productOf.has(m.variantId))
    .map((m) => ({ ...m, productId: productOf.get(m.variantId)!, orderBy: dayKey(m.orderBy) }));

  const reorder = needsReorderProducts(rows);
  // Every planned variant with a metric is Dead (deadProductIds, aggregated in SQL: SQL_ALERT_METRICS `dead`).
  const deadIds = new Set([...metrics.dead.keys()].filter((pid) => catalog.has(pid)));
  const dead = new Map<string, number>();
  if (deadIds.size) {
    const vidsOf = (pid: string) => (metrics.dead.get(pid) ?? []).filter((v) => productOf.get(v) === pid);
    const inputs = await loadInputs(shop, [...deadIds].flatMap(vidsOf));
    for (const pid of deadIds) {
      const cash = productCash(vidsOf(pid), (v) => variantCash(inputs.get(v)));
      if (cash != null) dead.set(pid, cash);
    }
  }

  const flowKinds = [FLOW_LOG_KIND[FLOW_NEEDS_REORDER], FLOW_LOG_KIND[FLOW_WENT_DEAD]];
  const [latestRows, rejectedRows] = await Promise.all([
    prisma.alertLog.findMany({
      where: { shop, kind: { in: flowKinds } },
      orderBy: { sentAt: "desc" },
      distinct: ["productId", "kind"],
      select: { productId: true, kind: true, channel: true, sentAt: true },
    }),
    // Rejections in the window bound the retries (lib/flow-shared FLOW_MAX_REJECTIONS).
    prisma.alertLog.groupBy({
      by: ["productId", "kind"],
      where: { shop, kind: { in: flowKinds }, channel: FLOW_REJECTED, sentAt: { gte: new Date(now.getTime() - FLOW_REJECTION_WINDOW_DAYS * DAY_MS) } },
      _count: { _all: true },
    }),
  ]);
  const latest = new Map(latestRows.map((r) => [`${r.kind}|${r.productId}`, r]));
  const rejections = new Map(rejectedRows.map((r) => [`${r.kind}|${r.productId}`, r._count._all]));

  type Fire = { handle: FlowHandle; productId: string; payload: Record<string, unknown> };
  const fires: Fire[] = [];
  const fireIfNew = (handle: FlowHandle, productId: string, payload: Record<string, unknown> | null) => {
    const key = `${FLOW_LOG_KIND[handle]}|${productId}`;
    const last = latest.get(key);
    const retry = last ? { latestAt: last.sentAt, rejections: rejections.get(key) ?? 0, now } : undefined;
    if (payload && episodeStep(last?.channel, true, retry) === "fire") fires.push({ handle, productId, payload });
  };
  // Most urgent first: fewest days left; most cash stuck.
  for (const [pid, st] of [...reorder].sort((a, b) => a[1].daysLeft - b[1].daysLeft)) fireIfNew(FLOW_NEEDS_REORDER, pid, needsReorderPayload(pid, st));
  for (const [pid, cash] of [...dead].sort((a, b) => b[1] - a[1])) fireIfNew(FLOW_WENT_DEAD, pid, wentDeadPayload(pid, cash));

  // Products that left the state since their last fire: the episode ends.
  const inState: Record<string, (productId: string) => boolean> = {
    [FLOW_LOG_KIND[FLOW_NEEDS_REORDER]]: (pid) => reorder.has(pid),
    [FLOW_LOG_KIND[FLOW_WENT_DEAD]]: (pid) => dead.has(pid),
  };
  const ends = latestRows.filter((r) => episodeStep(r.channel, inState[r.kind]?.(r.productId) ?? false) === "end");

  if (ends.length) {
    await prisma.alertLog.createMany({ data: ends.map((e) => ({ shop, productId: e.productId, kind: e.kind, channel: FLOW_ENDED, sentAt: now })) });
  }
  const out: FlowResult = { status: "nothing", fired: 0, rejected: 0, ended: ends.length };
  if (!fires.length) return out;

  const admin = await (deps.getAdmin ?? defaultAdmin)(shop);
  for (const f of fires.slice(0, MAX_FLOW_PER_TICK)) {
    const r = await fireFlowTrigger(admin, f.handle, f.payload);
    if (r.status === "error") {
      // Network / throttle / auth: stop here, the rest go next tick.
      console.warn(`[flow] ${shop} ${f.handle}: ${r.error}`);
      out.status = "error";
      return out;
    }
    if (r.status === "rejected") {
      out.rejected! += 1;
      console.log(`[flow] ${shop} ${f.handle}: ${r.error}`);
    } else out.fired! += 1;
    // A rejection is logged under its own channel: not a fire, retried after 24 h (bounded).
    const channel = r.status === "rejected" ? FLOW_REJECTED : FLOW_FIRED;
    await prisma.alertLog.create({ data: { shop, productId: f.productId, kind: FLOW_LOG_KIND[f.handle], channel, sentAt: now } });
  }
  out.status = "fired";
  return out;
}

// ---------------------------------------------------------------- per store

export type AlertsShopResult = { instant: InstantResult["status"] | "skipped"; flow: FlowResult["status"] | "off" | "skipped" };

/** One store: instant alerts (if on) and Flow triggers (Growth). Each part's failure is logged and never stops the other. */
export async function runAlertsForShop(row: AlertsShopRow, now: Date = new Date(), deps: FlowDeps = {}): Promise<AlertsShopResult> {
  if (row.uninstalledAt) return { instant: "skipped", flow: "skipped" };
  const settings = readSettings(row.settings);
  let plan: PlanCode;
  try {
    plan = await planFor(row.domain);
  } catch {
    plan = "pro"; // plan checks fail open (I-6)
  }
  const flowOn = hasFeature(plan, "flowTriggers");
  if (!settings.alerts.instant && !flowOn) return { instant: "off", flow: "off" };
  // Perf #7: the candidates first (SQL aggregates), then the catalog of only their products.
  const metrics = await loadMetrics(row.domain, now);
  const out = settings.alerts.instant ? await fullyOutProducts(row.domain) : { pool: [], products: [] };
  const catalog = await loadCatalog(row.domain, [...new Set([...out.products, ...metrics.rows.map((m) => m.productId), ...metrics.dead.keys()])]);

  let instant: AlertsShopResult["instant"] = "off";
  if (settings.alerts.instant) {
    try {
      instant = (await runInstantAlerts(row, settings, plan, catalog, metrics, now, out)).status;
    } catch (e) {
      instant = "failed";
      console.error(`[alerts] ${row.domain} instant alerts failed`, e);
    }
  }
  let flow: AlertsShopResult["flow"] = "off";
  if (flowOn) {
    try {
      flow = (await runFlowTriggers(row.domain, catalog, metrics, now, deps)).status;
    } catch (e) {
      flow = "error";
      console.error(`[alerts] ${row.domain} Flow triggers failed`, e);
    }
  }
  return { instant, flow };
}

/** Every installed store; one store's failure never stops the others. */
export async function runAlertsAllShops(now: Date = new Date()): Promise<Record<string, number>> {
  // Sample data (`<shop>#sample`) never alerts, emails, posts to Slack or triggers Flow.
  const rows = (await prisma.shop.findMany({ where: { uninstalledAt: null, NOT: { domain: { contains: SAMPLE_SUFFIX } } } })) as AlertsShopRow[];
  const counts: Record<string, number> = {};
  for (const row of rows) {
    try {
      const r = await runAlertsForShop(row, now);
      counts[`instant:${r.instant}`] = (counts[`instant:${r.instant}`] ?? 0) + 1;
      counts[`flow:${r.flow}`] = (counts[`flow:${r.flow}`] ?? 0) + 1;
    } catch (e) {
      counts.error = (counts.error ?? 0) + 1;
      console.error(`[alerts] ${row.domain} failed`, e);
    }
  }
  return counts;
}

/**
 * Scheduler entry (hourly): one `alerts` job per installed store (DB scale #2) — the work runs on
 * the job workers (services/jobs, runAlertsForShop), a store at a time across instances.
 * Overlap-guarded; never throws.
 */
let alertsRunning = false;
export async function alertsTick(): Promise<void> {
  if (alertsRunning) return;
  alertsRunning = true;
  try {
    const rows = await prisma.shop.findMany({ where: { uninstalledAt: null, NOT: { domain: { contains: SAMPLE_SUFFIX } } }, select: { domain: true } });
    let queued = 0;
    for (const row of rows) if (await enqueueJob(row.domain, "alerts")) queued++;
    if (queued) console.log(`[scheduler/alerts] queued ${queued} store(s)`);
  } catch (e) {
    console.error("[scheduler/alerts]", e);
  } finally {
    alertsRunning = false;
  }
}
