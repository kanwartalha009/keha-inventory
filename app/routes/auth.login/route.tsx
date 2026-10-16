import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { login } from "../../shopify.server";
import { publicLandingUrl } from "../../lib/public-landing.server";

/**
 * The library sends requests here when it has no session and no shop.
 * No shop-entry form (App Store requirement 2.3.1): a valid ?shop= starts
 * OAuth via login(); anything else goes to the public app page.
 */
async function handle(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    // Throws the redirect into OAuth when the shop is valid; returns errors otherwise.
    await login(request);
  }
  throw redirect(publicLandingUrl());
}

export const loader = async ({ request }: LoaderFunctionArgs) => handle(request);
export const action = async ({ request }: ActionFunctionArgs) => handle(request);
