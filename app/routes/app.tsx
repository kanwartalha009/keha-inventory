import type { HeadersFunction, LinksFunction, LoaderFunctionArgs } from "react-router";
import { POLARIS_URL } from "../lib/polaris-shared";
import appStyles from "../app.css?url";
import { Outlet, useLoaderData, useLocation, useNavigation, useRouteError } from "react-router";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { pricingConfigured, syncPlan } from "../services/app-pricing.server";
import { forgetEntitlements, getEntitlements } from "../services/entitlements.server";
import { readShopLocale } from "../services/shop-locale.server";
import { lockedPageFeature, type PlanCode } from "../lib/plan-shared";
import { LockedPage } from "../components/plan";
import {
  LocaleProvider,
  toSupportedLocale,
  useLocale,
  type Locale,
} from "../lib/i18n";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: appStyles }];

// Polaris web components take their chrome strings (modal close, pagination…)
// from the admin's own locale, so no per-locale bundle ships with the app.

// Store locale is stable — one Admin API round-trip per shop per hour, not one
// per navigation (this loader runs on EVERY client-side transition).
const LOCALE_TTL_MS = 60 * 60 * 1000;
const localeCache = new Map<string, { locale: Locale; at: number }>();


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Shopify App Pricing: a store without a paid plan is simply on Free, so
  // nobody is bounced to the plan page (that also avoids a loop if Shopify
  // creates no contract for a $0 plan). Coming back from the plan page
  // (`plan_handle`) re-checks straight away.
  if (pricingConfigured()) {
    const url = new URL(request.url);
    if (url.searchParams.has("plan_handle")) {
      await syncPlan(admin, session.shop, { force: true });
      forgetEntitlements(session.shop);
    }
  }

  // Default admin language (a manual choice in Settings still wins):
  //   1. the staff member's Shopify admin language — Shopify adds `locale` to
  //      the embedded app URL — so a Spanish-speaking merchant sees Spanish;
  //   2. otherwise the store's primary language (`shopLocales`; there is no
  //      `shop.primaryLocale` field), cached per shop — failures too, so a
  //      broken lookup isn't retried on every page.
  let storeLocale: Locale = "en";
  const staffLocale = new URL(request.url).searchParams.get("locale");
  const cached = localeCache.get(session.shop);
  if (staffLocale) {
    storeLocale = toSupportedLocale(staffLocale);
  } else if (cached && Date.now() - cached.at < LOCALE_TTL_MS) {
    storeLocale = cached.locale;
  } else {
    // Never throws: locale detection must not block the admin (no read_locales → English).
    storeLocale = toSupportedLocale(await readShopLocale(admin, session.shop));
    localeCache.set(session.shop, { locale: storeLocale, at: Date.now() });
  }

  // Plan (Free / Growth / Pro): pages a plan doesn't include show what they do
  // and an Upgrade button instead (Content below).
  const { plan } = await getEntitlements(session.shop);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", storeLocale, plan };
};

/**
 * Navigation feedback: the admin's own top loading bar (App Bridge
 * `shopify.loading`) while a loader / action is in flight, and the page
 * content softens slightly so the merchant sees the click registered.
 * Nothing fake, nothing flashy.
 */
function useBusy(): boolean {
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const busy = navigation.state !== "idle";
  useEffect(() => {
    try {
      shopify.loading(busy);
    } catch {
      /* outside the admin (tests, previews) */
    }
    return () => {
      try {
        shopify.loading(false);
      } catch {
        /* noop */
      }
    };
  }, [busy, shopify]);
  return busy;
}

function Content({ plan }: { plan: PlanCode | "none" }) {
  const busy = useBusy();
  const { pathname } = useLocation();
  const locked = lockedPageFeature(pathname, plan);
  return (
    <div className={"keha-content" + (busy ? " keha-content--busy" : "")} aria-busy={busy || undefined}>
      {locked ? <LockedPage feature={locked} /> : <Outlet />}
    </div>
  );
}

function AppNav() {
  const { t } = useLocale();
  // Kanwar 2026-10-17: Dashboard · Order plan · Products · Settings · Plans. "Order plan" holds
  // the tabs Order now (/app/reorder), Next 90 days, Season plan (/app/planner) and Open orders.
  // Highlighting is App Bridge's (by URL path): the /app/reorder/* tabs share the link's path;
  // Season plan keeps its old /app/planner URL (links already point at it), so the admin may not
  // highlight "Order plan" there — not verifiable outside the admin.
  return (
    <s-app-nav>
      <s-link href="/app">{t("Dashboard")}</s-link>
      <s-link href="/app/reorder">{t("Order plan")}</s-link>
      <s-link href="/app/products">{t("Products")}</s-link>
      <s-link href="/app/settings">{t("Settings")}</s-link>
      <s-link href="/app/plans">{t("Plans")}</s-link>
    </s-app-nav>
  );
}

export default function App() {
  const { apiKey, storeLocale, plan } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey} polarisUrl={POLARIS_URL}>
      <LocaleProvider defaultLocale={storeLocale}>
        <AppNav />
        <Content plan={plan} />
      </LocaleProvider>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
