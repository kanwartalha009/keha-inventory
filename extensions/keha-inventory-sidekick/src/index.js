/**
 * Keha Inventory Planner — Sidekick data tools (admin.app.tools.data).
 * Runs headless in Shopify's sandbox. Every tool is read-only: it fetches
 * /api/sidekick/<tool> on the app's own domain (relative URLs resolve against
 * the app URL, and Shopify adds the session token) and returns the JSON as is.
 * Tool names and inputs: ../tools.json. Server: app/routes/api.sidekick.$tool.tsx.
 */

const FAILED = { results: [], message: "Keha Inventory Planner could not load this right now." };

/** GET /api/sidekick/<tool>?<inputs>; empty inputs are left out. */
async function call(tool, input) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(input || {})) {
    if (value !== undefined && value !== null && String(value).trim() !== "") qs.set(key, String(value));
  }
  const query = qs.toString();
  try {
    const response = await fetch(`/api/sidekick/${tool}${query ? `?${query}` : ""}`);
    if (!response.ok) return FAILED;
    return await response.json();
  } catch {
    return FAILED;
  }
}

export default () => {
  shopify.tools.register("get_order_plan", async ({ supplier, within_days } = {}) => call("get_order_plan", { supplier, within_days }));
  shopify.tools.register("get_product_stock", async ({ query } = {}) => call("get_product_stock", { query }));
  shopify.tools.register("get_action_list", async ({ kind } = {}) => call("get_action_list", { kind }));
  shopify.tools.register("get_money_at_stake", async () => call("get_money_at_stake", {}));
  shopify.tools.register("get_purchase_orders", async ({ status, supplier } = {}) => call("get_purchase_orders", { status, supplier }));
  shopify.tools.register("get_forecast_accuracy", async ({ months } = {}) => call("get_forecast_accuracy", { months }));
};
