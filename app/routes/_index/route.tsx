import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { publicLandingUrl } from "../../lib/public-landing.server";

/**
 * App URL root. Shopify opens the app with ?shop=…&host=…, which goes straight
 * to /app (session token auth; not installed → Shopify install screen).
 * Without a shop there is nothing to authenticate, and requirement 2.3.1 bans
 * asking for the shop domain, so the visitor goes to the public app page.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  throw redirect(publicLandingUrl());
};
