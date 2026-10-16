import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { confirmInstall } from "./lib/nova.server";
import { consumeReferral } from "./lib/referral.server";
import { cancelPendingPurge } from "./services/purge-stamp.server";
import { POLARIS_URL } from "./lib/polaris-shared";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // Must equal <AppProvider polarisUrl> (preload Link header for the same script).
  polarisUrl: POLARIS_URL,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    // Nova platform wiring: flip the Installation to ACTIVE + lock referral attribution on install.
    // Resilient — no-ops if NOVA_API is unset, never throws (won't block install).
    afterAuth: async ({ session }) => {
      // Reinstalled within 48h of an uninstall → cancel the pending GDPR purge,
      // which would otherwise wipe this shop's data (sessions included).
      await cancelPendingPurge(session.shop);
      // Consume the agency referral captured at /install (keyed by shop) → attribution.
      const ref = await consumeReferral(session.shop);
      await confirmInstall({
        shopDomain: session.shop,
        installedAt: new Date().toISOString(),
        ref: ref ?? undefined,
      });
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
