import { planCodeFromHandle as fromHandle } from "./plan-shared";

/**
 * Shopify App Pricing (managed pricing) — pure helpers, 2026-09-28.
 * Shared by app-pricing.server and its tests; no network or database here.
 */

/** The Partner API `activeSubscription` shape Keha Inventory reads. */
export type ActiveSubscription = {
  billingPeriod?: string | null; // EVERY_30_DAYS | ANNUAL
  cancelAtEndOfCycle?: boolean | null;
  trialEndsAt?: string | null;
  currentBillingCycle?: { startTime?: string | null; endTime?: string | null } | null;
  items?: {
    handle?: string | null;
    description?: string | null;
    price?: { __typename?: string; amount?: string | number | null; currency?: string | null } | null;
  }[] | null;
  legacySubscriptionId?: string | null;
};

export { PLAN_CODES } from "./plan-shared";

/**
 * Partner Dashboard plan handle → plan code (free / growth / pro). Handles
 * like "growth", "growth-annual" or "keha_pro_plan" map by word. Anything else
 * is kept as-is.
 */
export function planCodeFromHandle(handle?: string | null): string | null {
  const h = String(handle ?? "").trim().toLowerCase();
  if (!h) return null;
  return fromHandle(h) ?? h;
}

export type PlanState = {
  /** "active" = a plan (incl. trial), "none" = no plan picked, "unknown" = couldn't check. */
  state: "active" | "none" | "unknown";
  planCode: string | null;
  planName: string | null;
  interval: string | null;
  status: "ACTIVE" | "TRIAL" | "NONE" | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  amountMinor: number | null;
  currency: string | null;
  subscriptionRef: string | null;
};

export function toPlanState(sub: ActiveSubscription | null, now = new Date()): PlanState {
  if (!sub) {
    return {
      state: "none", planCode: null, planName: null, interval: null, status: "NONE",
      currentPeriodEnd: null, trialEndsAt: null, amountMinor: null, currency: null, subscriptionRef: null,
    };
  }
  const item = (sub.items ?? [])[0] ?? {};
  const trialEndsAt = sub.trialEndsAt ? new Date(sub.trialEndsAt) : null;
  const end = sub.currentBillingCycle?.endTime ? new Date(sub.currentBillingCycle.endTime) : null;
  const amount = item.price?.amount;
  return {
    state: "active",
    planCode: planCodeFromHandle(item.handle),
    planName: item.description || item.handle || null,
    interval: sub.billingPeriod ?? null,
    status: trialEndsAt && trialEndsAt > now ? "TRIAL" : "ACTIVE",
    currentPeriodEnd: end,
    trialEndsAt,
    amountMinor: amount == null || amount === "" ? null : Math.round(Number(amount) * 100),
    currency: item.price?.currency ?? null,
    subscriptionRef: sub.legacySubscriptionId || (item.handle ? `app-pricing:${item.handle}` : null),
  };
}

/** Did anything the merchant pays for change? (drives the Nova ledger forward) */
export function planChanged(
  prev: { planCode?: string | null; status?: string | null; currentPeriodEnd?: Date | null } | null,
  next: PlanState,
): boolean {
  if (!prev) return next.state !== "unknown";
  const t = (d?: Date | null) => (d ? d.getTime() : 0);
  return (
    (prev.planCode ?? null) !== next.planCode ||
    (prev.status ?? null) !== next.status ||
    t(prev.currentPeriodEnd) !== t(next.currentPeriodEnd)
  );
}
