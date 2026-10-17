/** Supplier form validation (Settings → Suppliers, spec §5.5) and the rate limiter (spec §14). */
import { describe, expect, it } from "vitest";
import {
  EMPTY_SUPPLIER_FORM,
  cleanVendors,
  needsExchangeRate,
  newSupplierForm,
  parseDecimal,
  productIdsFrom,
  readSupplierForm,
  supplierErrorText,
  supplierToForm,
  validateSupplierForm,
  type SupplierErrorCode,
} from "../app/lib/suppliers-shared";
import { clientIp, createRateLimiter } from "../app/lib/rate-limit-shared";

const form = (over: Partial<typeof EMPTY_SUPPLIER_FORM> = {}) => ({ ...newSupplierForm(21, "EUR"), name: "Acme", ...over });

describe("validateSupplierForm", () => {
  it("accepts a full supplier and normalises it", () => {
    const r = validateSupplierForm(
      form({
        name: "  Acme Textiles ",
        email: " Orders@Acme.COM ",
        minOrder: "10",
        minOrderTotal: "200",
        casePack: "6",
        currency: "usd",
        hidePrices: true,
        vendorMatch: ["Acme", " acme ", "", "Acme Kids"],
      }),
    );
    expect(r).toEqual({
      ok: true,
      input: {
        name: "Acme Textiles",
        email: "orders@acme.com",
        leadTimeDays: 21,
        minOrder: 10,
        minOrderTotal: 200,
        casePack: 6,
        transitDays: null,
        orderCycleDays: null,
        minOrderValue: null,
        minOrderScope: "variant",
        exchangeRate: null,
        currency: "USD",
        hidePrices: true,
        vendorMatch: ["Acme", "Acme Kids"],
        // Supplier module: no payment terms (everything paid when ordering), no freight & duty.
        balanceDue: null,
        depositPercent: null,
        balanceDays: null,
        landedCostPercent: null,
      },
    });
  });

  it("transit days, a money minimum, the minimum scope and the exchange rate", () => {
    const r = validateSupplierForm(
      form({ leadTimeDays: "45", transitDays: "30", minOrderValue: "1500,5", minOrderScope: "product", currency: "usd", exchangeRate: "0.9215" }),
      [],
      "EUR",
    );
    expect(r.ok && r.input).toMatchObject({ transitDays: 30, minOrderValue: 1500.5, minOrderScope: "product", currency: "USD", exchangeRate: 0.9215 });
    // Transit is part of the lead time, so it can't be longer.
    expect(validateSupplierForm(form({ leadTimeDays: "10", transitDays: "20" }))).toEqual({ ok: false, errors: { transitDays: "transit" } });
    expect(validateSupplierForm(form({ transitDays: "400" }))).toEqual({ ok: false, errors: { transitDays: "range" } });
    // Amounts: up to 2 decimals, above 0.
    for (const bad of ["0", "-5", "12.345", "abc"]) {
      expect(validateSupplierForm(form({ minOrderValue: bad }))).toEqual({ ok: false, errors: { minOrderValue: "money" } });
    }
    // A rate only applies when the supplier bills in another currency; otherwise it is dropped.
    const same = validateSupplierForm(form({ currency: "EUR", exchangeRate: "1.2" }), [], "EUR");
    expect(same.ok && same.input.exchangeRate).toBeNull();
    const none = validateSupplierForm(form({ currency: "", exchangeRate: "1.2" }), [], "EUR");
    expect(none.ok && none.input.exchangeRate).toBeNull();
    expect(validateSupplierForm(form({ currency: "USD", exchangeRate: "0" }), [], "EUR")).toEqual({ ok: false, errors: { exchangeRate: "rate" } });
    // Transit 0 means none; an unknown scope reads as each size/colour.
    const zero = validateSupplierForm({ ...form({ transitDays: "0" }), minOrderScope: "style" as never });
    expect(zero.ok && zero.input).toMatchObject({ transitDays: null, minOrderScope: "variant" });
  });

  it("order cycle: whole days 1–365, empty = the store's cycle (2026-10-17)", () => {
    const r = validateSupplierForm(form({ orderCycleDays: " 75 " }));
    expect(r.ok && r.input.orderCycleDays).toBe(75);
    const empty = validateSupplierForm(form({ orderCycleDays: "" }));
    expect(empty.ok && empty.input.orderCycleDays).toBeNull();
    for (const bad of ["0", "366", "7.5", "-3", "abc"]) {
      expect(validateSupplierForm(form({ orderCycleDays: bad })), bad).toEqual({ ok: false, errors: { orderCycleDays: "range" } });
    }
    expect(readSupplierForm({ orderCycleDays: 30 }).orderCycleDays).toBe("30");
    const row = { name: "Acme", email: null, leadTimeDays: 7, minOrder: null, minOrderTotal: null, casePack: null, currency: null, hidePrices: false, vendorMatch: [] };
    expect(supplierToForm({ ...row, orderCycleDays: null }).orderCycleDays).toBe("");
    expect(supplierToForm(row).orderCycleDays).toBe("");
    expect(supplierToForm({ ...row, orderCycleDays: 30 }).orderCycleDays).toBe("30");
  });

  it("needsExchangeRate: only a different, valid currency", () => {
    expect(needsExchangeRate("usd", "EUR")).toBe(true);
    expect(needsExchangeRate("EUR", "EUR")).toBe(false);
    expect(needsExchangeRate("", "EUR")).toBe(false);
    expect(needsExchangeRate("US", "EUR")).toBe(false);
    expect(parseDecimal("1.0825", 6, 10)).toBe(1.0825);
    expect(parseDecimal("1e3", 2, 1e9)).toBeNull();
  });

  it("leaves optional fields empty (null) and treats a case pack of 1 as none", () => {
    const r = validateSupplierForm(form({ currency: "", casePack: "1" }));
    expect(r.ok && r.input).toMatchObject({ email: null, minOrder: null, minOrderTotal: null, casePack: null, currency: null });
  });

  it("reports each bad field with a code", () => {
    const r = validateSupplierForm(
      form({ name: "", email: "nope", leadTimeDays: "", minOrder: "0", minOrderTotal: "2.5", casePack: "99999", currency: "EURO" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors).toEqual({
        name: "name",
        email: "email",
        leadTimeDays: "range",
        minOrder: "range",
        minOrderTotal: "range",
        casePack: "range",
        currency: "currency",
      });
  });

  it("refuses a duplicate name (case-insensitive) and an over-long one", () => {
    expect(validateSupplierForm(form({ name: "ACME" }), ["acme"])).toEqual({ ok: false, errors: { name: "nameTaken" } });
    expect(validateSupplierForm(form({ name: "x".repeat(101) }))).toEqual({ ok: false, errors: { name: "nameLong" } });
  });

  it("caps vendor matches", () => {
    const many = Array.from({ length: 51 }, (_, i) => `V${i}`);
    expect(validateSupplierForm(form({ vendorMatch: many }))).toEqual({ ok: false, errors: { vendorMatch: "vendors" } });
  });

  it("round-trips a stored supplier and reads untrusted JSON", () => {
    const stored = {
      name: "Acme",
      email: "a@b.co",
      leadTimeDays: 7,
      minOrder: null,
      minOrderTotal: 50,
      casePack: null,
      transitDays: 5,
      orderCycleDays: 30,
      minOrderValue: 250.5,
      minOrderScope: "product" as const,
      exchangeRate: null,
      currency: null,
      hidePrices: false,
      vendorMatch: ["Acme"],
      balanceDue: "ship" as const,
      depositPercent: 30,
      balanceDays: null,
      landedCostPercent: 12.5,
    };
    const r = validateSupplierForm(supplierToForm(stored));
    expect(r.ok && r.input).toEqual(stored);
    expect(readSupplierForm({ name: 5, hidePrices: "yes", vendorMatch: ["a", 3] })).toMatchObject({
      name: "5",
      hidePrices: false,
      vendorMatch: ["a"],
    });
    expect(cleanVendors(["B", "b", " "])).toEqual(["B"]);
  });

  it("has text for every error code", () => {
    const codes: SupplierErrorCode[] = ["name", "nameLong", "nameTaken", "email", "range", "currency", "vendors", "transit", "money", "rate", "percent"];
    for (const c of codes) expect(supplierErrorText(c, (s) => s).length).toBeGreaterThan(5);
  });

  it("keeps only product gids from a picker selection", () => {
    expect(productIdsFrom([{ id: "gid://shopify/Product/1" }, "gid://shopify/Product/2", { id: "gid://shopify/ProductVariant/3" }, null])).toEqual([
      "gid://shopify/Product/1",
      "gid://shopify/Product/2",
    ]);
    expect(productIdsFrom("x")).toEqual([]);
  });
});

describe("rate limiter", () => {
  it("allows 20 requests per 10 minutes per key, then refuses until the window moves", () => {
    const rl = createRateLimiter({ limit: 20, windowMs: 600_000 });
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) expect(rl.hit("ip:1", t0 + i)).toBe(true);
    expect(rl.hit("ip:1", t0 + 100)).toBe(false);
    expect(rl.hit("ip:2", t0 + 100)).toBe(true); // other keys are separate
    expect(rl.hit("ip:1", t0 + 600_000)).toBe(true); // the first hit left the window
  });

  it("forgets the least recently used keys past maxKeys", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 2 });
    rl.hit("a", 1);
    rl.hit("b", 2);
    rl.hit("c", 3);
    expect(rl.size()).toBe(2);
    expect(rl.hit("a", 4)).toBe(true); // "a" was dropped
  });

  it("reads the client address from the proxy header", () => {
    // The right-most hop is the one our proxy appended; the left ones are client-supplied.
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("10.0.0.1");
    expect(clientIp(new Headers({ "x-forwarded-for": "spoofed-1, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-forwarded-for": "spoofed-2, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-forwarded-for": " 203.0.113.9 ,  " }))).toBe("203.0.113.9");
    // Cloudflare in front: its CF-Connecting-IP wins over the (Cloudflare-edge) XFF hop.
    expect(clientIp(new Headers({ "cf-connecting-ip": "198.51.100.4", "x-forwarded-for": "198.51.100.4, 172.68.1.1" }))).toBe("198.51.100.4");
    expect(clientIp(new Headers({ "x-real-ip": "192.0.2.1" }))).toBe("192.0.2.1");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
