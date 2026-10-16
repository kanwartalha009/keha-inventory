/**
 * The plan comparison (spec §3). One list, used by the Plans page. Pure data,
 * client-safe.
 *
 * A row that maps to a paid feature reads the plan from FEATURE_PLAN, so the
 * table can never promise something the gates don't allow. Text cells are
 * English and go through t() like every other string.
 */
import { FEATURE_PLAN, PLAN_CODES, hasFeature, type Feature, type PlanCode } from "./plan-shared";

export type Cell = boolean | string;

export type MatrixRow = {
  label: string;
  /** Short explanation under the label. */
  hint?: string;
  /** Derived from the gate (true from that plan up). */
  feature?: Feature;
  /** Fixed values, for rows that aren't a gate (or are on every plan). */
  values?: Record<PlanCode, Cell>;
};

export type MatrixGroup = { title: string; rows: MatrixRow[] };

const ALL: Record<PlanCode, Cell> = { free: true, growth: true, pro: true };

export const PLAN_MATRIX: MatrixGroup[] = [
  {
    title: "Money at stake",
    rows: [
      {
        label: "Sales at risk, sales lost to sell-outs, cash stuck and sold-out page visits",
        hint: "Four numbers in your store's currency, each showing how we got it.",
        values: ALL,
      },
      { label: "How often the numbers refresh", values: { free: "Monthly", growth: "Daily", pro: "Daily" } },
    ],
  },
  {
    title: "Weekly actions",
    rows: [
      { label: "Ranked list of what to reorder, push, fix and clear", values: { free: "Top 10", growth: "All", pro: "All" } },
      { label: "Monday email", hint: "On by default, to the store owner.", values: { free: "Top 10", growth: "Full", pro: "Full" } },
      { label: "Missing sizes, weak product pages, high returns and falling best sellers", feature: "fixDetails", hint: "Free shows how many there are." },
      { label: "Take preorders or collect sign-ups before stock arrives", feature: "bridge" },
      { label: "Clear dead stock with a Shopify discount", feature: "clearance", hint: "Nothing changes in your store until you confirm." },
    ],
  },
  {
    title: "Reorder",
    rows: [
      { label: "Days of stock left and suggested order quantity per variant", feature: "forecast" },
      { label: "Reorder plan by supplier, with order-by dates", feature: "reorderPlan" },
      { label: "Suppliers with lead times, minimum orders and case packs", feature: "suppliers" },
      { label: "Purchase orders as PDF, CSV or email", feature: "poExport" },
      { label: "Supplier confirms the ship date through a link", feature: "supplierConfirm" },
      { label: "Export the products table to CSV", feature: "csvExport" },
    ],
  },
  {
    title: "Planning",
    rows: [
      { label: "Season and growth planner with cash needed per week", values: { free: false, growth: "1 scenario", pro: "Unlimited" } },
      { label: "Revenue goals per collection", feature: "collectionGoals" },
      { label: "Forecast accuracy, shown every month", feature: "accuracy" },
    ],
  },
  {
    title: "Locations and stores",
    rows: [
      { label: "Planning per location and per POS store", hint: "Free and Growth plan all your stock as one pool.", feature: "locations" },
      { label: "Transfer plan from warehouse to stores, created in Shopify", feature: "transfers" },
    ],
  },
  {
    title: "Alerts and support",
    rows: [
      { label: "Slack messages", feature: "slack" },
      { label: "Shopify Flow triggers", feature: "flowTriggers" },
      { label: "The app in your language", hint: "English, Spanish, French, German, Italian, Portuguese, Dutch and Polish.", values: ALL },
      { label: "Email support from the people who build the app", values: ALL },
    ],
  },
];

/** Who each plan is for, and what it adds on top of the plan before it. */
export const PLAN_PITCH: Record<PlanCode, string> = {
  free: "See the money your stock is costing you.",
  growth: "Get the full weekly to-do list and act on it.",
  pro: "Plan stock per warehouse and per store.",
};
export const PLAN_POINTS: Record<PlanCode, string[]> = {
  free: [
    "Sales at risk, sales lost to sell-outs, cash stuck and sold-out page visits",
    "Numbers refreshed monthly",
    "Top 10 actions and a Monday email",
  ],
  growth: [
    "Numbers refreshed daily, and every action",
    "Reorder plan with suppliers and purchase orders",
    "Preorder bridge and dead-stock discounts",
    "Season planner (1 scenario) and forecast accuracy",
    "Slack and Shopify Flow",
  ],
  pro: [
    "Planning per location and per POS store",
    "Transfers from warehouse to stores, created in Shopify",
    "Unlimited planner scenarios",
  ],
};
export const INHERITS: Record<PlanCode, string | null> = { free: null, growth: "Everything in Free, plus:", pro: "Everything in Growth, plus:" };

export function cellFor(row: MatrixRow, plan: PlanCode): Cell {
  if (row.feature) return hasFeature(plan, row.feature);
  return row.values?.[plan] ?? false;
}

/** Every gated feature that is shown as its own row (tests hold this). */
export function matrixFeatures(): Set<Feature> {
  const out = new Set<Feature>();
  for (const g of PLAN_MATRIX) for (const r of g.rows) if (r.feature) out.add(r.feature);
  return out;
}

/**
 * Features expressed as a limit row instead of their own yes/no row
 * (dailyRefresh → "How often the numbers refresh", fullActionList → the
 * Top 10 rows, planner → the scenario row).
 */
export const FEATURES_AS_LIMITS: Feature[] = ["dailyRefresh", "fullActionList", "planner"];

export const MATRIX_PLANS = PLAN_CODES;
export { FEATURE_PLAN };
