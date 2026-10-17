/** reviewAskDue / recordReviewAsk against the fake database: moments, the 24 h wait, asking once. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma();
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { reviewAskDue } from "../app/models/dashboard.server";
import { recordReviewAsk } from "../app/models/settings.server";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const SHOP = "acme.myshopify.com";
const NOW = new Date("2026-10-17T10:00:00Z");

beforeEach(() => {
  db.reset();
  db.tables.shop = [{ domain: SHOP, installedAt: new Date("2026-10-01T00:00:00Z"), settings: { leadTimeDays: 21 } }];
  db.tables.purchaseOrder = [];
  db.tables.accuracyMonth = [];
  db.tables.clearance = [];
});

describe("review request (database)", () => {
  it("nothing to celebrate yet: no ask", async () => {
    expect(await reviewAskDue(SHOP, NOW)).toBeNull();
  });

  it("a supplier confirmed a ship date (Keha orders only)", async () => {
    db.tables.purchaseOrder = [{ shop: SHOP, source: "shopify", confirmedShipDate: new Date() }];
    expect(await reviewAskDue(SHOP, NOW)).toBeNull();
    db.tables.purchaseOrder.push({ shop: SHOP, source: "keha", confirmedShipDate: new Date("2026-10-20T00:00:00Z") });
    expect(await reviewAskDue(SHOP, NOW)).toBe("supplier_confirmed");
  });

  it("last month's store total within target, or a clearance discount", async () => {
    db.tables.accuracyMonth = [
      { shop: SHOP, month: new Date("2026-08-01T00:00:00Z"), storeErrorPct: 5 },
      { shop: SHOP, month: new Date("2026-09-01T00:00:00Z"), storeErrorPct: 40 },
    ];
    expect(await reviewAskDue(SHOP, NOW)).toBeNull(); // the latest month counts
    db.tables.clearance = [{ shop: SHOP }];
    expect(await reviewAskDue(SHOP, NOW)).toBe("clearance");
  });

  it("not within 24 h of install, and once only (other settings kept)", async () => {
    db.tables.clearance = [{ shop: SHOP }];
    db.tables.shop[0]!.installedAt = new Date("2026-10-16T12:00:00Z");
    expect(await reviewAskDue(SHOP, NOW)).toBeNull();
    db.tables.shop[0]!.installedAt = new Date("2026-10-01T00:00:00Z");
    expect(await recordReviewAsk(SHOP, "success", NOW)).toBe(true);
    expect(db.tables.shop[0]!.settings).toEqual({ leadTimeDays: 21, reviewAsk: { askedAt: NOW.toISOString(), code: "success" } });
    expect(await recordReviewAsk(SHOP, "cooldown-period", NOW)).toBe(false);
    expect(await reviewAskDue(SHOP, NOW)).toBeNull();
  });
});
