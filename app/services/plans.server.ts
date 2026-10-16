/**
 * Plan catalog — the source of truth is the **Nova platform** (`AppPlan` rows,
 * editable in the Nova admin), so prices change without an app deploy. A
 * baked-in fallback (keep it in sync with the Nova seed) keeps the app working
 * if Nova is unreachable. Shopify App Pricing is what actually charges; this
 * catalog only feeds the Plans page.
 *
 * Contract: GET {NOVA_API}/v1/apps/inventory/plans
 *   → { plans: [{ code, name, amountMonthly, amountAnnual, currency, trialDays }] }
 *   (amounts in minor units)
 */
const NOVA_API = process.env.NOVA_API ?? "";
const APP_SLUG = "inventory";

export type Plan = {
  code: string; // free | growth | pro
  name: string;
  amountMonthly: number; // minor units (cents)
  amountAnnual: number; // minor units (cents) — yearly, 2 months free
  currency: string;
  trialDays: number;
};

// Spec §3: Free / Growth $49 / Pro $99, 14-day free trial, annual = 2 months
// free (10 × monthly). Which features each plan includes lives in
// app/lib/plan-shared.ts.
const FALLBACK: Plan[] = [
  { code: "free", name: "Free", amountMonthly: 0, amountAnnual: 0, currency: "USD", trialDays: 0 },
  { code: "growth", name: "Growth", amountMonthly: 4900, amountAnnual: 49000, currency: "USD", trialDays: 14 },
  { code: "pro", name: "Pro", amountMonthly: 9900, amountAnnual: 99000, currency: "USD", trialDays: 14 },
];

let cache: { at: number; plans: Plan[] } | null = null;
const TTL = 5 * 60 * 1000;

function normalize(p: Partial<Plan>): Plan | null {
  if (!p.code || !p.name) return null;
  const monthly = Number(p.amountMonthly ?? 0);
  return {
    code: String(p.code),
    name: String(p.name),
    amountMonthly: monthly,
    amountAnnual: Number(p.amountAnnual ?? monthly * 10),
    currency: String(p.currency ?? "USD"),
    trialDays: Number(p.trialDays ?? 0),
  };
}

export async function getPlans(): Promise<Plan[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.plans;
  if (NOVA_API) {
    try {
      const res = await fetch(`${NOVA_API}/v1/apps/${APP_SLUG}/plans`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const body = (await res.json()) as { plans?: Partial<Plan>[] };
        const fromNova = (body.plans ?? [])
          .map(normalize)
          .filter((p): p is Plan => p !== null);
        // Always the three plans, in order; a code Nova doesn't have keeps the fallback.
        const plans = FALLBACK.map((f) => fromNova.find((p) => p.code === f.code) ?? f);
        if (fromNova.length) {
          cache = { at: Date.now(), plans };
          return plans;
        }
      }
    } catch (e) {
      console.error("[plans] fetch from Nova failed; using fallback", e);
    }
  }
  cache = { at: Date.now(), plans: FALLBACK };
  return FALLBACK;
}

export async function getPlan(code: string): Promise<Plan | null> {
  const plans = await getPlans();
  return plans.find((p) => p.code === code) ?? FALLBACK.find((p) => p.code === code) ?? null;
}

// Per-store comp/discount from Nova (Installation.planOverride). Best-effort.
export type PlanOverride = { type: "NONE" | "FREE" | "PERCENT" | "FIXED"; value: number };

// Cached 10 min per shop, and the last good answer is kept when Nova is
// unreachable — a comped store must never be sent to the paid plan page (or
// lose its storefront) because Nova blinked (2026-09-28).
const overrideCache = new Map<string, { at: number; value: PlanOverride }>();
const OVERRIDE_TTL = 10 * 60 * 1000;

export async function getPlanOverride(shop: string): Promise<PlanOverride> {
  if (!NOVA_API) return { type: "NONE", value: 0 };
  const hit = overrideCache.get(shop);
  if (hit && Date.now() - hit.at < OVERRIDE_TTL) return hit.value;
  const fresh = await fetchPlanOverride(shop);
  if (fresh) {
    overrideCache.set(shop, { at: Date.now(), value: fresh });
    return fresh;
  }
  // Nova unreachable: keep the last good answer, and don't ask again for a
  // minute (this sits on the storefront path for stores without a paid plan).
  const fallback = hit?.value ?? { type: "NONE" as const, value: 0 };
  overrideCache.set(shop, { at: Date.now() - OVERRIDE_TTL + 60_000, value: fallback });
  return fallback;
}

async function fetchPlanOverride(shop: string): Promise<PlanOverride | null> {
  try {
    const res = await fetch(
      `${NOVA_API}/v1/apps/${APP_SLUG}/installations/${encodeURIComponent(shop)}/plan-override`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) },
    );
    if (res.ok) {
      const b = (await res.json()) as { type?: string; value?: number };
      const type =
        b.type === "FREE" || b.type === "PERCENT" || b.type === "FIXED" ? b.type : "NONE";
      return { type, value: Number(b.value ?? 0) };
    }
    // Nova answered "no such installation / no override" → a real NONE.
    if (res.status === 404) return { type: "NONE", value: 0 };
  } catch {
    /* unreachable — caller keeps the last good value */
  }
  return null;
}
