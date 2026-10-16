/**
 * The hourly alerts job (spec §6.6 "alerts", §11; task 2.6): instant alerts by
 * email (every plan) and Slack (Growth), and the Shopify Flow triggers (Growth).
 * Rules and wording: app/lib/alerts-shared.ts (instant), app/lib/flow-shared.ts (Flow).
 *
 * Reads only the database (VariantMetric, Variant, StockNow, StockDaily,
 * SessionsDaily, AlertLog). Metric-based rules (best seller running out, Flow)
 * are skipped when the metrics are over 36 h old — never alert on stale numbers.
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
 * MAX_FLOW_PER_TICK per store per tick.
 */
import prisma from "../db.server";
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
  FLOW_NEEDS_REORDER,
  FLOW_WENT_DEAD,
  MAX_FLOW_PER_TICK,
  deadProductIds,
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

export async function loadCatalog(shop: string): Promise<Map<string, CatalogProduct>> {
  const variants = await prisma.variant.findMany({
    where: { shop, tracked: true, isBundle: false, status: "ACTIVE" },
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
  status: string;
  role: string;
  daysLeft: number | null;
  orderQty: number | null;
  orderBy: Date | null;
  computedAt: Date;
};

/** The online-pool metrics, and whether they are fresh enough to alert on. */
export async function loadMetrics(shop: string, now: Date): Promise<{ rows: MetricRowLite[]; fresh: boolean }> {
  const rows = (await prisma.variantMetric.findMany({
    where: { shop, scope: SCOPE_ONLINE },
    select: { variantId: true, status: true, role: true, daysLeft: true, orderQty: true, orderBy: true, computedAt: true },
  })) as MetricRowLite[];
  const newest = rows.reduce((m, r) => Math.max(m, r.computedAt.getTime()), 0);
  return { rows, fresh: newest > 0 && now.getTime() - newest <= MAX_METRIC_AGE_MS };
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
async function startedSellOuts(shop: string, timezone: string, catalog: Map<string, CatalogProduct>, now: Date): Promise<Map<string, number>> {
  const locations = await prisma.location.findMany({ where: { shop }, select: POOL_LOCATION_SELECT });
  const pool = poolLocationIds(locations);
  if (!pool.length) return new Map();
  const stock = await prisma.stockNow.findMany({ where: { shop, locationId: { in: pool } }, select: { variantId: true, onHand: true } });
  const onHand = new Map<string, number>();
  for (const s of stock) onHand.set(s.variantId, (onHand.get(s.variantId) ?? 0) + s.onHand);
  const outNow = new Map([...onHand].map(([v, n]) => [v, n <= 0] as const));
  const candidates = [...catalog].filter(([, p]) => fullyOut(p.variantIds, outNow));
  if (!candidates.length) return new Map();

  const last = await prisma.stockDaily.findFirst({
    where: { shop, locationId: { in: pool } },
    orderBy: { day: "desc" },
    select: { day: true },
  });
  if (!last) return new Map();
  const variantIds = candidates.flatMap(([, p]) => p.variantIds);
  const prevRows = await prisma.stockDaily.findMany({
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
  const sessionRows = await prisma.sessionsDaily.findMany({
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
  metrics: { rows: MetricRowLite[]; fresh: boolean },
  now: Date,
): Promise<InstantResult> {
  const shop = row.domain;
  if (!settings.alerts.instant) return { status: "off" };
  const low = metrics.fresh ? lowBestSellers(await bestSellerMetrics(shop, catalog, metrics.rows, settings)) : new Map();
  const sellOuts = await startedSellOuts(shop, row.timezone, catalog, now);
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
  metrics: { rows: MetricRowLite[]; fresh: boolean },
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
  const deadIds = deadProductIds(rows);
  const dead = new Map<string, number>();
  if (deadIds.size) {
    const deadVariants = rows.filter((r) => deadIds.has(r.productId)).map((r) => r.variantId);
    const inputs = await loadInputs(shop, deadVariants);
    for (const pid of deadIds) {
      const vids = rows.filter((r) => r.productId === pid).map((r) => r.variantId);
      const cash = productCash(vids, (v) => variantCash(inputs.get(v)));
      if (cash != null) dead.set(pid, cash);
    }
  }

  const latestRows = await prisma.alertLog.findMany({
    where: { shop, kind: { in: [FLOW_LOG_KIND[FLOW_NEEDS_REORDER], FLOW_LOG_KIND[FLOW_WENT_DEAD]] } },
    orderBy: { sentAt: "desc" },
    distinct: ["productId", "kind"],
    select: { productId: true, kind: true, channel: true },
  });
  const latest = new Map(latestRows.map((r) => [`${r.kind}|${r.productId}`, r.channel]));

  type Fire = { handle: FlowHandle; productId: string; payload: Record<string, unknown> };
  const fires: Fire[] = [];
  const fireIfNew = (handle: FlowHandle, productId: string, payload: Record<string, unknown> | null) => {
    if (payload && episodeStep(latest.get(`${FLOW_LOG_KIND[handle]}|${productId}`), true) === "fire") fires.push({ handle, productId, payload });
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
    await prisma.alertLog.create({ data: { shop, productId: f.productId, kind: FLOW_LOG_KIND[f.handle], channel: FLOW_FIRED, sentAt: now } });
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
  const catalog = await loadCatalog(row.domain);
  const metrics = await loadMetrics(row.domain, now);

  let instant: AlertsShopResult["instant"] = "off";
  if (settings.alerts.instant) {
    try {
      instant = (await runInstantAlerts(row, settings, plan, catalog, metrics, now)).status;
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
  const rows = (await prisma.shop.findMany({ where: { uninstalledAt: null } })) as AlertsShopRow[];
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

/** Scheduler entry (hourly). Overlap-guarded; logs only when something happened. */
let alertsRunning = false;
export async function alertsTick(): Promise<void> {
  if (alertsRunning) return;
  alertsRunning = true;
  try {
    const counts = await runAlertsAllShops(new Date());
    const active = Object.entries(counts).filter(([k]) => !/:(nothing|off|skipped|stale)$/.test(k));
    if (active.length) console.log(`[scheduler/alerts] ${JSON.stringify(counts)}`);
  } catch (e) {
    console.error("[scheduler/alerts]", e);
  } finally {
    alertsRunning = false;
  }
}
