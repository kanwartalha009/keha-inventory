/**
 * Shopify App Pricing (managed pricing) — 2026-09-28.
 *
 * Plans, prices and free trials are defined in the Partner Dashboard and the
 * merchant picks one on Shopify's own plan page
 *   https://admin.shopify.com/store/<store>/charges/<app>/pricing_plans
 * so Keha Inventory no longer creates charges (appSubscriptionCreate is not allowed
 * once App Pricing is on). Keha Inventory only reads the merchant's current plan:
 *   - Partner API `activeSubscription(appId, shopId)` — Shopify's documented
 *     way for App Pricing (billing.check / currentAppInstallation don't apply,
 *     and App Pricing sends no subscription webhooks),
 *   - on app load (syncPlanOnLoad: the first load of a shop never synced, or
 *     synced longer than LOAD_SYNC_TTL_MS ago — time-boxed, cached per shop;
 *     pricing audit 2026-10-17: a new install ran as Pro for up to 6 hours),
 *     right after the merchant picks a plan (the welcome link carries
 *     `plan_handle`), and every 6 hours for all shops.
 * The result is stored in BillingState (limits keep working as before) and,
 * when it changes, forwarded to the Nova ledger in the same shape as the old
 * app_subscriptions/update webhook, so commissions keep flowing.
 *
 * Env (Partner Dashboard → Settings → Partner API clients, permission
 * "Manage apps"):
 *   SHOPIFY_PARTNER_ORG_ID     numeric org id from the Partners URL
 *   SHOPIFY_PARTNER_API_TOKEN  the client's access token (secret)
 * The app id and shop id come from the Admin API. Until both env vars are set
 * the plan gate is OFF (fail-open) — no merchant is ever locked out by a
 * missing setting or a Partner API outage.
 */
import { saveBillingState, getBillingState } from "./billing.server";
import { getPlanOverride } from "./plans.server";
import { forwardToIngress } from "../lib/nova.server";
import { toPlanState, planChanged, type ActiveSubscription, type PlanState } from "../lib/pricing-shared";

const PARTNER_API_VERSION = "2026-07";
const ACTIVE_TTL_MS = 30 * 60 * 1000; // a paying shop is re-checked every 30 min
const UNKNOWN_TTL_MS = 5 * 60 * 1000; // after an error, fail open for 5 min

type AdminGraphql = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

/** Partner org id: SHOPIFY_PARTNER_ORG_ID, or the SHOPIFY_ORG_ID Railway already has. */
function partnerOrgId(): string {
  return process.env.SHOPIFY_PARTNER_ORG_ID || process.env.SHOPIFY_ORG_ID || "";
}

export function pricingConfigured(): boolean {
  return Boolean(partnerOrgId() && process.env.SHOPIFY_PARTNER_API_TOKEN);
}

// ---- ids (Admin API) ----
const idCache = new Map<string, { shopId: string; appId: string }>();
const IDS = `#graphql
  query KehaInvPricingIds { shop { id } currentAppInstallation { app { id } } }`;

async function ids(admin: AdminGraphql, shop: string): Promise<{ shopId: string; appId: string } | null> {
  const hit = idCache.get(shop);
  if (hit) return hit;
  const res = await admin.graphql(IDS);
  const body = (await res.json()) as {
    data?: { shop?: { id?: string }; currentAppInstallation?: { app?: { id?: string } } };
  };
  const shopId = body.data?.shop?.id;
  const appId = process.env.SHOPIFY_APP_GID || body.data?.currentAppInstallation?.app?.id;
  if (!shopId || !appId) return null;
  const v = { shopId, appId };
  idCache.set(shop, v);
  return v;
}

// ---- Partner API ----
const ACTIVE_SUBSCRIPTION = `query KehaInvActiveSubscription($appId: ID!, $shopId: ID!) {
  activeSubscription(appId: $appId, shopId: $shopId) {
    billingPeriod
    cancelAtEndOfCycle
    trialEndsAt
    currentBillingCycle { startTime endTime }
    items { handle description price { __typename ... on FlatRatePrice { amount currency } } }
    legacySubscriptionId
  }
}`;

export async function fetchActiveSubscription(appId: string, shopId: string): Promise<ActiveSubscription | null> {
  const org = partnerOrgId();
  const res = await fetch(`https://partners.shopify.com/${org}/api/${PARTNER_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": process.env.SHOPIFY_PARTNER_API_TOKEN ?? "",
    },
    body: JSON.stringify({ query: ACTIVE_SUBSCRIPTION, variables: { appId, shopId } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`partner_api_${res.status}`);
  const body = (await res.json()) as {
    data?: { activeSubscription?: ActiveSubscription | null };
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(`partner_api: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.data?.activeSubscription ?? null;
}

// ---- health (2026-10-13) ----
// App Store review (1.2.2 / 1.2.3) failed because the Partner API credentials
// were never set, so every plan change showed "Plan not checked yet". /health
// now reports whether plan checks are configured and working.
const pricingHealth: { lastOkAt: string | null; lastErrorAt: string | null; lastError: string | null } = {
  lastOkAt: null,
  lastErrorAt: null,
  lastError: null,
};
export function pricingStatus() {
  return { configured: pricingConfigured(), ...pricingHealth };
}

// ---- sync ----
const stateCache = new Map<string, { at: number; value: PlanState }>();

const UNKNOWN: PlanState = {
  state: "unknown", planCode: null, planName: null, interval: null, status: null,
  currentPeriodEnd: null, trialEndsAt: null, amountMinor: null, currency: null, subscriptionRef: null,
};

/**
 * The shop's current plan, refreshed from the Partner API when the cache is
 * stale (or `force`). Never throws: errors give state "unknown" (fail open).
 */
let warnedUnconfigured = false;
export async function syncPlan(
  admin: AdminGraphql,
  shop: string,
  opts: { force?: boolean } = {},
): Promise<PlanState> {
  if (!pricingConfigured()) {
    if (!warnedUnconfigured) {
      console.error("[app-pricing] SHOPIFY_PARTNER_API_TOKEN (and SHOPIFY_PARTNER_ORG_ID or SHOPIFY_ORG_ID) not set — plan changes can't be read (shows \"Plan not checked yet\")");
      warnedUnconfigured = true;
    }
    return UNKNOWN;
  }
  const hit = stateCache.get(shop);
  if (!opts.force && hit) {
    const ttl = hit.value.state === "active" ? ACTIVE_TTL_MS : hit.value.state === "unknown" ? UNKNOWN_TTL_MS : 0;
    if (Date.now() - hit.at < ttl) return hit.value;
  }
  try {
    const id = await ids(admin, shop);
    if (!id) throw new Error("ids_unavailable");
    const next = toPlanState(await fetchActiveSubscription(id.appId, id.shopId));
    const prev = await getBillingState(shop);
    await saveBillingState(shop, {
      planCode: next.planCode,
      interval: next.interval,
      status: next.status,
      // Keep the last subscription reference after a cancellation (audit trail).
      subscriptionId: next.subscriptionRef ?? prev?.subscriptionId ?? null,
      currentPeriodEnd: next.currentPeriodEnd,
    });
    const wasPaying = prev?.status === "ACTIVE" || prev?.status === "TRIAL";
    if (planChanged(prev, next) && (next.state === "active" || wasPaying)) {
      // A cancellation carries no subscription of its own — close the one Nova knows.
      const forNova = next.state === "active" ? next : { ...next, subscriptionRef: prev?.subscriptionId ?? null };
      await forwardPlanToNova(shop, forNova);
    }
    stateCache.set(shop, { at: Date.now(), value: next });
    pricingHealth.lastOkAt = new Date().toISOString();
    return next;
  } catch (e) {
    console.error("[app-pricing] plan check failed", shop, e);
    pricingHealth.lastErrorAt = new Date().toISOString();
    // Only the error code (e.g. partner_api_401), never response bodies.
    pricingHealth.lastError = String((e as Error)?.message ?? e).slice(0, 80);
    stateCache.set(shop, { at: Date.now(), value: UNKNOWN });
    return UNKNOWN;
  }
}

/** Nova ledger: same topic + `_nova` enrichment the Billing API webhook used to carry. */
async function forwardPlanToNova(shop: string, p: PlanState): Promise<void> {
  const status = p.state === "active" ? "ACTIVE" : "CANCELLED";
  const end = p.currentPeriodEnd ? p.currentPeriodEnd.toISOString() : null;
  await forwardToIngress({
    topic: "app_subscriptions/update",
    shopDomain: shop,
    // Stable per change, so Nova's dedupe treats a re-sync as the same event.
    webhookId: `inventory-app-pricing:${shop}:${p.planCode ?? "none"}:${p.status ?? ""}:${end ?? ""}`,
    payload: {
      source: "shopify_app_pricing",
      app_subscription: {
        admin_graphql_api_id: p.subscriptionRef,
        name: p.planName ? `Keha Inventory — ${p.planName}` : null,
        status,
        current_period_end: end,
      },
      _nova: {
        subscriptionId: p.subscriptionRef,
        status,
        amountMinor: p.status === "TRIAL" ? 0 : p.amountMinor,
        currencyCode: p.currency,
        currentPeriodEnd: end,
        planName: p.planName,
      },
    },
  });
}

/**
 * Should this request be sent to Shopify's plan page? Only when App Pricing is
 * configured, the check succeeded, the shop has no plan, and Nova hasn't comped it.
 */
export async function needsPlan(admin: AdminGraphql, shop: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const p = await syncPlan(admin, shop, opts);
  if (p.state !== "none") return false;
  const override = await getPlanOverride(shop);
  return override.type !== "FREE";
}

// ---- on app load (pricing audit 2026-10-17) ----

/** A plan synced within this long (any path: load, plan page, the 6-hourly run) is trusted. */
export const LOAD_SYNC_TTL_MS = 6 * 60 * 60 * 1000;
/** The admin waits at most this long for the check; slower answers land in the background. */
export const LOAD_SYNC_TIMEOUT_MS = 2500;
/** shop → when the load check last succeeded (or, after a failure, when to count it fresh from). */
const loadChecked = new Map<string, number>();
const loadInflight = new Map<string, Promise<PlanState>>();

/**
 * The admin layout's plan check. A shop never synced (no BillingState) or synced longer than
 * LOAD_SYNC_TTL_MS ago is synced once, so a new install is on Free from its first page instead of
 * failing open to Pro until the 6-hourly run. Time-boxed (`timeoutMs`): a slow Partner API never
 * holds the admin — it fails open meanwhile and the answer is saved when it comes. A failed check
 * (API down) fails open and is retried after UNKNOWN_TTL_MS, not on every navigation. Never throws.
 */
export async function syncPlanOnLoad(
  admin: AdminGraphql,
  shop: string,
  opts: { timeoutMs?: number } = {},
): Promise<"off" | "fresh" | "synced" | "timeout" | "failed"> {
  if (!pricingConfigured()) return "off";
  const now = Date.now();
  const at = loadChecked.get(shop);
  if (at !== undefined && now - at < LOAD_SYNC_TTL_MS) return "fresh";
  try {
    const bs = (await getBillingState(shop)) as { updatedAt?: Date | string | null } | null;
    const last = bs?.updatedAt ? new Date(bs.updatedAt).getTime() : NaN;
    if (Number.isFinite(last) && now - last < LOAD_SYNC_TTL_MS) {
      loadChecked.set(shop, last);
      return "fresh";
    }
  } catch {
    /* no row read: check with the Partner API below */
  }
  let p = loadInflight.get(shop);
  if (!p) {
    p = syncPlan(admin, shop, { force: true }).finally(() => loadInflight.delete(shop));
    loadInflight.set(shop, p);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), opts.timeoutMs ?? LOAD_SYNC_TIMEOUT_MS);
  });
  const result = await Promise.race([p, timedOut]);
  if (timer) clearTimeout(timer);
  if (result === "timeout") return "timeout";
  if (result.state === "unknown") {
    // Retry after UNKNOWN_TTL_MS (fail open meanwhile), not on every navigation.
    loadChecked.set(shop, Date.now() - LOAD_SYNC_TTL_MS + UNKNOWN_TTL_MS);
    return "failed";
  }
  loadChecked.set(shop, Date.now());
  return "synced";
}

/** Clear the cache for a shop (e.g. after uninstall). */
export function forgetPlan(shop: string): void {
  stateCache.delete(shop);
  idCache.delete(shop);
  loadChecked.delete(shop);
}

/**
 * Every installed shop, re-checked (scheduler, every 6 h): App Pricing sends no
 * webhooks, so this is how cancellations and plan changes made outside the app
 * reach BillingState and the Nova ledger. Spaced out to stay polite to the
 * Partner API (~1,000 shops ≈ 5 minutes).
 */
export async function syncAllPlans(
  shops: string[],
  getAdmin: (shop: string) => Promise<AdminGraphql>,
  gapMs = 300,
): Promise<{ checked: number; active: number; none: number; unknown: number }> {
  const out = { checked: 0, active: 0, none: 0, unknown: 0 };
  if (!pricingConfigured()) return out;
  for (const shop of shops) {
    try {
      const p = await syncPlan(await getAdmin(shop), shop, { force: true });
      out.checked++;
      out[p.state]++;
    } catch (e) {
      out.unknown++;
      console.error("[app-pricing] sync failed", shop, e);
    }
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
  return out;
}
