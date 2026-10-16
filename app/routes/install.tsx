import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { storeReferral } from "../lib/referral.server";
import { publicLandingUrl } from "../lib/public-landing.server";

/**
 * Partner link landing (Keha partner program).
 *
 *   https://<app-url>/install?ref=<referralCode>[&shop=<merchant>.myshopify.com]
 *
 * Installs must start on a Shopify surface (App Store requirement 2.3.1), so this never starts
 * OAuth itself: it forwards to the App Store listing with the code in UTM parameters. When the
 * partner also passed the shop, the code is stored against it first; afterAuth sends it to the
 * Keha platform when that shop installs, which attributes the store to the partner.
 * Without a matching code the install is organic (the platform's house agency).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const ref = url.searchParams.get("ref")?.trim();
  const shop = url.searchParams.get("shop")?.trim().toLowerCase();

  if (ref && shop && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) await storeReferral(shop, ref);
  throw redirect(publicLandingUrl({ ref: ref || undefined }));
};
