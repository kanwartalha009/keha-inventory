/** Post-approval backlog C7: the first partner link keeps the referral; a lapsed one can be replaced. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, { shop: string; ref: string; createdAt: Date }>();
vi.mock("../app/db.server", () => ({
  default: {
    novaReferral: {
      findUnique: vi.fn(async ({ where }: { where: { shop: string } }) => rows.get(where.shop) ?? null),
      create: vi.fn(async ({ data }: { data: { shop: string; ref: string } }) => {
        if (rows.has(data.shop)) throw new Error("unique");
        rows.set(data.shop, { ...data, createdAt: new Date("2026-10-01T00:00:00Z") });
      }),
      update: vi.fn(async ({ where, data }: { where: { shop: string }; data: { ref: string; createdAt: Date } }) => {
        rows.set(where.shop, { shop: where.shop, ...data });
      }),
    },
  },
}));

import { storeReferral, REFERRAL_KEEP_DAYS } from "../app/lib/referral.server";

describe("storeReferral", () => {
  beforeEach(() => rows.clear());
  it("keeps the first partner's code", async () => {
    await storeReferral("a.myshopify.com", "first", new Date("2026-10-02T00:00:00Z"));
    await storeReferral("a.myshopify.com", "second", new Date("2026-10-03T00:00:00Z"));
    expect(rows.get("a.myshopify.com")?.ref).toBe("first");
  });
  it(`a code older than ${REFERRAL_KEEP_DAYS} days can be replaced`, async () => {
    await storeReferral("a.myshopify.com", "first");
    await storeReferral("a.myshopify.com", "second", new Date("2026-11-15T00:00:00Z"));
    expect(rows.get("a.myshopify.com")?.ref).toBe("second");
  });
  it("never throws", async () => {
    rows.set("b.myshopify.com", null as never);
    await expect(storeReferral("b.myshopify.com", "x")).resolves.toBeUndefined();
  });
});
