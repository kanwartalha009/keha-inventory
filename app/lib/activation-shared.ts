/**
 * First-session steps and their summary (/health). Pure.
 */
export const ACTIVATION_STEPS = ["installed", "plan_seen", "suggestions_seen", "first_po"] as const;
export type ActivationStep = (typeof ACTIVATION_STEPS)[number];

export type ActivationSummary = {
  /** Shops that reached each step. */
  shops: Record<ActivationStep, number>;
  /** Median minutes from install to the step (shops with both); null when none. */
  medianMinutesFromInstall: Record<Exclude<ActivationStep, "installed">, number | null>;
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
};

export function activationSummary(rows: readonly { shop: string; kind: string; at: Date }[]): ActivationSummary {
  const by = new Map<string, Map<string, Date>>();
  for (const r of rows) (by.get(r.shop) ?? by.set(r.shop, new Map()).get(r.shop)!).set(r.kind, r.at);
  const shops = Object.fromEntries(ACTIVATION_STEPS.map((k) => [k, 0])) as Record<ActivationStep, number>;
  const gaps: Record<Exclude<ActivationStep, "installed">, number[]> = { plan_seen: [], suggestions_seen: [], first_po: [] };
  for (const steps of by.values()) {
    for (const k of ACTIVATION_STEPS) if (steps.has(k)) shops[k]++;
    const installed = steps.get("installed");
    if (!installed) continue;
    for (const k of ["plan_seen", "suggestions_seen", "first_po"] as const) {
      const at = steps.get(k);
      if (at && at >= installed) gaps[k].push((at.getTime() - installed.getTime()) / 60_000);
    }
  }
  return {
    shops,
    medianMinutesFromInstall: { plan_seen: median(gaps.plan_seen), suggestions_seen: median(gaps.suggestions_seen), first_po: median(gaps.first_po) },
  };
}
