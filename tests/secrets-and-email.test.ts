/**
 * Kit security helpers: sealed tokens (signed, expiring, purpose-bound — for
 * supplier confirm links and email unsubscribe links) and the email sender line.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

beforeAll(() => {
  process.env.SHOPIFY_API_SECRET = "test-secret";
  process.env.APP_ENCRYPTION_KEY = "a".repeat(64);
});

import { seal, unseal } from "../app/lib/seal.server";
import { SecretStorageUnavailableError, decryptSecret, encryptSecret, secretsWritable } from "../app/lib/crypto.server";
import { supplierErrorText } from "../app/lib/suppliers-shared";
import { fromWithName, sendEmail } from "../app/services/email.server";

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

describe("secrets at rest (APP_ENCRYPTION_KEY)", () => {
  const withEnv = (key: string | undefined, node: string, fn: () => void) => {
    const saved = { key: process.env.APP_ENCRYPTION_KEY, node: process.env.NODE_ENV };
    if (key === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = key;
    process.env.NODE_ENV = node;
    try {
      fn();
    } finally {
      process.env.APP_ENCRYPTION_KEY = saved.key;
      process.env.NODE_ENV = saved.node;
    }
  };
  const legacy = "plain:" + Buffer.from("orders@supplier.test", "utf8").toString("base64");

  it("a valid key: AES-256-GCM round trip, never the plain value", () => {
    withEnv("ab".repeat(32), "production", () => {
      const stored = encryptSecret("orders@supplier.test");
      expect(stored).toMatch(/^gcm:/);
      expect(stored).not.toContain("orders@");
      expect(decryptSecret(stored)).toBe("orders@supplier.test");
      expect(secretsWritable()).toBe(true);
    });
  });

  it("production without a valid key refuses to store; a 64-char non-hex key counts as no key and never throws a crypto error", () => {
    for (const key of [undefined, "", "abc", "z".repeat(64), `${"ab".repeat(31)}g1`]) {
      withEnv(key, "production", () => {
        expect(secretsWritable()).toBe(false);
        expect(() => encryptSecret("orders@supplier.test")).toThrow(SecretStorageUnavailableError);
        // Legacy `plain:` values stay readable.
        expect(decryptSecret(legacy)).toBe("orders@supplier.test");
      });
    }
  });

  it("dev without a key: the reversible `plain:` form (and a non-hex key doesn't throw)", () => {
    withEnv("z".repeat(64), "development", () => {
      expect(secretsWritable()).toBe(true);
      const stored = encryptSecret("x@y.test");
      expect(stored).toMatch(/^plain:/);
      expect(decryptSecret(stored)).toBe("x@y.test");
    });
  });

  it("the supplier form's storage error is a translatable message", () => {
    expect(supplierErrorText("emailStorage", (s) => s)).toBe("Secure storage isn't set up for this app yet, so this can't be saved. Contact Keha support.");
  });
});

describe("email sender", () => {
  it("shows the given name with the verified address", () => {
    expect(fromWithName("Keha <mail@keha.io>", "Acme \"Shop\"")).toBe('"Acme Shop" <mail@keha.io>');
    expect(fromWithName("mail@keha.io", "")).toBe("mail@keha.io");
  });
});

describe("sendEmail payload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.INVENTORY_EMAIL_API_KEY;
    delete process.env.INVENTORY_EMAIL_FROM;
  });

  function capture() {
    process.env.INVENTORY_EMAIL_API_KEY = "k";
    process.env.INVENTORY_EMAIL_FROM = "Keha <mail@keha.io>";
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response("{}", { status: 200 });
    }));
    return bodies;
  }

  it("sends the optional HTML part next to the text, and stays text-only without it", async () => {
    const bodies = capture();
    expect(await sendEmail({ to: "a@x.test", subject: "S", text: "T", html: "<p>T</p>" })).toEqual({ ok: true });
    expect(bodies[0]).toMatchObject({ to: ["a@x.test"], subject: "S", text: "T", html: "<p>T</p>" });
    await sendEmail({ to: "a@x.test", subject: "S", text: "T" });
    expect(bodies[1]).not.toHaveProperty("html");
    expect(bodies[1]).toMatchObject({ to: ["a@x.test"], text: "T" });
  });

  it("accepts several recipients and refuses none", async () => {
    const bodies = capture();
    await sendEmail({ to: ["a@x.test", "b@x.test"], subject: "S", text: "T" });
    expect(bodies[0].to).toEqual(["a@x.test", "b@x.test"]);
    expect(await sendEmail({ to: [], subject: "S", text: "T" })).toEqual({ ok: false, reason: "no_recipient" });
    expect(bodies).toHaveLength(1);
  });
});
