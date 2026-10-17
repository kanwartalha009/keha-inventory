/**
 * firstSaleDay (models/dashboard.server, listing audit 2026-10-18): the store's earliest sales
 * day — what the "plan is ready" notice and email count the months of sales from — read with one
 * MIN(day) per shop; null when the store has no sales; other shops never count.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma();
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { firstSaleDay } from "../app/models/dashboard.server";
import { useFakeFacts } from "./helpers/fake-facts";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const SHOP = "acme.myshopify.com";
const row = (shop: string, day: string, locationKey = "all") => ({
  shop,
  day: new Date(`${day}T00:00:00.000Z`),
  variantId: "gid://shopify/ProductVariant/1",
  locationKey,
  channel: "online",
  sold: 1,
  returned: 0,
  gross: 10,
});

beforeEach(() => {
  db.reset();
  useFakeFacts(db);
  db.tables.salesDaily = [];
});

describe("firstSaleDay", () => {
  it("null when the store has no sales", async () => {
    db.tables.salesDaily = [row("other.myshopify.com", "2024-01-01")];
    expect(await firstSaleDay(SHOP)).toBeNull();
  });

  it("the earliest sales day of this store only", async () => {
    db.tables.salesDaily = [row(SHOP, "2026-07-10"), row(SHOP, "2026-03-02", "loc-1"), row(SHOP, "2026-09-01"), row("other.myshopify.com", "2024-01-01")];
    expect(await firstSaleDay(SHOP)).toBe("2026-03-02");
  });
});
