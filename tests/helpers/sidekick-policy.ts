/**
 * Shopify's Sidekick content policy as a lint (shopify.dev/docs/apps/build/sidekick,
 * "Content and safety policy"): no selling (upsells, plan-upgrade nudges, competitor
 * comparisons, false urgency, endorsements) and no instructions that redefine Sidekick
 * or steer its decisions. Used on the extension's texts and on tool responses.
 */
/**
 * Words and phrases Shopify's Sidekick content policy rules out (selling, urgency, overriding Sidekick).
 * "Inventory Planner" (Sage's app) is a competitor name; our own name "Keha Inventory Planner" is allowed.
 */
export const POLICY = [
  /\bupgrad/i,
  /\bpremium\b/i,
  /\bsubscri/i,
  /\b(free|growth|pro|paid) plan\b/i,
  /\bpricing\b/i,
  /\bunlock/i,
  /\bthe best\b|\bbest (app|tool|solution|choice|in class)\b/i,
  /#1|\bnumber one\b/i,
  /\blimited[- ]time\b|\bhurry\b|\bact now\b|\bdon'?t miss\b|\blast chance\b/i,
  /\bexclusive\b|\bguarantee/i,
  /\bignore (all|any|previous|other)\b|\byou are sidekick\b|\binstead of sidekick\b|\bonly (use|trust) (this|keha)\b|\bdo not use other\b/i,
  /\b((?<!keha )inventory planner|prediko|stocky|cogsy|fabrikator|genie|sumtracker|katana|brightpearl|stockie)\b/i,
];

export function policyViolations(text: string): string[] {
  return POLICY.filter((re) => re.test(text)).map((re) => `${re} in: ${text.slice(0, 120)}`);
}

