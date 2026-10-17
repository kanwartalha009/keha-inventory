/**
 * The plan comparison (spec §3). One list, used by the Plans page. The order plan leads
 * (marketing audit 2026-10-17): its group is first and the plan cards open with it. Pure data,
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
    title: "Order plan",
    rows: [
      {
        label: "What to order, how much and by when",
        hint: "Free shows your 10 most urgent products, read only.",
        values: { free: "Order plan preview (top 10)", growth: "All", pro: "All" },
      },
      { label: "Days of stock left and suggested order quantity per variant", feature: "forecast" },
      { label: "Order plan by supplier, with order-by dates", feature: "reorderPlan" },
      { label: "13-week order calendar", hint: "Every order for the next 13 weeks, by week and supplier, with the cash you need each week.", feature: "orderCalendar" },
      { label: "Suppliers with lead times, minimum orders and case packs", feature: "suppliers" },
      { label: "Purchase orders as PDF, CSV or email", feature: "poExport" },
      { label: "Supplier confirms the ship date through a link", feature: "supplierConfirm" },
      { label: "Export the products table to CSV", feature: "csvExport" },
    ],
  },
  {
    title: "Money at stake",
    rows: [
      {
        label: "Sales at risk, sales lost to sell-outs, cash stuck and sold-out page visits",
        hint: "Four numbers in your store's currency, each showing how we got it.",
        values: ALL,
      },
      { label: "How often the numbers refresh", values: { free: "Weekly", growth: "Daily", pro: "Daily" } },
    ],
  },
  {
    title: "Weekly actions",
    rows: [
      { label: "Ranked list of what to reorder, promote, fix and clear", values: { free: "Top 10", growth: "All", pro: "All" } },
      { label: "Monday email", hint: "On by default, to the store owner.", values: { free: "Top 10", growth: "Full", pro: "Full" } },
      { label: "Missing sizes, weak product pages, high returns and falling best sellers", feature: "fixDetails", hint: "Free shows how many there are." },
      // Pricing audit 2026-10-17: without a preorder app this is the back-in-stock how-to — say that, no preorder promise.
      { label: "What to do while a best seller is sold out", hint: "Until its stock arrives: how to collect back-in-stock sign-ups on the product page.", feature: "bridge" },
      { label: "Clear dead stock with a Shopify discount", feature: "clearance", hint: "Nothing changes in your store until you confirm." },
    ],
  },
  {
    title: "Planning",
    rows: [
      { label: "Season plan scenarios with cash needed per week", values: { free: false, growth: "1 scenario", pro: "Unlimited" } },
      { label: "Revenue goals per collection", feature: "collectionGoals" },
      { label: "Forecast accuracy, shown every month", feature: "accuracy" },
    ],
  },
  {
    title: "Locations and stores",
    rows: [
      { label: "Planning per location and per POS store", hint: "Free and Growth count the stock of all your locations together. Pro plans each warehouse and store on its own.", feature: "locations" },
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
  free: "Your 10 most urgent products and the money at stake.",
  growth: "Plan every order by supplier and send purchase orders.",
  pro: "Plan each warehouse and POS store, and move stock between them.",
};
export const PLAN_POINTS: Record<PlanCode, string[]> = {
  free: [
    "Order plan preview (top 10)",
    "Sales at risk, sales lost to sell-outs, cash stuck and sold-out page visits",
    "Numbers refreshed weekly",
    "Top 10 actions and a Monday email",
  ],
  growth: [
    "Full order plan by supplier, with purchase orders",
    "13-week order calendar with cash per week",
    "Numbers refreshed daily, and every action",
    "What to do while a best seller is sold out, and dead-stock discounts",
    "Season plan (1 scenario) and forecast accuracy",
    "Slack and Shopify Flow",
  ],
  pro: [
    "Planning per location and per POS store",
    "Transfers from warehouse to stores, created in Shopify",
    "Unlimited Season plan scenarios",
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
