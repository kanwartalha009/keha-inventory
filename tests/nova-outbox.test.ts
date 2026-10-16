/**
 * Nova outbox (2026-09-28): the first delivery attempt runs inside Shopify
 * webhook handlers, so it must give up quickly when Nova is unreachable (the
 * row stays PENDING for the scheduler), and a delivered row drops its payload.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const { updates } = vi.hoisted(() => {
  process.env.NOVA_API = "https://nova.test";
  return { updates: [] as Record<string, unknown>[] };
});
vi.mock("../app/db.server", () => ({
  default: {
    novaOutbox: {
      create: async () => ({ id: "row1" }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
      },
    },
  },
}));

import { forwardToIngress, IMMEDIATE_TIMEOUT_MS, novaTopic } from "../app/lib/nova.server";

afterEach(() => {
  updates.length = 0;
  vi.unstubAllGlobals();
});

describe("outbox immediate delivery", () => {
  it("gives up after the short time limit and leaves the row for retry", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason))),
    );
    const t0 = Date.now();
    await forwardToIngress({ topic: "shop/redact", shopDomain: "a.myshopify.com", webhookId: "w1", payload: {} });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(IMMEDIATE_TIMEOUT_MS - 50);
    expect(took).toBeLessThan(IMMEDIATE_TIMEOUT_MS + 1500);
    expect(updates[0]).toMatchObject({ status: "PENDING", attempts: 1 });
  }, 10_000);

  it("drops the payload once delivered", async () => {
    vi.stubGlobal("fetch", async () => new Response("ok", { status: 200 }));
    await forwardToIngress({ topic: "customers/redact", shopDomain: "a.myshopify.com", webhookId: "w2", payload: { customer: { email: "a@b.c" } } });
    expect(updates[0]).toMatchObject({ status: "SENT", body: "" });
  });
});

describe("topics sent to Nova", () => {
  it("uses Shopify's slash form, which Nova matches", () => {
    // authenticate.webhook hands routes the storage form (APP_UNINSTALLED).
    expect(novaTopic("APP_UNINSTALLED")).toBe("app/uninstalled");
    expect(novaTopic("CUSTOMERS_DATA_REQUEST")).toBe("customers/data_request");
    expect(novaTopic("CUSTOMERS_REDACT")).toBe("customers/redact");
    expect(novaTopic("SHOP_REDACT")).toBe("shop/redact");
    expect(novaTopic("APP_SUBSCRIPTIONS_UPDATE")).toBe("app_subscriptions/update");
    expect(novaTopic("app_subscriptions/update")).toBe("app_subscriptions/update");
  });
});
