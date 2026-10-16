/**
 * Kit security helpers: sealed tokens (signed, expiring, purpose-bound — for
 * supplier confirm links and email unsubscribe links) and the email sender line.
 */
import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.SHOPIFY_API_SECRET = "test-secret";
  process.env.APP_ENCRYPTION_KEY = "a".repeat(64);
});

import { seal, unseal } from "../app/lib/seal.server";
import { fromWithName } from "../app/services/email.server";

describe("seal", () => {
  it("round-trips, and rejects tampering, another purpose and expiry", () => {
    const tok = seal("a", { shop: "x.myshopify.com" }, 1000, 0);
    expect(unseal("a", tok, 500)).toMatchObject({ shop: "x.myshopify.com" });
    expect(unseal("b", tok, 500)).toBeNull();
    expect(unseal("a", tok, 2000)).toBeNull();
    const bad = tok.slice(0, -2) + (tok.endsWith("A") ? "BB" : "AA");
    expect(unseal("a", bad, 500)).toBeNull();
    expect(unseal("a", "garbage", 500)).toBeNull();
  });
});

describe("email sender", () => {
  it("shows the given name with the verified address", () => {
    expect(fromWithName("Keha <mail@keha.io>", "Acme \"Shop\"")).toBe('"Acme Shop" <mail@keha.io>');
    expect(fromWithName("mail@keha.io", "")).toBe("mail@keha.io");
  });
});
