/** Supplier form validation (Settings → Suppliers, spec §5.5) and the rate limiter (spec §14). */
import { describe, expect, it } from "vitest";
import {
  EMPTY_SUPPLIER_FORM,
  cleanVendors,
  newSupplierForm,
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
        currency: "USD",
        hidePrices: true,
        vendorMatch: ["Acme", "Acme Kids"],
      },
    });
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
      currency: null,
      hidePrices: false,
      vendorMatch: ["Acme"],
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
    const codes: SupplierErrorCode[] = ["name", "nameLong", "nameTaken", "email", "range", "currency", "vendors"];
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
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
