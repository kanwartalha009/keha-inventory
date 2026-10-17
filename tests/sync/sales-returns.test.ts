/**
 * storeSales (task 2.4 returns): the channel query asks for quantity_returned; when ShopifyQL
 * rejects it (parse error) the verified query without it is used, and returned stays 0.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "../helpers/fake-prisma";
import type { ShopifyqlClient } from "../../app/services/sync/shopifyql.server";
import { ShopifyqlParseError, type BuildOptions, type DayRange, type ParseResult, type SalesRow } from "../../app/lib/sync/shopifyql-shared";

vi.mock("../../app/db.server", async () => {
  const { createFakePrisma } = await import("../helpers/fake-prisma");
  const db = createFakePrisma({ salesDaily: ["shop", "day", "variantId", "locationKey", "channel"] });
  return { default: db.client, __fake: db };
});

import * as dbModule from "../../app/db.server";
import { storeSales } from "../../app/services/sync/facts.server";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const V = "gid://shopify/ProductVariant/1";
const RANGE: DayRange = { since: "2026-10-14", until: "2026-10-15" };
const res = (rows: SalesRow[], missing: string[]): ParseResult<SalesRow> => ({ rows, skipped: 0, missingColumns: missing });

function client(acceptReturns: boolean) {
  const seen: (BuildOptions | undefined)[] = [];
  const ql = {
    salesDailyByLocation: async () =>
      res([{ day: "2026-10-14", variantId: V, locationKey: "online", channel: "unknown", sold: 8, gross: 0, returned: 0 }], ["sales_channel", "gross_sales", "quantity_returned"]),
    salesTotalsDaily: async () => ({ rows: [{ day: "2026-10-14", sold: 8 }], skipped: 0, missingColumns: [] }),
    salesDailyByChannel: async (_r: DayRange, _t: string, o?: BuildOptions) => {
      seen.push(o);
      if (o?.returns && !acceptReturns) throw new ShopifyqlParseError(["Invalid column: quantity_returned"], "q");
      return res(
        [{ day: "2026-10-14", variantId: V, locationKey: "unknown", channel: "Online Store", sold: 8, gross: 200, returned: o?.returns ? -2 : 0 }],
        o?.returns ? ["pos_location_name"] : ["pos_location_name", "quantity_returned"],
      );
    },
  } as unknown as ShopifyqlClient;
  return { ql, seen };
}

beforeEach(() => {
  db.reset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("storeSales returns", () => {
  it("stores quantity_returned from the channel view when ShopifyQL accepts it", async () => {
    const { ql, seen } = client(true);
    await storeSales(S, ql, RANGE, "2026-10-16", []);
    expect(seen).toEqual([{ returns: true }]);
    expect(db.tables.salesDaily).toEqual([
      expect.objectContaining({ variantId: V, locationKey: "online", channel: "all", sold: 8 }),
      expect.objectContaining({ variantId: V, locationKey: "all", channel: "Online Store", sold: 8, returned: -2, gross: 200 }),
    ]);
  });

  it("falls back to the verified query on a parse error (returned 0)", async () => {
    const { ql, seen } = client(false);
    await storeSales(S, ql, RANGE, "2026-10-16", []);
    expect(seen).toEqual([{ returns: true }, undefined]);
    expect(db.tables.salesDaily.find((r) => r.channel === "Online Store")).toMatchObject({ sold: 8, returned: 0 });
    expect(console.warn).toHaveBeenCalled();
  });
});
