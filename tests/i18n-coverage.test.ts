/**
 * Translation coverage (spec §2.8, §13): every visible admin string is
 * translated into all 7 non-English languages, keeps its {placeholders}, and
 * every dictionary entry is still used somewhere.
 *
 * Visible strings = every `t("…")`, `tr("…")` and `translate(locale, "…")`
 * literal in app/ plus the data that is passed through t() as a variable
 * (plan matrix, plan cards, plan names, settings tabs, action reasons, the
 * Why-dialog fact labels and values).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AREAS, LOCALES, translate } from "../app/lib/i18n";
import { INHERITS, PLAN_MATRIX, PLAN_PITCH, PLAN_POINTS } from "../app/lib/plan-matrix";
import { PLAN_LABEL } from "../app/lib/plan-shared";
import { SETTINGS_ERRORS } from "../app/lib/settings-shared";
import { ACTION_REASONS } from "../app/lib/actions-shared";
import { SETTINGS_TABS } from "../app/components/settings-tabs";
import { factStrings } from "../app/lib/action-facts-shared";

/** Strings spelled the same in a language (brand words, loanwords). */
const SAME_WORD: Record<string, string[]> = {
  Growth: ["es", "fr", "de", "it", "pt", "nl", "pl"],
  Pro: ["es", "fr", "de", "it", "pt", "nl", "pl"],
  Slack: ["es", "fr", "de", "it", "pt", "nl", "pl"],
  "Shopify Flow": ["es", "fr", "de", "it", "pt", "nl", "pl"],
  "Black Friday": ["es", "fr", "de", "it", "pt", "nl", "pl"],
  Home: ["it", "nl"],
  "Top 10": ["fr", "de", "nl"],
  Planner: ["nl"],
  Planning: ["nl"],
  "1 scenario": ["it", "nl"],
  Status: ["de", "nl"],
  Product: ["nl"],
  Variant: ["nl"],
  Collection: ["fr"],
  Actions: ["fr"],
  "{n} per product": ["nl"],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

// t("…"), a local tr("…") alias, and translate(<locale>, "…") (emails, public pages).
const T_CALL = /(?:\b(?:t|tr)\(\s*|\btranslate\(\s*[^,()"]+,\s*)"((?:[^"\\]|\\.)*)"\s*\)/g;

function literalKeys(): Set<string> {
  const out = new Set<string>();
  for (const f of files(join(__dirname, "..", "app"))) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(T_CALL)) out.add(JSON.parse(`"${m[1]}"`) as string);
  }
  return out;
}

function dataKeys(): Set<string> {
  const out = new Set<string>();
  for (const g of PLAN_MATRIX) {
    out.add(g.title);
    for (const r of g.rows) {
      out.add(r.label);
      if (r.hint) out.add(r.hint);
      for (const v of Object.values(r.values ?? {})) if (typeof v === "string") out.add(v);
    }
  }
  for (const v of Object.values(SETTINGS_ERRORS)) out.add(v);
  for (const v of Object.values(ACTION_REASONS)) out.add(v);
  for (const x of SETTINGS_TABS) out.add(x.label);
  for (const v of factStrings()) out.add(v);
  for (const v of Object.values(PLAN_PITCH)) out.add(v);
  for (const list of Object.values(PLAN_POINTS)) for (const v of list) out.add(v);
  for (const v of Object.values(INHERITS)) if (v) out.add(v);
  for (const v of Object.values(PLAN_LABEL)) {
    out.add(v);
    if (v !== "Free") out.add(`${v} plan`);
  }
  return out;
}

const KEYS = new Set([...literalKeys(), ...dataKeys()]);
const OTHERS = LOCALES.filter((l) => l !== "en");
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

describe("translation coverage", () => {
  it("finds the visible strings", () => {
    expect(KEYS.size).toBeGreaterThan(50);
  });

  it("translates every visible string into all 7 languages", () => {
    const missing: string[] = [];
    for (const k of KEYS)
      for (const l of OTHERS) if (translate(l, k) === k && !SAME_WORD[k]?.includes(l)) missing.push(`${l}: ${k}`);
    expect(missing).toEqual([]);
  });

  it("keeps every {placeholder}", () => {
    const broken: string[] = [];
    for (const k of KEYS)
      for (const l of OTHERS)
        if (JSON.stringify(placeholders(translate(l, k))) !== JSON.stringify(placeholders(k))) broken.push(`${l}: ${k}`);
    expect(broken).toEqual([]);
  });

  it("has no unused dictionary entries", () => {
    const unused = Object.values(AREAS).flatMap((area) => Object.keys(area).filter((k) => !KEYS.has(k)));
    expect(unused).toEqual([]);
  });
});
