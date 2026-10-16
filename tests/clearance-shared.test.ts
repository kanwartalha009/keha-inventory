/**
 * Clear → discount (task 2.3, spec §4 J5): confirm-dialog defaults and
 * validation, the code generator, the store-calendar end date, the mutation
 * input, cash in stock and cash freed.
 */
import { describe, expect, it } from "vitest";
import {
  CLEAR_DAYS_DEFAULT,
  cashFreed,
  cashInStock,
  defaultClearForm,
  discountInput,
  discountTitle,
  endOfLocalDay,
  generateCode,
  isValidCode,
  userErrorMessages,
  validateClearForm,
} from "../app/lib/clearance-shared";

const TODAY = "2026-10-19";

describe("discount code", () => {
  it("generates CLEAR-XXXX from an unambiguous alphabet", () => {
    expect(generateCode(() => 0)).toBe("CLEAR-AAAA");
    expect(generateCode(() => 0.999999)).toBe("CLEAR-9999");
    for (let i = 0; i < 200; i++) {
      const c = generateCode();
      expect(c).toMatch(/^CLEAR-[A-HJ-NP-Z2-9]{4}$/);
      expect(isValidCode(c)).toBe(true);
    }
  });

  it("validates codes (case-insensitive, 3–40, letters / digits / - / _)", () => {
    expect(isValidCode("clear-7q3k")).toBe(true);
    expect(isValidCode("AB")).toBe(false);
    expect(isValidCode("HAS SPACE")).toBe(false);
    expect(isValidCode("-LEAD")).toBe(false);
    expect(isValidCode("X".repeat(41))).toBe(false);
  });
});

describe("confirm dialog", () => {
  it("defaults: automatic, 20%, ends 30 days out, a fresh code", () => {
    const f = defaultClearForm(TODAY, () => 0.5);
    expect(f).toEqual({ kind: "automatic", percent: "20", endsOn: "2026-11-18", code: f.code });
    expect(CLEAR_DAYS_DEFAULT).toBe(30);
    expect(f.code).toMatch(/^CLEAR-/);
  });

  it("accepts a valid automatic form and an empty end date", () => {
    expect(validateClearForm({ kind: "automatic", percent: "20", endsOn: "", code: "" }, TODAY)).toEqual({
      ok: true,
      value: { kind: "automatic", percent: 20, endsOn: null, code: null },
    });
    expect(validateClearForm({ kind: "automatic", percent: "90", endsOn: TODAY, code: "" }, TODAY)).toMatchObject({ ok: true });
  });

  it("normalises the code for a code discount", () => {
    expect(validateClearForm({ kind: "code", percent: "15", endsOn: "2026-12-01", code: " clear-7q3k " }, TODAY)).toEqual({
      ok: true,
      value: { kind: "code", percent: 15, endsOn: "2026-12-01", code: "CLEAR-7Q3K" },
    });
  });

  it("rejects each bad field", () => {
    const r = validateClearForm({ kind: "bogo", percent: "95", endsOn: "2026-10-18", code: "" }, TODAY);
    expect(r).toEqual({ ok: false, errors: { kind: true, percent: true, endsOn: true } });
    for (const percent of ["0", "2.5", "", "abc", "-5"]) {
      expect(validateClearForm({ kind: "automatic", percent, endsOn: "", code: "" }, TODAY)).toMatchObject({ ok: false, errors: { percent: true } });
    }
    expect(validateClearForm({ kind: "automatic", percent: "20", endsOn: "2026-02-30", code: "" }, TODAY)).toMatchObject({ ok: false, errors: { endsOn: true } });
    expect(validateClearForm({ kind: "code", percent: "20", endsOn: "", code: "no spaces!" }, TODAY)).toMatchObject({ ok: false, errors: { code: true } });
  });
});

describe("end date in the store's calendar", () => {
  it("ends at 23:59:59 local time", () => {
    expect(endOfLocalDay("2026-11-18", "Europe/Madrid").toISOString()).toBe("2026-11-18T22:59:59.000Z"); // UTC+1 in winter
    expect(endOfLocalDay("2026-07-01", "Europe/Madrid").toISOString()).toBe("2026-07-01T21:59:59.000Z"); // UTC+2 in summer
    expect(endOfLocalDay("2026-11-18", "Asia/Kathmandu").toISOString()).toBe("2026-11-18T18:14:59.000Z"); // +05:45
    expect(endOfLocalDay("2026-11-18", "America/Los_Angeles").toISOString()).toBe("2026-11-19T07:59:59.000Z");
    expect(endOfLocalDay("2026-11-18", null).toISOString()).toBe("2026-11-18T23:59:59.000Z");
    expect(endOfLocalDay("2026-11-18", "Not/AZone").toISOString()).toBe("2026-11-18T23:59:59.000Z");
  });
});

describe("mutation input", () => {
  const scope = { productIds: ["gid://shopify/Product/1", "gid://shopify/Product/1"], startsAt: new Date("2026-10-19T08:00:00Z"), endsAt: new Date("2026-11-18T22:59:59Z") };

  it("automatic: percentage as a 0–1 decimal, scoped to the products, all buyers, language-neutral title", () => {
    expect(discountInput({ kind: "automatic", percent: 20, endsOn: "2026-11-18", code: null }, scope)).toEqual({
      title: "-20%",
      startsAt: "2026-10-19T08:00:00.000Z",
      endsAt: "2026-11-18T22:59:59.000Z",
      context: { all: "ALL" },
      customerGets: { value: { percentage: 0.2 }, items: { products: { productsToAdd: ["gid://shopify/Product/1"] } } },
    });
  });

  it("code: carries the code (also as the title); no end date → null", () => {
    const input = discountInput({ kind: "code", percent: 35, endsOn: null, code: "CLEAR-7Q3K" }, { ...scope, endsAt: null });
    expect(input).toMatchObject({ code: "CLEAR-7Q3K", title: "CLEAR-7Q3K", endsAt: null, customerGets: { value: { percentage: 0.35 } } });
    expect(discountTitle({ kind: "automatic", percent: 5, code: null })).toBe("-5%");
  });

  it("collects user error messages", () => {
    expect(userErrorMessages([{ field: ["code"], message: "Code must be unique" }, { message: " " }])).toEqual(["Code must be unique"]);
    expect(userErrorMessages(null)).toEqual([]);
  });
});

describe("cash in stock and cash freed", () => {
  it("values on-hand units at cost, else retail (labelled); skips variants without a stock row", () => {
    expect(cashInStock([{ onHand: 10, cost: 5, price: 20 }, { onHand: 4, cost: null, price: 25 }, { onHand: null, cost: 9, price: 9 }])).toEqual({
      cash: 150,
      units: 14,
      retail: true,
    });
    expect(cashInStock([{ onHand: -3, cost: 5, price: 20 }])).toEqual({ cash: 0, units: 0, retail: false });
  });

  it("unknown when no variant can be valued", () => {
    expect(cashInStock([{ onHand: 5, cost: null, price: null }])).toEqual({ cash: null, units: 5, retail: false });
    expect(cashInStock([])).toEqual({ cash: null, units: null, retail: false });
  });

  it("cash freed = baseline − now, never negative, null when unknown", () => {
    expect(cashFreed(1000, 600)).toBe(400);
    expect(cashFreed(1000, 1200)).toBe(0);
    expect(cashFreed(1000, null)).toBeNull();
    expect(cashFreed(null, 10)).toBeNull();
    expect(cashFreed(0, 0)).toBeNull();
    expect(cashFreed(100.255, 0.1)).toBe(100.16);
  });
});
