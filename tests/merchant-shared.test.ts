/**
 * Merchant audit 2026-10-18, pure parts: the singular / plural helper and the reasons that use it
 * ("Runs out in 1 days"), the in-stock target for z on the product page, and a grep that no
 * visible "{n} …s" text is shown without its singular form where n can be 1.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plural, translate } from "../app/lib/i18n";
import { ACTION_REASONS, reasonTemplate } from "../app/lib/actions-shared";
import { reasonSentence } from "../app/lib/action-facts-shared";
import { inStockTargetPct, normalCdf } from "../app/lib/service-level-shared";

describe("singular and plural", () => {
  it("one only for exactly 1", () => {
    expect(plural(1, "1 day", "{n} days")).toBe("1 day");
    for (const n of [0, 2, 1.5, null, undefined]) expect(plural(n, "1 day", "{n} days")).toBe("{n} days");
  });

  it("action reasons: today, 1 day, n days — in every language", () => {
    const say = (key: string, params: Record<string, string | number>, locale: "en" | "de" = "en") => reasonSentence(translate(locale, reasonTemplate(key, params)), params, locale);
    expect(say("reorder_low", { days: 1, lead: 14, date: "2026-10-30" })).toMatch(/^Runs out in 1 day; a new order takes 14 days to arrive\. Order by \S+ \S+\.$/);
    expect(say("reorder_now", { days: 0, lead: 14 })).toBe("Runs out today; a new order takes 14 days to arrive. Order now.");
    expect(say("reorder_now", { days: 5, lead: 14 })).toBe("Runs out in 5 days; a new order takes 14 days to arrive. Order now.");
    expect(say("bridge_gap", { gap: 1, date: "2026-10-30" })).toMatch(/^Runs out 1 day before new stock arrives on /);
    expect(say("reorder_now", { days: 1, lead: 14 }, "de")).toBe("Ist in 1 Tag ausverkauft; eine neue Bestellung braucht 14 Tage. Bestelle jetzt.");
    expect(reasonTemplate("push_up", { pct: 1 })).toBe(ACTION_REASONS.push_up);
    expect(reasonTemplate("nope", {})).toBe("nope");
  });

  it("no '1 days' / '1 lines' / '1 units' left: every {n} text that can be 1 has its singular next to it", () => {
    const root = join(__dirname, "..", "app");
    const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : /\.tsx?$/.test(n) && !/i18n-/.test(n) ? [join(d, n)] : []));
    const KEYS = ["{n} lines without a cost price", "{n} units\"", "{n} days\"", "{n} days (supplier)", "{n} days in transit", "{n} suppliers\"", "{n} variants\""];
    const bare: string[] = [];
    for (const f of files(root)) {
      for (const [i, line] of readFileSync(f, "utf8").split("\n").entries()) {
        if (!line.includes('t("')) continue;
        for (const k of KEYS) if (line.includes(`t("${k}`) && !/plural\(|=== 1 \?/.test(line)) bare.push(`${f.slice(root.length)}:${i + 1}`);
      }
    }
    expect(bare).toEqual([]);
  });
});

describe("in-stock target", () => {
  it("z → the chance of not running out, as a whole percent", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(inStockTargetPct(1.65)).toBe(95);
    expect(inStockTargetPct(1.28)).toBe(90);
    expect(inStockTargetPct(1.04)).toBe(85);
    expect(inStockTargetPct(2.05)).toBe(98);
    expect(inStockTargetPct(0.67)).toBe(75);
    expect(inStockTargetPct(null)).toBeNull();
    expect(inStockTargetPct(9)).toBe(99);
  });
});

describe("restocked returns are not purchase-order receipts (fixture: 25 % of sales come back)", () => {
  // A coat line: 20 ordered, 100 on hand when the arrival window opened, 80 sold since and 20 of
  // them (25 %) returned to the shelf. Without a delivery: 100 − 80 + 20 = 40 on hand.
  const sold = new Map([["c", 80]]);
  const returned = new Map([["c", 20]]);
  const decide = async (onHandNow: number, withReturns: boolean) => {
    const { autoReceiveDecision } = await import("../app/lib/purchase-order-shared");
    return autoReceiveDecision({
      status: "sent",
      source: "keha",
      windowStart: "2026-11-01",
      sentDay: "2026-09-01",
      today: "2026-11-20",
      lines: [{ variantId: "c", qty: 20 }],
      baseline: new Map([["c", 100]]),
      onHand: new Map([["c", onHandNow]]),
      soldSince: sold,
      ...(withReturns ? { returnedSince: returned } : {}),
    });
  };

  it("auto-receive: the returns alone no longer close the order; the real delivery still does", async () => {
    // Before the fix the 20 returned units looked like the 20 ordered ones: closed with nothing delivered.
    expect(await decide(40, false)).toMatchObject({ receive: true });
    expect(await decide(40, true)).toMatchObject({ receive: false, reason: "not_landed", share: 0 });
    // The delivery lands: 40 + 20 = 60 on hand → 20 received.
    expect(await decide(60, true)).toMatchObject({ receive: true, received: { c: 20 } });
  });

  it("the landed estimate (Keha units on order) nets the returns too", async () => {
    const { withLandedEstimate, kehaOpenUnits } = await import("../app/lib/compute-shared");
    const pos: import("../app/lib/compute-shared").OpenPo[] = [{ source: "keha", arrival: "2026-11-30", sentDay: "2026-10-01", lines: [{ variantId: "c", qty: 20, baseOnHand: 100 }] }];
    const facts = (onHand: number, withReturns: boolean) => ({
      onHand: new Map([["c", onHand]]),
      baseline: () => undefined,
      soldSince: () => 80,
      ...(withReturns ? { returnedSince: () => 20 } : {}),
    });
    expect(kehaOpenUnits(withLandedEstimate(pos, facts(40, false))).get("c") ?? 0).toBe(0); // the old mistake
    expect(kehaOpenUnits(withLandedEstimate(pos, facts(40, true))).get("c")).toBe(20); // nothing landed: still on order
    expect(kehaOpenUnits(withLandedEstimate(pos, facts(50, true))).get("c")).toBe(10); // half the delivery landed
  });
});
