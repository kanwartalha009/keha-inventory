/**
 * Action wording (review fixes): the "Why" dialog shows plain-words labels and formatted values
 * in the admin language, never the engine's code names; action sentences show "12 Nov" and the
 * locale's number separators on Home, in the Monday email and in Slack.
 */
import { describe, expect, it } from "vitest";
import { ACTION_RULES, generateActions, type RuleContext, type RuleProduct, type RuleVariant } from "../app/lib/engine/actions-rules-shared";
import { ACTION_KINDS, type ActionDraft } from "../app/lib/actions-shared";
import { FACT_DEFS, factLines, factStrings, formatReasonParams, reasonSentence, shortDay } from "../app/lib/action-facts-shared";
import { readReason } from "../app/lib/action-list-shared";
import { reasonText, whyFactsText } from "../app/components/action-list";
import { actionReasonText, mondaySummary, type MondayEmailInput } from "../app/lib/monday-shared";
import { buildSlackMonday } from "../app/lib/slack-shared";
import { translate, type Locale } from "../app/lib/i18n";

const TODAY = "2026-10-16";
const CTX: RuleContext = { today: TODAY, aov: 50, returnsMeasured: true };

function v(over: Partial<RuleVariant> = {}): RuleVariant {
  return {
    id: "v1",
    status: "healthy",
    role: "C",
    rate: 2,
    seasonal: 1,
    trend: 1,
    onHand: 100,
    incoming: 0,
    daysLeft: 50,
    orderBy: "2026-11-20",
    orderQty: null,
    leadTimeDays: 14,
    price: 10,
    cost: 4,
    sold28: 56,
    noSaleDays: 0,
    arrival: null,
    soldNet90: null,
    returned90: null,
    ...over,
  };
}

const p = (productId: string, variants: RuleVariant[], over: Partial<RuleProduct> = {}): RuleProduct => ({
  productId,
  variants,
  sessions28: null,
  checkouts28: null,
  revenue28: null,
  revenue28LastYear: null,
  ...over,
});

/** Representative inputs that make the engine emit every kind and every reason variant. */
function allDrafts(): ActionDraft[] {
  const conv = (id: string, rate: number, price = 10) =>
    p(id, [v({ id: `${id}v`, price })], { sessions28: 1000, checkouts28: rate * 1000 });
  const ret = (id: string, net: number, returned: number) => p(id, [v({ id: `${id}v`, soldNet90: net, returned90: returned })]);
  const sizes = p(
    "S",
    Array.from({ length: 10 }, (_x, i) => v({ id: `s${i}`, onHand: i < 3 ? 0 : 20, status: i < 3 ? "out" : "healthy", rate: i < 3 ? null : 1, sold28: i === 9 ? 10 : 0 })),
  );
  const tooMuch = (id: string, sessions: number, checkouts: number) =>
    p(id, [v({ id: `${id}v`, status: "too_much", daysLeft: 300, rate: 1 })], { sessions28: sessions, checkouts28: checkouts });
  return [
    // reorder (low with incoming PO units, now, out) + bridge (lead-time estimate)
    ...generateActions([p("R1", [v({ status: "running_low", onHand: 20, incoming: 6, incomingDated: 6, daysLeft: 10, orderBy: "2026-10-20" })])], CTX),
    ...generateActions([p("R2", [v({ status: "running_low", onHand: 10, daysLeft: 5, orderBy: "2026-10-10", sold28: 5 })])], CTX),
    ...generateActions([p("R3", [v({ status: "out", onHand: 0, daysLeft: 0, rate: 0.5 })])], CTX),
    // bridge from a purchase order
    ...generateActions([p("B1", [v({ status: "out", onHand: 0, daysLeft: 0, orderBy: "2026-10-01", arrival: "2026-10-26" })])], CTX),
    // push: up, steady, converts
    ...generateActions([p("U1", [v({ role: "A", trend: 1.25 })]), p("U2", [v({ id: "u2", role: "B", trend: 1 })])], CTX),
    ...generateActions([tooMuch("U3", 200, 4), p("Q1", [v({ id: "q1" })], { sessions28: 1000, checkouts28: 20 }), p("Q2", [v({ id: "q2" })], { sessions28: 1000, checkouts28: 20 })], CTX),
    // fix · falling, sizes, page, returns
    ...generateActions([p("F1", [v({ id: "f1" })], { revenue28LastYear: 1000, revenue28: 700 })], CTX),
    ...generateActions([sizes], CTX),
    ...generateActions([conv("P1", 0.0199), ...Array.from({ length: 5 }, (_x, i) => conv(`W${i}`, 0.04))], CTX),
    ...generateActions([ret("T1", 75, 25), ret("T2", 95, 5), ret("T3", 95, 5), ret("T4", 95, 5)], CTX),
    // clear: dead (cost), too much at retail, no sales
    ...generateActions([p("C1", [v({ id: "c1", status: "dead", rate: 0, daysLeft: Infinity, onHand: 30, noSaleDays: 120 })])], CTX),
    ...generateActions([p("C2", [v({ id: "c2", status: "too_much", rate: 1, trend: 0.9, onHand: 300, daysLeft: 333, cost: null })])], CTX),
  ];
}

const en = (k: string) => k;
const tr = (l: Locale) => (k: string) => translate(l, k);

describe("Why dialog facts", () => {
  const drafts = allDrafts();

  it("the fixtures cover every action kind and both cost bases / arrival sources", () => {
    expect(new Set(drafts.map((d) => d.kind))).toEqual(new Set(ACTION_KINDS));
    expect(new Set(drafts.map((d) => d.reason.facts?.costBasis).filter(Boolean))).toEqual(new Set(["cost", "retail"]));
    expect(new Set(drafts.map((d) => d.reason.facts?.arrivalSource).filter(Boolean))).toEqual(new Set(["lead_time", "purchase_order"]));
  });

  it("every fact key the engine writes has a label, and every coded value has words", () => {
    const missing: string[] = [];
    for (const d of drafts) {
      for (const [k, val] of Object.entries(d.reason.facts ?? {})) {
        const def = FACT_DEFS[k];
        if (!def) missing.push(`${d.kind}: ${k}`);
        else if (def.kind === "enum" && val !== null && !(String(val) in def.values)) missing.push(`${d.kind}: ${k}=${val}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("shows no code names: every fact of every kind becomes a label in words", () => {
    for (const d of drafts) {
      const facts = readReason(d.reason).facts;
      const lines = factLines(facts, { t: en, locale: "en", currency: "EUR" });
      expect(lines.length, d.kind).toBe(facts.length);
      for (const l of lines) {
        expect(l.label, d.kind).toMatch(/^[A-Z][a-z]/); // a sentence-case phrase, not camelCase
        expect(l.label).not.toMatch(/[a-z][A-Z]|_/);
        expect(l.value).not.toMatch(/^\d{4}-\d{2}-\d{2}$|_/);
      }
    }
    expect(factStrings()).not.toContain("leadTimeDays");
  });

  it("English: days, dates, money, percents, multipliers and codes in words", () => {
    const facts = [
      { label: "leadTimeDays", value: 14 },
      { label: "orderBy", value: "2026-11-12" },
      { label: "price", value: 9.5 },
      { label: "seasonal", value: 1.2 },
      { label: "trend", value: 1.25 },
      { label: "share", value: ACTION_RULES.pushShare },
      { label: "conversionPct", value: 2.5 },
      { label: "horizonDays", value: 28 },
      { label: "windowDays", value: 90 },
      { label: "costBasis", value: "retail" },
      { label: "orderQty", value: null },
      { label: "somethingNew", value: 3 },
    ];
    expect(factLines(facts, { t: en, locale: "en", currency: "EUR" })).toEqual([
      { label: "Supplier lead time", value: "14 days" },
      { label: "Order by", value: "12 Nov" },
      { label: "Price", value: "€9.50" },
      { label: "Seasonal change", value: "× 1.2" },
      { label: "Trend vs last year", value: "+25%" },
      { label: "Extra sales if featured", value: "20%" },
      { label: "Visitors who buy", value: "2.5%" },
      { label: "Period", value: "Next 28 days" },
      { label: "Period", value: "Last 90 days" },
      { label: "Valued at", value: "Retail price" },
      { label: "Suggested qty", value: "—" },
      // an unknown key is never shown
    ]);
  });

  it("German: translated labels and values, German dates and separators", () => {
    const row = {
      currency: "EUR",
      reason: readReason({
        key: "reorder_low",
        params: { days: 9, lead: 14, date: "2026-11-12" },
        facts: { rate: 1.5, leadTimeDays: 14, orderBy: "2026-11-12", price: 1234, costBasis: "cost" },
      }),
    };
    const text = whyFactsText(row, tr("de"), "de")!;
    expect(text).toMatch(/^Grundlage: /);
    expect(text).toContain("Verkäufe pro Tag mit Bestand: 1,5");
    expect(text).toContain("Lieferzeit des Lieferanten: 14 Tage");
    expect(text).toContain("Bestellen bis: 12. Nov.");
    expect(text).toMatch(/Preis: 1\.234\s€/);
    expect(text).toContain("Bewertet zum: Einkaufspreis");
    expect(text).not.toMatch(/leadTimeDays|orderBy|costBasis|2026-11-12/);
  });

  it("every label and coded value is translated in all 7 languages", () => {
    const missing: string[] = [];
    for (const k of factStrings())
      for (const l of ["es", "fr", "de", "it", "pt", "nl", "pl"] as const) if (translate(l, k) === k) missing.push(`${l}: ${k}`);
    expect(missing).toEqual([]);
  });
});

describe("action sentences: '12 Nov' and local numbers everywhere", () => {
  const reason = { key: "reorder_low", params: { days: 1234, lead: 14, date: "2026-11-12" } };

  it("the shared formatter (en, de)", () => {
    expect(formatReasonParams({ date: "2026-11-12", rate: 1.5, days: 1234 }, "en")).toEqual({ date: "12 Nov", rate: "1.5", days: "1,234" });
    expect(formatReasonParams({ date: "2026-11-12", rate: 1.5, days: 1234 }, "de")).toEqual({ date: "12. Nov.", rate: "1,5", days: "1.234" });
    expect(formatReasonParams({ cash: 1200 }, "en", { currency: "EUR", money: ["cash"] })).toEqual({ cash: "€1,200" });
    expect(shortDay("not a day", "en")).toBe("not a day");
    // A date abbreviation ending the sentence keeps one full stop; an ellipsis is left alone.
    expect(reasonSentence("Bis {date}.", { date: "2026-11-12" }, "fr")).toBe("Bis 12 nov.");
    expect(reasonSentence("Wait... {n}...", { n: 2 }, "en")).toBe("Wait... 2...");
  });

  it("Home (en, de)", () => {
    const row = { reason: readReason(reason) };
    expect(reasonText(row, en, "en")).toBe("Runs out in 1,234 days; a new order takes 14 days to arrive. Order by 12 Nov.");
    expect(reasonText(row, tr("de"), "de")).toBe("Ist in 1.234 Tagen ausverkauft; eine neue Bestellung braucht 14 Tage. Bestelle bis 12. Nov.");
  });

  it("Monday email and Slack (en, de)", () => {
    expect(actionReasonText("en", reason)).toBe("Runs out in 1,234 days; a new order takes 14 days to arrive. Order by 12 Nov.");
    expect(actionReasonText("de", reason)).toContain("Bestelle bis 12. Nov.");
    expect(actionReasonText("de", reason)).toContain("1.234 Tagen");
    expect(actionReasonText("de", { key: "reorder_low", params: { days: 3, bad: { x: 1 } } })).not.toContain("[object");

    const input: MondayEmailInput = {
      locale: "de",
      currency: "EUR",
      storeName: "Acme",
      now: { atRisk: 100, lost90: null, cashStuck: null, soldOutTraffic: null },
      before: null,
      refresh: "daily",
      links: { app: "https://admin.shopify.com/store/acme/apps/keha-inventory/app", unsubscribe: "https://inventory.test/u" },
      actions: [{ title: "Boots", reason: actionReasonText("de", reason), amount: 100, link: "https://admin.shopify.com/x" }],
    };
    const slack = buildSlackMonday(mondaySummary(input)).text;
    expect(slack).toContain("Bestelle bis 12. Nov.");
    expect(slack).not.toContain("2026-11-12");
  });
});
