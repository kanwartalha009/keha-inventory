/**
 * Keha Inventory Planner plans: Free / Growth $49 / Pro $99 (spec §3,
 * KEHA-INVENTORY-INTELLIGENCE-SPEC-v1-2026-10-16). Pure helpers, shared by
 * server and UI.
 *
 * Rules:
 *  - Plan locks teach, they don't hide: a locked feature shows what it does and
 *    an Upgrade button (components/plan.tsx).
 *  - Gates apply when something is created or changed. A downgrade never
 *    switches off something already running.
 *  - Fail open: no Partner API credentials, or a failed plan check, means no
 *    lockout (effectivePlan → "pro").
 *  - No SKU limit at launch, so nothing is metered.
 */

export const PLAN_CODES = ["free", "growth", "pro"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

const RANK: Record<PlanCode, number> = { free: 0, growth: 1, pro: 2 };

/**
 * Every paid feature and the lowest plan that includes it (spec §3).
 * Spec keys on every plan in some form have a limit below instead:
 *   moneyAtStake → MONEY_REFRESH (+ dailyRefresh), actionList / mondayEmail →
 *   ACTION_LIST_LIMIT (+ fullActionList), planner scenarios → SCENARIO_LIMIT.
 */
export const FEATURE_PLAN = {
  /** Money at stake refreshed daily (Free: weekly). */
  dailyRefresh: "growth",
  /** The full action list and the full Monday email (Free: top 10). */
  fullActionList: "growth",
  /** Per-variant days of stock left and suggested order quantity. */
  forecast: "growth",
  /** Order now in full: what to order from each supplier, by when (Free: read-only top 10 preview). */
  reorderPlan: "growth",
  /** Order plan · Next 13 weeks: every order-by date, by week and supplier, with the cash needed. */
  orderCalendar: "growth",
  /** Supplier list with lead times, minimum orders and case packs. */
  suppliers: "growth",
  /** Purchase orders as PDF / CSV / email to the supplier. */
  poExport: "growth",
  /** Supplier confirms the ship date through a link. */
  supplierConfirm: "growth",
  /** Take preorders or collect back-in-stock sign-ups for the gap before stock arrives. */
  bridge: "growth",
  /** Create a Shopify discount to clear dead stock. */
  clearance: "growth",
  /** Missing sizes, weak product pages, high returns, falling best sellers (Free: shown as a count). */
  fixDetails: "growth",
  /** Season plan (Growth: 1 scenario; Pro: unlimited — SCENARIO_LIMIT). */
  planner: "growth",
  /** Target share of revenue per collection. */
  collectionGoals: "growth",
  /** Forecast accuracy scorecard. */
  accuracy: "growth",
  /** Monday summary and instant alerts in Slack. */
  slack: "growth",
  /** Shopify Flow triggers ("Product needs reorder", "Product became dead stock"). */
  flowTriggers: "growth",
  /** CSV export of the Products table (spec §5.2). */
  csvExport: "growth",
  /** Set up suppliers and product settings from a CSV (Settings → Import & export, owner 2026-10-17). */
  csvImport: "growth",
  /** Planning per location and per POS store (Free / Growth: one stock pool). */
  locations: "pro",
  /** Create stock transfers in Shopify. */
  transfers: "pro",
} as const satisfies Record<string, PlanCode>;
export type Feature = keyof typeof FEATURE_PLAN;

/** Action-list rows shown (and in the Monday email); null = all. */
export const ACTION_LIST_LIMIT: Record<PlanCode, number | null> = { free: 10, growth: null, pro: null };

/** Planner scenarios a store can keep; null = unlimited. */
export const SCENARIO_LIMIT: Record<PlanCode, number | null> = { free: 0, growth: 1, pro: null };

/** How often the money-at-stake numbers are recomputed. */
/**
 * How often money at stake (and the action list) is recomputed. Free: weekly — computed before
 * the Monday email (the first nightly compute of the store's ISO week, Monday morning), so
 * "this week" in the email is this week's numbers (it was monthly: month-old figures every
 * Monday). "monthly" stays readable on MoneyAtStake rows stored before.
 */
export type MoneyRefresh = "monthly" | "weekly" | "daily";
export const MONEY_REFRESH: Record<PlanCode, Exclude<MoneyRefresh, "monthly">> = { free: "weekly", growth: "daily", pro: "daily" };

export function hasFeature(plan: PlanCode, feature: Feature): boolean {
  return RANK[plan] >= RANK[FEATURE_PLAN[feature]];
}

export function requiredPlan(feature: Feature): PlanCode {
  return FEATURE_PLAN[feature];
}

export function featureMap(plan: PlanCode): Record<Feature, boolean> {
  const out = {} as Record<Feature, boolean>;
  for (const f of Object.keys(FEATURE_PLAN) as Feature[]) out[f] = hasFeature(plan, f);
  return out;
}

/** May this plan create one more scenario when `existing` are kept? */
export function canAddScenario(plan: PlanCode, existing: number): boolean {
  const limit = SCENARIO_LIMIT[plan];
  return limit == null || existing < limit;
}

/** The rows of a ranked list this plan may see. */
export function visibleRows<T>(plan: PlanCode, rows: T[]): T[] {
  const limit = ACTION_LIST_LIMIT[plan];
  return limit == null ? rows : rows.slice(0, limit);
}

export const PLAN_LABEL: Record<PlanCode, string> = { free: "Free", growth: "Growth", pro: "Pro" };

/**
 * Partner Dashboard plan handle → plan code. "growth", "growth-annual",
 * "keha_pro_plan" all map by word. Unknown handles return null.
 */
export function planCodeFromHandle(handle?: string | null): PlanCode | null {
  const words = String(handle ?? "").trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.includes("free")) return "free";
  if (words.includes("pro")) return "pro";
  if (words.includes("growth")) return "growth";
  return null;
}

/**
 * The plan the app applies to a store.
 *  - No subscription (the check succeeded and Shopify has no paid contract —
 *    never picked a plan, picked Free, or cancelled) → free.
 *  - Comped by Nova → pro.
 *  - Plan check off, unknown or failed → pro (fail open: an outage on our side
 *    never takes features away from a merchant).
 * ("none" is kept in the type for callers; it is no longer produced.)
 */
export function effectivePlan(input: {
  pricingConfigured: boolean;
  status: string | null | undefined;
  planCode: string | null | undefined;
  comped: boolean;
}): PlanCode | "none" {
  if (input.comped) return "pro";
  if (!input.pricingConfigured) return "pro";
  if (input.status === "NONE") return "free";
  if (input.status !== "ACTIVE" && input.status !== "TRIAL") return "pro";
  return planCodeFromHandle(input.planCode) ?? "pro";
}

/** Admin pages that need a plan (path prefix → feature; the longest prefix first). */
export const PAGE_FEATURE: { path: string; feature: Feature }[] = [
  { path: "/app/reorder/season", feature: "planner" },
  { path: "/app/reorder", feature: "reorderPlan" },
];

/**
 * The Order plan tabs (Order now · Next 13 weeks · Season plan · Open orders) and the supplier
 * order builder gate themselves: they keep the tab bar (the builder: its breadcrumb) and teach
 * inside the page with the store's own numbers (Free sees Order now as a read-only preview).
 * Everything else under PAGE_FEATURE (a purchase order page) shows the plan page instead.
 */
export const ORDER_PLAN_PATHS = ["/app/reorder", "/app/reorder/calendar", "/app/reorder/orders", "/app/reorder/season", "/app/reorder/build"] as const;

export function lockedPageFeature(pathname: string, plan: PlanCode | "none"): Feature | null {
  const p = plan === "none" ? "free" : plan;
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if ((ORDER_PLAN_PATHS as readonly string[]).includes(clean)) return null;
  const hit = PAGE_FEATURE.find((x) => pathname === x.path || pathname.startsWith(`${x.path}/`));
  return hit && !hasFeature(p, hit.feature) ? hit.feature : null;
}
