/**
 * Where a visitor lands when they open the app outside Shopify with no shop
 * (2026-10-11). App Store requirement 2.3.1: the app must never ask a merchant
 * to type a myshopify.com URL, so there is no shop-entry form. Instead:
 *   - with ?shop=…  → /app?shop=… (installed: opens the app in the admin;
 *                     not installed: Shopify's install screen)
 *   - without shop  → this public page (the App Store listing once it is live)
 *
 *   INVENTORY_LISTING_URL  the Shopify App Store listing URL (optional)
 */
export const DEFAULT_PUBLIC_LANDING = "https://keha.io/inventory";

export function publicLandingUrl(opts: { ref?: string } = {}): string {
  const listing = (process.env.INVENTORY_LISTING_URL ?? "").trim();
  const base = /^https:\/\/\S+$/.test(listing) ? listing : DEFAULT_PUBLIC_LANDING;
  if (!opts.ref) return base;
  // Partner link → listing with the code in UTM (Keha's listing analytics join it to the install).
  const url = new URL(base);
  url.searchParams.set("utm_source", "partner");
  url.searchParams.set("utm_campaign", opts.ref);
  return url.toString();
}
