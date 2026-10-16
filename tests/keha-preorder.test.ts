/**
 * Keha Preorder detection (task 2.3, spec §4 J4, Shopify rule 2.2.6):
 * appByHandle → installation, cached per shop, never blocking Home, and any
 * error counts as "not installed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetPreorderCache, kehaPreorderInstalled } from "../app/services/keha-preorder.server";

const SHOP = "acme.myshopify.com";
const reply = (body: unknown) => new Response(JSON.stringify(body));

beforeEach(() => {
  _resetPreorderCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe("kehaPreorderInstalled", () => {
  it("installed when the app has an installation on this shop; cached for the next page", async () => {
    const graphql = vi.fn(async (_q: string, _o?: { variables?: Record<string, unknown> }) =>
      reply({ data: { appByHandle: { id: "gid://shopify/App/1", installation: { id: "gid://shopify/AppInstallation/2" } } } }),
    );
    expect(await kehaPreorderInstalled({ graphql }, SHOP)).toBe(true);
    expect(await kehaPreorderInstalled({ graphql }, SHOP)).toBe(true);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql.mock.calls[0]![1]).toEqual({ variables: { handle: "keha-preorder" } });
  });

  it("not installed: no installation, unknown app, GraphQL errors or a throw", async () => {
    for (const body of [
      { data: { appByHandle: { id: "gid://shopify/App/1", installation: null } } },
      { data: { appByHandle: null } },
      { errors: [{ message: "Access denied" }] },
    ]) {
      _resetPreorderCache();
      expect(await kehaPreorderInstalled({ graphql: async () => reply(body) }, SHOP)).toBe(false);
    }
    _resetPreorderCache();
    expect(await kehaPreorderInstalled({ graphql: async () => Promise.reject(new Error("boom")) }, SHOP)).toBe(false);
  });

  it("a slow answer doesn't block the page; it fills the cache for the next one", async () => {
    let resolve!: (r: Response) => void;
    const graphql = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    expect(await kehaPreorderInstalled({ graphql }, SHOP, 10)).toBe(false);
    resolve(reply({ data: { appByHandle: { id: "a", installation: { id: "i" } } } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(await kehaPreorderInstalled({ graphql }, SHOP, 10)).toBe(true);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("re-checks after the cache expires", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-19T08:00:00Z") });
    const graphql = vi.fn(async () => reply({ data: { appByHandle: { id: "a", installation: null } } }));
    expect(await kehaPreorderInstalled({ graphql }, SHOP)).toBe(false);
    vi.setSystemTime(new Date("2026-10-19T09:00:01Z"));
    expect(await kehaPreorderInstalled({ graphql }, SHOP)).toBe(false);
    expect(graphql).toHaveBeenCalledTimes(2);
  });
});
