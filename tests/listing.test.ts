/**
 * App Store listing kit (docs/listing/LISTING.md, task 2.7; playbook §8, mistakes #14, #18):
 *  - the name equals shopify.app.toml `name` and fits 30 characters;
 *  - subtitle ≤ 60, introduction ≤ 100, details ≤ 500, each feature ≤ 80 (5 features, up to 3
 *    optional extras, 8 in all), ≤ 5 search terms;
 *  - no prices, statistics, guarantees, "AI", "the first" / "the only", plan names or other Keha
 *    apps in the text (marketing audit 2026-10-17; App Store rules 4.3.3, 4.4);
 *  - the pricing table equals the plan catalog, and the plan-card lines equal PLAN_POINTS.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN_POINTS } from "../app/lib/plan-matrix";
import { PLAN_CODES, PLAN_LABEL } from "../app/lib/plan-shared";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const listing = read("docs/listing/LISTING.md");

/** The ```text block under `## <heading>`. */
function field(heading: string): string {
  const at = listing.indexOf(`\n## ${heading}\n`);
  expect(at, `section "${heading}"`).toBeGreaterThanOrEqual(0);
  const rest = listing.slice(at);
  const m = rest.match(/```text\n([\s\S]*?)\n```/);
  expect(m, `text block under "${heading}"`).not.toBeNull();
  return m![1];
}
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

const LIMITS = { name: 30, subtitle: 60, intro: 100, details: 500, feature: 80, features: 5, extras: 3, searchTerms: 5 } as const;

describe("listing text", () => {
  const name = field("App name");
  const subtitle = field("App card subtitle");
  const intro = field("App introduction");
  const details = field("App details");
  const features = lines(field("Feature list"));
  const extras = lines(field("Feature list — optional extras (only if the form takes 8)"));
  const terms = lines(field("Search terms"));
  const integrations = lines(field("Integrations"));

  it("uses the toml app name, ≤ 30 characters", () => {
    const toml = read("shopify.app.toml").match(/^name\s*=\s*"([^"]*)"/m)?.[1];
    expect(name).toBe(toml);
    expect(name.length).toBeLessThanOrEqual(LIMITS.name);
  });

  it("fits every field limit", () => {
    expect(subtitle.length).toBeGreaterThan(0);
    expect(subtitle.length).toBeLessThanOrEqual(LIMITS.subtitle);
    expect(intro.length).toBeGreaterThan(0);
    expect(intro.length).toBeLessThanOrEqual(LIMITS.intro);
    expect(details.length).toBeGreaterThan(0);
    expect(details.length).toBeLessThanOrEqual(LIMITS.details);
    expect(features.length).toBe(LIMITS.features);
    expect(extras.length).toBeLessThanOrEqual(LIMITS.extras);
    for (const f of [...features, ...extras]) expect(f.length, f).toBeLessThanOrEqual(LIMITS.feature);
    expect(new Set([...features, ...extras]).size).toBe(features.length + extras.length);
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.length).toBeLessThanOrEqual(LIMITS.searchTerms);
    // Single-line fields stay on one line.
    for (const s of [name, subtitle, intro, details]) expect(s).not.toContain("\n");
  });

  it("makes no price, statistic, guarantee, AI or 'first / only' claim", () => {
    for (const s of [subtitle, intro, details, ...features, ...extras]) {
      expect(s, s).not.toMatch(/[$€£%]|\bper month\b|\/mo\b|\bfree trial\b/i);
      expect(s, s).not.toMatch(/\bAI\b|artificial intelligence|machine learning|guarantee|#1|\bbest\b(?! sellers?\b)/i); // "best sellers" names products, not a claim
      expect(s, s).not.toMatch(/\bthe (first|only)\b/i);
    }
  });

  it("names no plan in the text (plans live in the plan cards)", () => {
    for (const s of [subtitle, intro, details, ...features, ...extras]) {
      expect(s, s).not.toMatch(/\b(Free|Growth|Pro)\b(?! of)|\bplan only\b|\bon (the )?(Free|Growth|Pro)\b|\bupgrade\b/);
    }
  });

  it("never names another Keha app (rule 4.4), and lists only real integrations", () => {
    expect(listing).not.toMatch(/Keha Preorder/);
    expect(integrations).toEqual(["Slack", "Shopify Flow", "Shopify POS", "Shopify Sidekick"]);
  });

  it("search terms from the audit", () => {
    expect(terms).toEqual(["inventory forecasting", "purchase orders", "inventory planning", "demand forecasting", "low stock alert"]);
  });
});

describe("listing pricing", () => {
  const catalog = read("app/services/plans.server.ts");
  const plan = (code: string) => {
    const m = catalog.match(new RegExp(`code: "${code}", name: "\\w+", amountMonthly: (\\d+), amountAnnual: (\\d+), currency: "USD", trialDays: (\\d+)`));
    expect(m, code).not.toBeNull();
    return { monthly: Number(m![1]) / 100, annual: Number(m![2]) / 100, trial: Number(m![3]) };
  };

  it("matches the plan catalog: prices, annual = 2 months free, 7-day trial", () => {
    for (const code of PLAN_CODES) {
      const p = plan(code);
      const row = listing.match(new RegExp(`^\\| ${PLAN_LABEL[code]} \\| \\$(\\d+) \\| \\$(\\d+) \\| ([^|]+) \\|$`, "m"));
      expect(row, code).not.toBeNull();
      expect(Number(row![1])).toBe(p.monthly);
      expect(Number(row![2])).toBe(p.annual);
      expect(p.annual).toBe(p.monthly * 10);
      expect(row![3].trim()).toBe(p.trial ? `${p.trial} days` : "none");
    }
    expect(plan("growth")).toEqual({ monthly: 49, annual: 490, trial: 7 });
    expect(plan("pro")).toEqual({ monthly: 99, annual: 990, trial: 7 });
  });

  it("says 7-day trial in the owner checklists too (owner 2026-10-17: Growth and Pro trials are 7 days)", () => {
    for (const doc of ["docs/listing/SUBMISSION-CHECKLIST.md", "docs/listing/REVIEWER.md"]) {
      const text = read(doc);
      expect(text, doc).toContain("7-day trial on paid plans");
      expect(text, doc).not.toMatch(/\b14-day trial\b/);
    }
  });

  it("lists every plan-card line word for word, each marked shipped or not built", () => {
    for (const code of PLAN_CODES) {
      const at = listing.indexOf(`\n### ${PLAN_LABEL[code]}\n`);
      expect(at, code).toBeGreaterThanOrEqual(0);
      const block = listing.slice(at + 1).split(/\n#{2,3} /)[0];
      const rows = [...block.matchAll(/^- (Shipped|Not built yet) — (.+)$/gm)].map((m) => m[2]);
      expect(rows).toEqual(PLAN_POINTS[code]);
    }
  });

  it("publishes no plan-card line the app doesn't ship", () => {
    expect(listing).not.toMatch(/^- Not built yet — /m);
  });
});

describe("reviewer instructions", () => {
  it("explain every requested scope in one row, and only those", () => {
    const reviewer = read("docs/listing/REVIEWER.md");
    const toml = read("shopify.app.toml").match(/^scopes\s*=\s*"([^"]*)"/m)?.[1] ?? "";
    const scopes = toml.split(",").map((s) => s.trim()).filter(Boolean).sort();
    const rows = [...reviewer.matchAll(/^\| `([a-z_]+)` \| (.+) \|$/gm)].map((m) => m[1]).sort();
    expect(rows).toEqual(scopes);
  });
});

describe("reviewer notes match the app (launch re-audit 2026-10-17)", () => {
  const reviewer = read("docs/listing/REVIEWER.md");
  const checklist = read("docs/listing/SUBMISSION-CHECKLIST.md");
  it("say Free shows a top-10 preview of the order plan and how to see Growth", () => {
    expect(reviewer).toMatch(/On Free, the order plan is a top-10 preview/);
    expect(reviewer).toMatch(/pick \*\*Growth\*\* on Shopify's\s+plan page/);
  });
  it("quote the Dashboard's current empty-state copy, not a retired one", () => {
    expect(checklist).not.toContain("We need at least 14 days of sales to give advice.");
    expect(checklist).toContain("Your first order plan needs 14 days of sales — expected on {date}.");
    // One phrasing everywhere (listing audit 2026-10-18): the Dashboard, Order now, Next 13 weeks and the Monday email.
    expect(checklist).not.toContain("we'll show it here on {date}");
    expect(reviewer).not.toMatch(/preorder bridge/i);
  });
});
