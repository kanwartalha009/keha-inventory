/**
 * What a store's plan allows (Free / Growth / Pro — app/lib/plan-shared.ts).
 * The plan comes from BillingState (synced from Shopify App Pricing by
 * app-pricing.server); Nova comps count as Pro; any unknown state fails open.
 * Runs on every admin navigation and save action: one BillingState row read.
 */
import { getBillingState } from "./billing.server";
import { getPlanOverride } from "./plans.server";
import { pricingConfigured } from "./app-pricing.server";
import {
  effectivePlan,
  featureMap,
  hasFeature,
  requiredPlan,
  type Feature,
  type PlanCode,
} from "../lib/plan-shared";

export type Entitlements = {
  /** "none" = must pick a plan on Shopify's page; features follow Free. */
  plan: PlanCode | "none";
  features: Record<Feature, boolean>;
  comped: boolean;
  /** The plan came from a real check (false = check off or failed → fail open). */
  checked: boolean;
};

// The plan is read from BillingState on every call (one indexed row, so a
// plan change made by app-pricing.server applies at once). Nova's comp
// override is only needed when there is no paid plan, and is cached there.
export async function getEntitlements(shop: string): Promise<Entitlements> {
  const bs = await getBillingState(shop);
  const paying = bs?.status === "ACTIVE" || bs?.status === "TRIAL";
  const comped = paying ? false : (await getPlanOverride(shop)).type === "FREE";
  const plan = effectivePlan({
    pricingConfigured: pricingConfigured(),
    status: bs?.status,
    planCode: bs?.planCode,
    comped,
  });
  return {
    plan,
    features: featureMap(plan === "none" ? "free" : plan),
    comped,
    checked: pricingConfigured() && (paying || bs?.status === "NONE"),
  };
}

/** Kept for callers: entitlements are no longer cached here. */
export function forgetEntitlements(_shop: string): void {}

export async function can(shop: string, feature: Feature): Promise<boolean> {
  const e = await getEntitlements(shop);
  return hasFeature(e.plan === "none" ? "free" : e.plan, feature);
}

/** The JSON an action returns when a feature needs a higher plan. */
export function upgradeResponse(feature: Feature, message: string) {
  return Response.json(
    { ok: false, error: message, upgrade: { feature, plan: requiredPlan(feature) } },
    { status: 403 },
  );
}

/** The plan to apply ("none" counts as Free). */
export async function planFor(shop: string): Promise<PlanCode> {
  const e = await getEntitlements(shop);
  return e.plan === "none" ? "free" : e.plan;
}
