/**
 * "Email supplier" abuse limits (review fix 2026-10-17) on an in-memory
 * Prisma: one email per order per 10 minutes, 50 per store per UTC day,
 * claimed atomically in OwnerEmailLog and given back when the send fails.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"], ownerEmailLog: ["shop", "kind", "periodKey"] });
  return { default: db.client, __fake: db };
});
const { sendEmail } = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }) as { ok: true } | { ok: false; reason: string }),
}));
vi.mock("../app/services/email.server", () => ({ emailTransportConfigured: () => true, sendEmail: (i: Record<string, unknown>) => sendEmail(i) }));
vi.mock("../app/services/shop-contact.server", () => ({
  getShopContact: async () => ({ name: "Acme Store", contactEmail: "hello@acme.test", ownerEmail: "owner@acme.test" }),
}));
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: vi.fn() } }));
// Buyer and ship-to blocks (merchant audit 2026-10-18): what Shopify would answer.
vi.mock("../app/services/po-parties.server", () => ({
  poBuyer: async () => ({ name: "Acme Retail SL", lines: ["Calle Mayor 1", "28013 Madrid"] }),
  poShipTo: async (_shop: string, id: string) => (id === "L2" ? { name: "Getafe warehouse", lines: ["Polígono Sur 4"] } : null),
}));

import * as dbModule from "../app/db.server";
import { emailSupplier } from "../app/services/po-email.server";
import { SUPPLIER_EMAIL_DAILY_CAP, SUPPLIER_EMAIL_DAY_KIND } from "../app/lib/po-email-shared";
import { fill, translate } from "../app/lib/i18n";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const NOW = new Date("2026-10-17T09:00:00Z");
const MIN = 60_000;
const at = (min: number) => new Date(NOW.getTime() + min * MIN);

beforeAll(() => {
  process.env.SHOPIFY_APP_URL = "https://inventory.test";
});

beforeEach(() => {
  fake.reset();
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ ok: true });
  fake.tables.shop = [{ domain: S, locale: "en", currency: "EUR", timezone: "UTC", settings: {} }];
  fake.tables.supplier = [{ id: "s1", shop: S, name: "Acme Textiles", email: "orders@supplier.test", leadTimeDays: 21, hidePrices: false }];
  fake.tables.purchaseOrder = ["po1", "po2"].map((id, i) => ({
    id,
    shop: S,
    number: `PO-000${i + 1}`,
    status: "sent",
    source: "keha",
    supplierId: "s1",
    supplierName: "Acme Textiles",
    lines: [{ variantId: "gid://shopify/ProductVariant/1", qty: 6, unitCost: 2, productTitle: "Shirt", variantTitle: "M", sku: "S-M" }],
    confirmToken: `${id}`.padEnd(43, "x"),
    confirmExpiresAt: at(60 * 24 * 30),
    confirmedShipDate: null,
    expectedDate: null,
    currency: "EUR",
    createdAt: NOW,
  }));
});

describe("supplier email limits", () => {
  it("one email per order per 10 minutes; other orders aren't held up", async () => {
    expect(await emailSupplier(S, "po1", NOW)).toEqual({ ok: true, markedSent: false });
    expect(await emailSupplier(S, "po1", at(9))).toEqual({ ok: false, error: "cooldown" });
    expect(await emailSupplier(S, "po2", at(9))).toMatchObject({ ok: true });
    expect(await emailSupplier(S, "po1", at(10))).toMatchObject({ ok: true });
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });

  it("two clicks at once send one email", async () => {
    const [a, b] = await Promise.all([emailSupplier(S, "po1", NOW), emailSupplier(S, "po1", NOW)]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, error: "cooldown" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a failed send gives the claim back, so the merchant can retry at once", async () => {
    sendEmail.mockResolvedValueOnce({ ok: false, reason: "provider_500" });
    expect(await emailSupplier(S, "po1", NOW)).toEqual({ ok: false, error: "failed" });
    expect(await emailSupplier(S, "po1", at(1))).toMatchObject({ ok: true });
    expect(fake.tables.ownerEmailLog!.filter((r) => r.kind === SUPPLIER_EMAIL_DAY_KIND)).toHaveLength(1);
  });

  it(`at most ${SUPPLIER_EMAIL_DAILY_CAP} per store per UTC day; the next day works again`, async () => {
    fake.tables.ownerEmailLog = Array.from({ length: SUPPLIER_EMAIL_DAILY_CAP }, (_x, i) => ({
      shop: S,
      kind: SUPPLIER_EMAIL_DAY_KIND,
      periodKey: `2026-10-17#${i + 1}`,
      sentAt: NOW,
    }));
    expect(await emailSupplier(S, "po1", NOW)).toEqual({ ok: false, error: "dailyCap" });
    expect(sendEmail).not.toHaveBeenCalled();
    // The refused send didn't start the order's 10-minute wait.
    expect(fake.tables.ownerEmailLog!.some((r) => r.periodKey === "order:po1")).toBe(false);
    // Tomorrow is a new day.
    expect(await emailSupplier(S, "po1", new Date("2026-10-18T00:05:00Z"))).toMatchObject({ ok: true });
  });
});

describe("supplier email language and details (merchant audit 2026-10-18)", () => {
  const mail = () => sendEmail.mock.calls[0]![0] as { subject: string; text: string };

  it("goes out in the supplier's PO language, not the store's", async () => {
    fake.tables.shop![0]!.locale = "es";
    fake.tables.supplier![0]!.poLanguage = "de";
    expect(await emailSupplier(S, "po1", NOW)).toMatchObject({ ok: true });
    const german = fill(translate("de", "Purchase order {number} from {store}"), { number: "PO-0001", store: "Acme Store" });
    expect(german).not.toBe("Purchase order PO-0001 from Acme Store");
    expect(mail().subject).toBe(german);
    expect(mail().text).toContain(translate("de", "Buyer"));
  });

  it("defaults to English, with buyer, ship-to and the note", async () => {
    fake.tables.shop![0]!.locale = "es";
    fake.tables.location = [{ id: "L2", shop: S, name: "Getafe warehouse", active: true, online: true, role: "warehouse" }];
    fake.tables.purchaseOrder![0]!.note = "Label cartons with the PO number";
    expect(await emailSupplier(S, "po1", NOW)).toMatchObject({ ok: true });
    expect(mail().subject).toBe("Purchase order PO-0001 from Acme Store");
    expect(mail().text).toContain("Buyer: Acme Retail SL, Calle Mayor 1, 28013 Madrid");
    expect(mail().text).toContain("Ship to: Getafe warehouse, Polígono Sur 4");
    expect(mail().text).toContain("Note: Label cartons with the PO number");
  });
});
