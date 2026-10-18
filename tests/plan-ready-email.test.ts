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
  firstSale: vi.fn(async () => "2025-09-01" as string | null),
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
vi.mock("../app/models/dashboard.server", () => ({ getPlanReadiness: m.readiness, firstSaleDay: m.firstSale }));

import * as dbModule from "../app/db.server";
import { maybeSendPlanReadyEmail } from "../app/services/plan-ready.server";
import { PLAN_READY_KIND, composePlanReadyEmail, planReadyInWindow } from "../app/lib/plan-ready-email-shared";
import { salesSpan } from "../app/lib/sync-progress-shared";
import { translate } from "../app/lib/i18n";

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
  m.firstSale.mockResolvedValue("2025-09-01");
});

describe("composer", () => {
  const input = { locale: "en" as const, storeName: "Acme", span: salesSpan("2025-08-01", "2026-10-16"), gaps: false, links: { app: "https://admin.shopify.com/store/acme/apps/keha-inventory/app", unsubscribe: "https://x.test/u?token=a&b" } };

  it("subject, body, one button into the app and the unsubscribe link; HTML escaped", () => {
    const e = composePlanReadyEmail(input);
    expect(e.subject).toBe("Your order plan is ready");
    expect(e.text).toContain("Your order plan for Acme is ready");
    expect(e.text).toContain("We've finished reading your sales, stock and store visits. We read 14 months of your sales, so your plan reflects your seasons.");
    expect(e.text).toContain(`Open your order plan: ${input.links.app}`);
    expect(e.text).toContain(`Unsubscribe: ${input.links.unsubscribe}`);
    expect(e.html).toContain('href="https://x.test/u?token=a&amp;b"');
    expect(e.html).not.toContain("A few months couldn");
    expect(composePlanReadyEmail({ ...input, gaps: true }).text).toContain("A few months couldn't be read; your plan uses the others.");
  });

  it("says the months of sales really read, never the read window (listing audit 2026-10-18)", () => {
    const body = (first: string | null) => composePlanReadyEmail({ ...input, span: salesSpan(first, "2026-10-16") }).text;
    // 3 months: no seasons claim.
    expect(body("2026-07-10")).toContain("We read your 3 months of sales.");
    expect(body("2026-07-10")).not.toMatch(/seasons|14 months/);
    // 13 months: seasons.
    expect(body("2025-09-10")).toContain("We read 13 months of your sales, so your plan reflects your seasons.");
    // 14+ months of sales: capped at the 14-month read window.
    expect(body("2020-01-01")).toContain("We read 14 months of your sales, so your plan reflects your seasons.");
    // No sales at all: an honest line.
    expect(body(null)).toContain("We didn't find any sales yet. Your plan fills in as sales come in.");
    expect(body(null)).not.toMatch(/months of/);
    // Translated.
    expect(composePlanReadyEmail({ ...input, locale: "es", span: salesSpan("2026-07-10", "2026-10-16") }).text).toContain("Hemos leído tus 3 meses de ventas.");
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
    // First sale 2025-09-01, read through 2026-10-16: 13 months, so seasons (store's language).
    expect(sent.text).toContain("Hemos leído 13 meses de tus ventas, así que tu plan refleja tus temporadas.");
    expect(sent.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/inventory\.example\.test\/email\/unsubscribe\?token=/);
    expect(sent.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("two compute jobs at once still send one email (the insert before sending)", async () => {
    seed();
    const r = await Promise.all([maybeSendPlanReadyEmail(S, NOW), maybeSendPlanReadyEmail(S, NOW)]);
    expect(r.filter((x) => x === "sent")).toHaveLength(1);
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a young store: its real months of sales, not the 14-month read window", async () => {
    seed();
    m.firstSale.mockResolvedValue("2026-07-01");
    expect(await maybeSendPlanReadyEmail(S, NOW)).toBe("sent");
    const sent = m.sendEmail.mock.calls[0][0] as { text: string };
    expect(sent.text).toContain("Hemos leído tus 3 meses de ventas.");
    expect(sent.text).not.toContain("14");
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

describe("Shopify Flow 'First order plan ready' (owner decision 2026-10-18: no email provider)", () => {
  type Call = { query: string; variables?: { handle?: string; payload?: Record<string, string> } };
  const admin = (answer: unknown = { data: { flowTriggerReceive: { userErrors: [] } } }) => {
    const calls: Call[] = [];
    return {
      calls,
      deps: { getAdmin: async () => ({ graphql: async (query: string, o?: { variables?: Record<string, unknown> }) => (calls.push({ query, variables: o?.variables as Call["variables"] }), { json: async () => answer }) }) },
    };
  };
  const flowRows = () => (fake.tables.ownerEmailLog ?? []).filter((r) => r.kind === "plan_ready_flow");

  it("without an email provider: fires once with subject, summary and the order plan link; no email", async () => {
    seed({ settings: { mondayEmail: { enabled: false, recipients: [] } } });
    m.transport.on = false;
    const a = admin();
    expect(await maybeSendPlanReadyEmail(S, NOW, a.deps)).toBe("skipped:no_transport");
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]!.query).toContain("flowTriggerReceive");
    expect(a.calls[0]!.variables?.handle).toBe("first-order-plan-ready");
    const p = a.calls[0]!.variables!.payload!;
    expect(Object.keys(p).sort()).toEqual(["Order plan link", "Subject", "Summary text"]);
    // In the store's language (es), without the email footer or unsubscribe link.
    expect(p.Subject).toBe(translate("es", "Your order plan is ready"));
    expect(p["Summary text"]).toContain("Acme Shoes");
    expect(p["Summary text"]).not.toMatch(/unsubscribe|Darse de baja/i);
    expect(p["Order plan link"]).toBe("https://admin.shopify.com/store/acme/apps/keha-inventory/app");
    expect(flowRows()).toHaveLength(1);
    // Once per store.
    await maybeSendPlanReadyEmail(S, new Date(NOW.getTime() + 3 * 3600_000), a.deps);
    expect(a.calls).toHaveLength(1);
  });

  it("waits like the email: not before the plan is ready and built; never for an old read", async () => {
    m.transport.on = false;
    const a = admin();
    seed();
    m.readiness.mockResolvedValue({ ready: false });
    await maybeSendPlanReadyEmail(S, NOW, a.deps);
    seed({ computedAt: "2026-10-17T09:00:00.000Z" });
    m.readiness.mockResolvedValue({ ready: true });
    await maybeSendPlanReadyEmail(S, NOW, a.deps);
    seed({ finishedAt: "2026-10-01T00:00:00Z" });
    await maybeSendPlanReadyEmail(S, NOW, a.deps);
    expect(a.calls).toHaveLength(0);
    expect(flowRows()).toHaveLength(0);
  });

  it("with a provider the email goes out and Flow fires too (two log rows, one each)", async () => {
    seed();
    const a = admin();
    expect(await maybeSendPlanReadyEmail(S, NOW, a.deps)).toBe("sent");
    expect(a.calls).toHaveLength(1);
    expect(fake.tables.ownerEmailLog.map((r) => r.kind).sort()).toEqual([PLAN_READY_KIND, "plan_ready_flow"]);
  });

  it("Shopify refuses (extension not released): logged as failed, not retried; a network error gets one retry an hour later", async () => {
    m.transport.on = false;
    seed();
    const refused = admin({ data: { flowTriggerReceive: { userErrors: [{ field: ["handle"], message: "Invalid handle" }] } } });
    await maybeSendPlanReadyEmail(S, NOW, refused.deps);
    expect(flowRows()[0]).toMatchObject({ status: "FAILED" });
    await maybeSendPlanReadyEmail(S, new Date(NOW.getTime() + 2 * 3600_000), refused.deps);
    expect(refused.calls).toHaveLength(1);

    seed();
    const down = { getAdmin: async () => ({ graphql: async () => { throw new Error("ECONNRESET"); } }) };
    await maybeSendPlanReadyEmail(S, NOW, down);
    expect(flowRows()[0]).toMatchObject({ status: "FAILED" });
    const ok = admin();
    await maybeSendPlanReadyEmail(S, new Date(NOW.getTime() + 60_000), ok.deps); // too soon
    expect(ok.calls).toHaveLength(0);
    await maybeSendPlanReadyEmail(S, new Date(NOW.getTime() + 2 * 3600_000), ok.deps);
    expect(ok.calls).toHaveLength(1);
    expect(flowRows()[0]).toMatchObject({ status: "SENT", error: null });
  });
});

describe("notify-flow: sample data", () => {
  it("never fires or claims for sample data", async () => {
    const { fireNotifyFlowOnce, notifyFlowPending } = await import("../app/services/notify-flow.server");
    fake.reset();
    const getAdmin = vi.fn();
    expect(await notifyFlowPending(`${S}#sample`, "weekly-order-plan-ready", "2026-W43", NOW)).toBe(false);
    expect(await fireNotifyFlowOnce(`${S}#sample`, "weekly-order-plan-ready", "2026-W43", {}, NOW, { getAdmin })).toBe("skipped");
    expect(getAdmin).not.toHaveBeenCalled();
    expect(fake.tables.ownerEmailLog ?? []).toHaveLength(0);
  });
});
