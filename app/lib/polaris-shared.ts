/**
 * Polaris web components script — ONE value shared by `<AppProvider
 * polarisUrl>` (app/routes/app.tsx) and `shopifyApp({ polarisUrl })`
 * (app/shopify.server.ts, preload Link header); Shopify requires both to match.
 *
 * 2026-10-09 (Kanwar's decision): Polaris 2 release candidate, so the app
 * renders the admin's new look (ShopifyInter type, new weights) like Shopify's
 * own pages. Keep `@shopify/polaris-types` on the matching `2.0.0-rc.*`; move
 * both to the stable 2.x URL/package together when 2.0 leaves RC.
 */
export const POLARIS_URL = "https://cdn.shopify.com/shopifycloud/polaris-2.0-rc.js";
