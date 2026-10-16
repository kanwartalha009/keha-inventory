/**
 * ownerContact reads the store's language separately from the shop (shopLocales needs
 * read_locales): a denied language read still returns the owner, in English.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ denyLocales: false, queries: [] as string[] }));

vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/shopify.server", () => ({
  unauthenticated: {
    admin: vi.fn(async () => ({
      admin: {
        graphql: async (query: string) => {
          h.queries.push(query);
          if (query.includes("shopLocales")) {
            if (h.denyLocales) throw new Error("GraphQL Client: Access denied for shopLocales field. Required access: `read_locales` access scope.");
            return new Response(JSON.stringify({ data: { shopLocales: [{ locale: "en", primary: false }, { locale: "es", primary: true }] } }));
          }
          return new Response(JSON.stringify({ data: { shop: { name: "Acme Shoes", email: "owner@acme.test", contactEmail: null } } }));
        },
      },
    })),
  },
}));

import { ownerContact } from "../app/services/owner-email.server";

beforeEach(() => {
  h.queries.length = 0;
  h.denyLocales = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("ownerContact", () => {
  it("reads the shop, then the primary language", async () => {
    expect(await ownerContact("acme.myshopify.com")).toEqual({ name: "Acme Shoes", to: "owner@acme.test", locale: "es" });
    expect(h.queries[0]).not.toContain("shopLocales");
    expect(h.queries[1]).toContain("shopLocales");
  });

  it("still returns the owner, in English, when shopLocales is denied", async () => {
    h.denyLocales = true;
    expect(await ownerContact("denied.myshopify.com", "ops@acme.test")).toEqual({
      name: "Acme Shoes",
      to: "ops@acme.test",
      locale: "en",
    });
  });
});
