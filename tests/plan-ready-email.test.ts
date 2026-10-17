/**
 * "Your order plan is ready" (owner 2026-10-17): the composer (translated, unsubscribe link,
 * gaps line) and when it is sent — once per store ever (OwnerEmailLog insert-before-send), only
 * after the first read finished recently and a full plan was computed, never while the Monday
 * email is off, without email sending, without an app URL or a recipient; the compute job calls it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb, Row } from "./helpers/fake-prisma";

const m = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }) as { ok: true } | { ok: false; reason: string }),
  transport: { on: true },
  readiness: vi.fn(async () => ({ ready: true }) as { ready: boolean }),
}));

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] });
  // OwnerEmailLog is unique on (shop, kind, periodKey), like the real table.
  const log = db.client.ownerEmailLog as { create: (a: { data: Row }) => Promise<Row> };
  const create = log.create;
  log.create = async (a) => {
    const rows = db.tables.ownerEmailLog ?? [];
    if (rows.some((r) => r.shop === a.data.shop && r.kind === a.data.kind && r.periodKey === a.data.periodKey)) throw new Error("Unique constraint failed");
    return create({ data: { status: "SENT", error: null, ...a.data } });
  };
  return { default: db.client, __fake: db };
});
vi.mock("../app/services/email.server", () => ({
  sendEmail: m.sendEmail,
  emailTransportConfigured: () => m.transport.on,
}));
vi.mock("../app/shopify.server", () => ({
  unauthenticated: {
    admin: async () => ({
      admin: { graphql: async () => ({ json: async () => ({ data: { shop: { name: "Acme Shoes", email: "owner@acme.test", contactEmail: null } } }) }) },
    }),
  },
}));
vi.mock("../app/services/shop-locale.server", () => ({ readShopLocale: async () => "es" }));
vi.mock("../app/models/dashboard.server", () => ({ getPlanReadiness: m.readiness }));

import * as dbModule from "../app/db.server";
import { maybeSendPlanReadyEmail } from "../app/services/plan-ready.server";
import { PLAN_READY_KIND, composePlanReadyEmail, planReadyInWindow } from "../app/lib/plan-ready-email-shared";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const NOW = new Date("2026-10-17T12:00:00Z");
const FINISHED = "2026-10-17T10:00:00.000Z";

function seed(over: { settings?: unknown; finishedAt?: string | null; computedAt?: string | null; uninstalledAt?: Date | null } = {}) {
  fake.reset();
  fake.tables.shop = [
    {
      domain: S,
      locale: "es",
      uninstalledAt: over.uninstalledAt ?? null,
      settings: over.settings ?? {},
      backfillState: {
        range: { from: "2025-09-01", until: "2026-10-16" },
        finishedAt: over.finishedAt === undefined ? FINISHED : over.finishedAt,
        datasets: { visits: { done: 14, total: 14, degraded: true, skippedMonths: ["2026-03-01"] } },
      },
    },
  ];
  const computedAt = over.computedAt === undefined ? "2026-10-17T10:05:00.000Z" : over.computedAt;
  fake.tables.moneyAtStake = computedAt
    ? [{ shop: S, day: new Date("2026-10-16T00:00:00Z"), basis: { computedAt, atRisk: {}, lost90: {}, cashStuck: {}, soldOutTraffic: {} } }]
    : [];
}

beforeAll(() => {
  process.env.SHOPIFY_APP_URL = "https://inventory.example.test";
  process.env.SHOPIFY_API_SECRET = "test-secret-for-seal";
});
afterAll(() => {
  delete process.env.SHOPIFY_APP_URL;
});
beforeEach(() => {
  m.sendEmail.mockClear();
  m.transport.on = true;
  m.readiness.mockResolvedValue({ ready: true });
});

describe("composer", () => {
  const input = { locale: "en" as const, storeName: "Acme", months: 14, gaps: false, links: { app: "https://admin.shopify.com/store/acme/apps/keha-inventory/app", unsubscribe: "https://x.test/u?token=a&b" } };

  it("subject, body, one button into the app and the unsubscribe link; HTML escaped", () => {
    const e = composePlanReadyEmail(input);
    expect(e.subject).toBe("Your order plan is ready");
    expect(e.text).toContain("Your order plan for Acme is ready");
    expect(e.text).toContain("We've finished reading 14 months of sales, stock and store visits");
    expect(e.text).toContain(`Open your order plan: ${input.links.app}`);
    expect(e.text).toContain(`Unsubscribe: ${input.links.unsubscribe}`);
    expect(e.html).toContain('href="https://x.test/u?token=a&amp;b"');
    expect(e.html).not.toContain("A few months couldn");
    expect(composePlanReadyEmail({ ...input, gaps: true }).text).toContain("A few months couldn't be read; your plan uses the others.");
  });

  it("in the store's language", () => {
    const e = composePlanReadyEmail({ ...input, locale: "de" });
    expect(e.subject).toBe("Dein Bestellplan ist fertig");
    expect(e.text).toContain("Abmelden");
  });

  it("only for a read that finished in the last 7 days", () => {
    expect(planReadyInWindow(FINISHED, NOW)).toBe(true);
    expect(planReadyInWindow("2026-10-01T00:00:00Z", NOW)).toBe(false);
    expect(planReadyInWindow(null, NOW)).toBe(false);
  });
});

describe("when it is sent", () => {
  it("once: the first call sends, every later one is skipped (one log row)", async () => {
    seed();
    expect(await maybeSendPlanReadyEmail(S, NOW)).toBe("sent");
    expect(await maybeSendPlanReadyEmail(S, NOW)).toBe("skipped:already_sent");
    expect(await maybeSendPlanReadyEmail(S, new Date(NOW.getTime() + 3600_000))).toBe("skipped:already_sent");
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(fake.tables.ownerEmailLog.filter((r) => r.kind === PLAN_READY_KIND)).toHaveLength(1);
    const sent = m.sendEmail.mock.calls[0][0] as { to: string; subject: string; text: string; headers: Record<string, string> };
    expect(sent.to).toBe("owner@acme.test");
    expect(sent.subject).toBe("Tu plan de pedidos está listo"); // the store's language
    expect(sent.text).toContain("https://admin.shopify.com/store/acme/apps/");
    expect(sent.text).toContain("No se han podido leer algunos meses"); // visits skipped a month
    expect(sent.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/inventory\.example\.test\/email\/unsubscribe\?token=/);
    expect(sent.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("two compute jobs at once still send one email (the insert before sending)", async () => {
    seed();
    const r = await Promise.all([maybeSendPlanReadyEmail(S, NOW), maybeSendPlanReadyEmail(S, NOW)]);
    expect(r.filter((x) => x === "sent")).toHaveLength(1);
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("to the Monday-email recipients when the store chose them", async () => {
    seed({ settings: { mondayEmail: { enabled: true, recipients: ["buyer@acme.test", "nope"] } } });
    expect(await maybeSendPlanReadyEmail(S, NOW)).toBe("sent");
    expect((m.sendEmail.mock.calls[0][0] as { to: unknown }).to).toBe("buyer@acme.test");
  });

  it("not sent: Monday email off, no email sending, uninstalled, read not finished or too old, plan not ready or not rebuilt", async () => {
    seed({ settings: { mondayEmail: { enabled: false } } });
    expect(await maybeSendPlanReadyEmail(S, NOW)).toBe("skipped:unsubscribed");
    seed();
    m.transport.on = false;
    expect(await maybeSendPlanReadyEmail(S, NOW)).toBe("skipped:no_transport");
    m.transport.on = true;
    seed({ uninstalledAt: new Date("2026-10-17T11:00:00Z") });
    expect(await maybeSendPlanReadyEmail(S, NOW)).toBe("skipped:not_installed");
    seed({ finishedAt: null });
    expect(await maybeSendPlanReadyEmail(S, NOW)).toBe("skipped:not_finished");
    seed({ finishedAt: "2026-09-01T00:00:00.000Z" });
    expect(await maybeSendPlanReadyEmail(S, NOW)).toBe("skipped:too_old");
    seed({ computedAt: "2026-10-17T09:00:00.000Z" }); // the 90-day plan, before the read finished
    expect(await maybeSendPlanReadyEmail(S, NOW)).toBe("skipped:not_built");
    seed();
    m.readiness.mockResolvedValueOnce({ ready: false });
    expect(await maybeSendPlanReadyEmail(S, NOW)).toBe("skipped:not_ready");
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("a failed send is logged and retried once later (the owner-email rule), never twice at once", async () => {
    seed();
    m.sendEmail.mockResolvedValueOnce({ ok: false, reason: "provider_500" });
    expect(await maybeSendPlanReadyEmail(S, NOW)).toBe("failed");
    expect(await maybeSendPlanReadyEmail(S, new Date(NOW.getTime() + 60_000))).toBe("skipped");
    expect(await maybeSendPlanReadyEmail(S, new Date(NOW.getTime() + 2 * 3600_000))).toBe("sent");
    expect(m.sendEmail).toHaveBeenCalledTimes(2);
  });
});
