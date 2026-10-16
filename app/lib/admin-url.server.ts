/**
 * Top-level (non-embedded) entry points — email links, billing returns — must land the merchant back INSIDE the Shopify
 * admin, never on a bare app URL (which has no shop/host params and would show
 * the login form). Build the embedded URL the same way Shopify does:
 *   https://admin.shopify.com/store/<store-handle>/apps/<app-handle>/<path>
 */
// Matches `handle` in shopify.app.toml.
export const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || "keha-inventory";

export function storeHandle(shop: string): string {
  return shop.replace(/\.myshopify\.com$/i, "");
}

export function adminAppUrl(shop: string, path = "/app"): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `https://admin.shopify.com/store/${storeHandle(shop)}/apps/${APP_HANDLE}${p}`;
}

/**
 * Shopify-hosted plan selection page (Shopify App Pricing / managed pricing,
 * 2026-09-28): https://admin.shopify.com/store/<store>/charges/<app>/pricing_plans
 */
export function planSelectionUrl(shop: string): string {
  return `https://admin.shopify.com/store/${storeHandle(shop)}/charges/${APP_HANDLE}/pricing_plans`;
}
