/**
 * Shopify Sidekick data tools (extensions/keha-inventory-sidekick): one
 * function per tool, called by app/routes/api.sidekick.$tool.tsx with the
 * authenticated shop. Read-only and database-only (no Admin API calls), so a
 * tool answers well inside Sidekick's 1-second budget. Response shapes live in
 * app/lib/sidekick-shared.ts.
 *
 * Plans: every tool returns exactly what the app's screens show on the store's
 * plan, through the same gates (services/entitlements getEntitlements, which
 * fails open; an error there also counts as "everything allowed"). Locked data
 * is not returned and the tool says only that it isn't available — never a
 * plan name or an upgrade (Sidekick content policy).
 *
 *  get_order_plan        Reorder screen (reorderPlan)       → supplier groups by order-by date
 *  get_product_stock     Products table (forecast columns)  → status, stock, days left, order by
 *  get_action_list       Home "This week's actions"         → plan limits of buildActionList
 *  get_money_at_stake    Home money cards                   → every plan; plus dead stock value
 *  get_purchase_orders   Reorder "Open orders" (reorderPlan)
 *  get_forecast_accuracy Planner scorecard (planner + accuracy)
 */
import { getEntitlements } from "./entitlements.server";
import { getHomeData } from "../models/dashboard.server";
import { getActionList, stockValue } from "../models/actions.server";
import { loadReorder, openOrders } from "../models/reorder.server";
import { accuracyMonths, deadVariantIds, searchVariantStock, shopFacts } from "../models/sidekick.server";
import { featureMap, ACTION_LIST_LIMIT, type Feature, type PlanCode } from "../lib/plan-shared";
import { addDays } from "../lib/engine/dates-shared";
import {
  basisLines,
  formatAmount,
  formatCount,
  formatDay,
  formatPercent,
  todayIn,
  type Fmt,
  type HomeState,
} from "../lib/dashboard-shared";
import { MONEY_CARDS } from "../lib/money-shared";
import { actionReasonText } from "../lib/monday-shared";
import {
  MAX_ROWS,
  MSG,
  accuracyResponse,
  actionListResponse,
  moneyResponse,
  orderPlanResponse,
  productStockResponse,
  purchaseOrdersResponse,
  readActionKind,
  readMonths,
  readPoStatus,
  readText,
  readWithinDays,
  searchWords,
  type ActionIn,
  type OrderPlanOptions,
  type PlanGroupIn,
  type SidekickResponse,
  type SidekickTool,
} from "../lib/sidekick-shared";

type Access = { plan: PlanCode; features: Record<Feature, boolean> };

/** The store's plan as the admin applies it; any failure → everything allowed (fail open, I-6). */
export async function sidekickAccess(shop: string): Promise<Access> {
  try {
    const e = await getEntitlements(shop);
    return { plan: e.plan === "none" ? "free" : e.plan, features: e.features };
  } catch {
    return { plan: "pro", features: featureMap("pro") };
  }
}

const STATE_MESSAGE: Record<Exclude<HomeState, "ready">, string> = {
  syncing: MSG.syncing,
  noTracked: MSG.noTracked,
  noSales: MSG.noSales,
};

const identity = (s: string) => s;

// ── get_order_plan ──────────────────────────────────────────────────────────

/**
 * Where the order plan's supplier groups come from. Today: the Reorder screen's
 * groups (VariantMetric order quantities, open Keha orders, supplier minimums).
 * A forward order calendar can be passed instead (same group shape) without
 * touching the tool, its route or its response.
 */
export type OrderPlanSource = (shop: string, window: { today: string; cutoff: string }) => Promise<PlanGroupIn[]>;

export const reorderScreenSource: OrderPlanSource = async (shop) => (await loadReorder(shop)).groups;

export async function orderPlanForSidekick(
  shop: string,
  opts: OrderPlanOptions,
  deps: { now?: Date; access?: Access; source?: OrderPlanSource } = {},
): Promise<SidekickResponse> {
  const facts = await shopFacts(shop);
  if (!facts) return { results: [], message: MSG.syncing };
  const access = deps.access ?? (await sidekickAccess(shop));
  if (!access.features.reorderPlan) return { results: [], message: MSG.notAvailable };
  const today = todayIn(facts.timezone, deps.now ?? new Date());
  const cutoff = addDays(today, opts.withinDays);
  const groups = await (deps.source ?? reorderScreenSource)(shop, { today, cutoff });
  return orderPlanResponse(groups, opts, { today, cutoff, storeCurrency: facts.currency });
}

// ── get_product_stock ───────────────────────────────────────────────────────

export async function productStockForSidekick(
  shop: string,
  query: string | null,
  deps: { now?: Date; access?: Access } = {},
): Promise<SidekickResponse> {
  const words = searchWords(query);
  if (!words.length) return { results: [], message: MSG.emptyQuery };
  const facts = await shopFacts(shop);
  if (!facts) return { results: [], message: MSG.syncing };
  const access = deps.access ?? (await sidekickAccess(shop));
  const { rows, total } = await searchVariantStock(shop, words, access.features.forecast, MAX_ROWS);
  return productStockResponse(rows, {
    query: words.join(" "),
    total,
    forecast: access.features.forecast,
    today: todayIn(facts.timezone, deps.now ?? new Date()),
  });
}

// ── get_action_list ─────────────────────────────────────────────────────────

/** Only links inside this app (never another app's admin URL). */
const appHref = (href: string | undefined, tab: string) => (href && href.startsWith("/app") ? href : `/app?tab=${tab}`);

export async function actionListForSidekick(
  shop: string,
  kind: string | null,
  deps: { now?: Date; access?: Access } = {},
): Promise<SidekickResponse> {
  const now = deps.now ?? new Date();
  const access = deps.access ?? (await sidekickAccess(shop));
  const home = await getHomeData(shop, access.plan, now);
  if (home.state !== "ready") return { results: [], message: STATE_MESSAGE[home.state] };
  // The Keha Preorder check is an Admin API call: not asked (Sidekick gets no button links).
  const list = await getActionList(shop, access.plan, now);
  if (!list) return { results: [], message: MSG.syncing };
  const rows: ActionIn[] = list.rows.map((r) => ({
    kind: r.kind,
    tab: r.tab,
    productId: r.productId,
    productTitle: r.productTitle,
    variants: r.variants,
    amount: r.amount,
    currency: r.currency,
    reasonText: actionReasonText("en", r.reason),
    path: appHref("href" in r.button ? r.button.href : undefined, r.tab),
  }));
  return actionListResponse(rows, {
    kind: readActionKind(kind),
    currency: list.currency,
    limited: list.hiddenCount > 0 ? ACTION_LIST_LIMIT[access.plan] : null,
  });
}

// ── get_money_at_stake ──────────────────────────────────────────────────────

const enFmt = (currency: string): Fmt => ({
  money: (v) => formatAmount(v, currency, "en"),
  count: (v) => formatCount(v, "en"),
  percent: (v) => formatPercent(v, "en"),
  day: (v) => formatDay(v, "en"),
});

export async function moneyForSidekick(shop: string, deps: { now?: Date; access?: Access } = {}): Promise<SidekickResponse> {
  const now = deps.now ?? new Date();
  const access = deps.access ?? (await sidekickAccess(shop));
  const home = await getHomeData(shop, access.plan, now);
  if (home.state !== "ready") return { message: STATE_MESSAGE[home.state] };
  if (!home.money) return { message: MSG.syncing };
  const facts = await shopFacts(shop);
  const ids = await deadVariantIds(shop);
  const dead = ids.length ? await stockValue(shop, ids) : { cash: 0, units: 0, retail: false };
  const m = home.money;
  const fmt = enFmt(m.currency);
  return moneyResponse(
    {
      day: m.day,
      currency: m.currency,
      refresh: home.refresh,
      cards: MONEY_CARDS.map((key) => ({ key, value: m.values[key], how: basisLines(key, m.basis, identity, fmt).join("; ") })),
      dead: { ...dead, variants: ids.length, deadDays: facts?.deadDays ?? 90 },
    },
    todayIn(home.timezone, now),
  );
}

// ── get_purchase_orders ─────────────────────────────────────────────────────

export async function purchaseOrdersForSidekick(
  shop: string,
  filters: { status: string | null; supplier: string | null },
  deps: { now?: Date; access?: Access } = {},
): Promise<SidekickResponse> {
  const facts = await shopFacts(shop);
  if (!facts) return { results: [], message: MSG.syncing };
  const access = deps.access ?? (await sidekickAccess(shop));
  if (!access.features.reorderPlan) return { results: [], message: MSG.notAvailable };
  const rows = (await openOrders(shop)).sort(
    (a, b) => (a.arrival ?? "9999").localeCompare(b.arrival ?? "9999") || b.createdAt.localeCompare(a.createdAt),
  );
  return purchaseOrdersResponse(rows, {
    status: readPoStatus(filters.status),
    supplier: filters.supplier,
    today: todayIn(facts.timezone, deps.now ?? new Date()),
    storeCurrency: facts.currency,
  });
}

// ── get_forecast_accuracy ───────────────────────────────────────────────────

export async function accuracyForSidekick(shop: string, months: number, deps: { access?: Access } = {}): Promise<SidekickResponse> {
  const access = deps.access ?? (await sidekickAccess(shop));
  if (!access.features.planner || !access.features.accuracy) return { message: MSG.notAvailable };
  return accuracyResponse(await accuracyMonths(shop, months));
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/** Runs one tool for the authenticated shop; `params` is the request's query string. */
export async function runSidekickTool(
  shop: string,
  tool: SidekickTool,
  params: URLSearchParams,
  now: Date = new Date(),
): Promise<SidekickResponse> {
  const access = await sidekickAccess(shop);
  const deps = { now, access };
  switch (tool) {
    case "get_order_plan":
      return orderPlanForSidekick(
        shop,
        { supplier: readText(params.get("supplier")), withinDays: readWithinDays(params.get("within_days")) },
        deps,
      );
    case "get_product_stock":
      return productStockForSidekick(shop, readText(params.get("query")), deps);
    case "get_action_list":
      return actionListForSidekick(shop, params.get("kind"), deps);
    case "get_money_at_stake":
      return moneyForSidekick(shop, deps);
    case "get_purchase_orders":
      return purchaseOrdersForSidekick(shop, { status: params.get("status"), supplier: readText(params.get("supplier")) }, deps);
    case "get_forecast_accuracy":
      return accuracyForSidekick(shop, readMonths(params.get("months")), deps);
  }
}
