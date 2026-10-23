/**
 * The Monday email (spec §11, task 1.8): due from 08:00 store time on the
 * store's Monday (DST and extreme offsets included), the composer (4 numbers,
 * week-on-week change, "—" for nulls, Free line, forward-looking money
 * subject, translated), once per store week with one retry, stale numbers
 * skipped, unsubscribe, and the public unsubscribe page.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { createRoutesStub } from "react-router";

type Row = Record<string, unknown>;
const { tables, sendEmail, planFor, fakeDb, deliverSlackOnce, loadOrderPlan, readiness } = vi.hoisted(() => {
  const tables: { shop: Row[]; moneyAtStake: Row[]; ownerEmailLog: Row[]; action: Row[]; variant: Row[]; accuracyMonth: Row[] } = {
    shop: [],
    moneyAtStake: [],
    ownerEmailLog: [],
    action: [],
    variant: [],
    accuracyMonth: [],
  };
  const dayIn = (d: unknown, c: { gte?: Date; lte?: Date }) =>
    d instanceof Date && (!c.gte || d >= c.gte) && (!c.lte || d <= c.lte);
  const byDay = (dir: "asc" | "desc") => (a: Row, b: Row) =>
    ((a.day as Date).getTime() - (b.day as Date).getTime()) * (dir === "asc" ? 1 : -1);
  const fakeDb = {
    shop: {
      findUnique: async ({ where }: { where: { domain: string } }) => tables.shop.find((r) => r.domain === where.domain) ?? null,
      findMany: async ({ where }: { where: { uninstalledAt: null } }) =>
        tables.shop.filter((r) => (where.uninstalledAt === null ? r.uninstalledAt == null : true)),
      update: async ({ where, data }: { where: { domain: string }; data: Row }) => {
        const r = tables.shop.find((x) => x.domain === where.domain);
        if (!r) throw new Error("not found");
        Object.assign(r, data);
        return r;
      },
    },
    moneyAtStake: {
      findFirst: async ({ where, orderBy }: { where: { shop: string }; orderBy: { day: "asc" | "desc" } }) =>
        tables.moneyAtStake.filter((r) => r.shop === where.shop).sort(byDay(orderBy.day))[0] ?? null,
      findMany: async ({ where, orderBy }: { where: { shop: string; day: { gte?: Date; lte?: Date } }; orderBy: { day: "asc" | "desc" } }) =>
        tables.moneyAtStake.filter((r) => r.shop === where.shop && dayIn(r.day, where.day)).sort(byDay(orderBy.day)),
    },
    action: {
      findMany: async ({ where }: { where: { shop: string; state: { in: string[] } } }) =>
        tables.action.filter((r) => r.shop === where.shop && where.state.in.includes(r.state as string)),
    },
    variant: {
      findMany: async ({ where }: { where: { shop: string; productId: { in: string[] } } }) =>
        tables.variant.filter((r) => r.shop === where.shop && where.productId.in.includes(r.productId as string)),
    },
    accuracyMonth: {
      findFirst: async ({ where }: { where: { shop: string } }) =>
        tables.accuracyMonth
          .filter((r) => r.shop === where.shop)
          .sort((a, b) => (b.month as Date).getTime() - (a.month as Date).getTime())[0] ?? null,
    },
    ownerEmailLog: {
      findUnique: async ({ where }: { where: { shop_kind_periodKey: { shop: string; kind: string; periodKey: string } } }) => {
        const k = where.shop_kind_periodKey;
        return tables.ownerEmailLog.find((r) => r.shop === k.shop && r.kind === k.kind && r.periodKey === k.periodKey) ?? null;
      },
      // Unique (shop, kind, periodKey), like the real table.
      create: async ({ data }: { data: Row }) => {
        if (tables.ownerEmailLog.some((r) => r.shop === data.shop && r.kind === data.kind && r.periodKey === data.periodKey))
          throw new Error("Unique constraint failed");
        const row = { status: "SENT", error: null, sentAt: new Date(), ...data };
        tables.ownerEmailLog.push(row);
        return row;
      },
      // Conditional claim: every where field must match (Dates by time).
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const eq = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
        const hits = tables.ownerEmailLog.filter((r) => Object.entries(where).every(([k, v]) => eq(r[k] ?? null, v ?? null)));
        for (const r of hits) Object.assign(r, data);
        return { count: hits.length };
      },
      update: async ({ where, data }: { where: { shop_kind_periodKey: Row }; data: Row }) => {
        const k = where.shop_kind_periodKey;
        const r = tables.ownerEmailLog.find((x) => x.shop === k.shop && x.kind === k.kind && x.periodKey === k.periodKey);
        if (r) Object.assign(r, data);
        return r;
      },
    },
  };
  const sendEmail = vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }) as { ok: true } | { ok: false; reason: string });
  const planFor = vi.fn(async (_shop: string) => "growth");
  const deliverSlackOnce = vi.fn(async (..._a: unknown[]) => "sent" as "sent" | "failed" | "skipped");
  const loadOrderPlan = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({
    today: "2026-10-19",
    currency: "EUR",
    timezone: "Europe/Madrid",
    events: [],
    variants: {},
    suppliers: {},
    suppliersSetUp: false,
    cantPlan: { noData: 0, dead: 0 },
  }));
  const readiness = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ready: true }));
  return { tables, sendEmail, planFor, fakeDb, deliverSlackOnce, loadOrderPlan, readiness };
});

vi.mock("../app/db.server", () => ({ default: fakeDb }));
vi.mock("../app/shopify.server", () => ({
  unauthenticated: {
    admin: vi.fn(async () => ({
      admin: {
        graphql: async () => ({
          json: async () => ({
            data: { shop: { name: "Acme Shoes", email: "owner@acme.test", contactEmail: null }, shopLocales: [{ locale: "en", primary: true }] },
          }),
        }),
      },
    })),
  },
}));
vi.mock("../app/services/entitlements.server", () => ({ planFor: (shop: string) => planFor(shop) }));
vi.mock("../app/models/order-plan.server", () => ({ loadOrderPlan: (...a: unknown[]) => loadOrderPlan(...a) }));
vi.mock("../app/models/dashboard.server", () => ({ readiness: (...a: unknown[]) => readiness(...a) }));
vi.mock("../app/services/slack.server", () => ({ deliverSlackOnce: (...a: unknown[]) => deliverSlackOnce(...a) }));
const flow = vi.hoisted(() => ({
  transport: { on: true },
  pending: { on: false },
  fire: vi.fn(async (..._a: unknown[]) => "fired" as "fired" | "failed" | "skipped"),
}));
vi.mock("../app/services/email.server", () => ({
  emailTransportConfigured: () => flow.transport.on,
  sendEmail: (input: Record<string, unknown>) => sendEmail(input),
}));
// Shopify Flow "Weekly order plan ready" (owner decision 2026-10-18); its once-per-week claim is tested in notify-flow.test.
vi.mock("../app/services/notify-flow.server", () => ({
  notifyFlowPending: async () => flow.pending.on,
  fireNotifyFlowOnce: (...a: unknown[]) => flow.fire(...a),
}));

beforeAll(() => {
  process.env.SHOPIFY_API_SECRET = "test-secret";
  process.env.SHOPIFY_APP_URL = "https://inventory.test";
});

import {
  actionReasonText,
  composeMondayEmail,
  formatMoneyWhole,
  isMondaySendTime,
  lastMonthAccuracy,
  MONDAY_UNSUB_PURPOSE,
  mondaySummary,
  selectMondayActions,
  type MondayOrders,
  type MondayActionRow,
  type MondayEmailInput,
} from "../app/lib/monday-shared";
import { mondayOrders, runMondayEmails, runMondayEmailsAllShops } from "../app/services/monday.server";
import { seal } from "../app/lib/seal.server";
import { buildSlackMonday } from "../app/lib/slack-shared";
import UnsubscribePage, { action as unsubAction, loader as unsubLoader } from "../app/routes/email.unsubscribe";

// ---------------------------------------------------------------- send time

const due = (iso: string, tz: string) => isMondaySendTime(new Date(iso), tz);

describe("isMondaySendTime", () => {
  it("Europe/Madrid, spring forward (Sun 29 Mar 2026): 08:00 CEST = 06:00Z", () => {
    expect(due("2026-03-23T06:59:00Z", "Europe/Madrid").due).toBe(false); // 07:59 CET
    expect(due("2026-03-23T07:00:00Z", "Europe/Madrid")).toEqual({ due: true, localDate: "2026-03-23" });
    expect(due("2026-03-30T05:59:00Z", "Europe/Madrid").due).toBe(false); // 07:59 CEST
    expect(due("2026-03-30T06:00:00Z", "Europe/Madrid")).toEqual({ due: true, localDate: "2026-03-30" });
  });
  it("Europe/Madrid, fall back (Sun 25 Oct 2026): 08:00 CET = 07:00Z", () => {
    expect(due("2026-10-19T06:00:00Z", "Europe/Madrid")).toEqual({ due: true, localDate: "2026-10-19" }); // CEST
    expect(due("2026-10-26T06:30:00Z", "Europe/Madrid").due).toBe(false); // 07:30 CET
    expect(due("2026-10-26T07:00:00Z", "Europe/Madrid")).toEqual({ due: true, localDate: "2026-10-26" });
  });
  it("America/Los_Angeles across the 1 Nov 2026 change, and late Monday evening", () => {
    expect(due("2026-10-26T14:59:00Z", "America/Los_Angeles").due).toBe(false);
    expect(due("2026-10-26T15:00:00Z", "America/Los_Angeles").due).toBe(true); // 08:00 PDT
    expect(due("2026-11-02T15:59:00Z", "America/Los_Angeles").due).toBe(false); // 07:59 PST
    expect(due("2026-11-02T16:00:00Z", "America/Los_Angeles")).toEqual({ due: true, localDate: "2026-11-02" });
    // Tuesday 06:00Z is still Monday 23:00 in Los Angeles.
    expect(due("2026-10-27T06:00:00Z", "America/Los_Angeles")).toEqual({ due: true, localDate: "2026-10-26" });
  });
  it("Pacific/Kiritimati (UTC+14): due on what is still Sunday in UTC", () => {
    expect(due("2026-10-18T17:59:00Z", "Pacific/Kiritimati").due).toBe(false);
    expect(due("2026-10-18T18:00:00Z", "Pacific/Kiritimati")).toEqual({ due: true, localDate: "2026-10-19" });
  });
  it("Pacific/Pago_Pago (UTC−11): not due on UTC Monday morning", () => {
    expect(due("2026-10-19T10:00:00Z", "Pacific/Pago_Pago")).toEqual({ due: false, localDate: "2026-10-18" });
    expect(due("2026-10-19T19:00:00Z", "Pacific/Pago_Pago")).toEqual({ due: true, localDate: "2026-10-19" });
  });
  it("is not due before 08:00 or on Tuesday; an unknown zone counts as UTC", () => {
    expect(due("2026-10-19T05:00:00Z", "Europe/Madrid").due).toBe(false);
    expect(due("2026-10-20T10:00:00Z", "Europe/Madrid").due).toBe(false);
    expect(due("2026-10-19T08:00:00Z", "Not/AZone")).toEqual({ due: true, localDate: "2026-10-19" });
    expect(due("2026-10-19T07:59:00Z", "")).toEqual({ due: false, localDate: "2026-10-19" });
  });
});

// ---------------------------------------------------------------- composer

const base: MondayEmailInput = {
  locale: "en",
  numberLocale: "en",
  currency: "EUR",
  storeName: "Acme Shoes",
  now: { atRisk: 1200, lost90: null, cashStuck: 3400.5, soldOutTraffic: 50 },
  before: { atRisk: 1000, lost90: 500, cashStuck: 3400.5, soldOutTraffic: null },
  refresh: "daily",
  links: { app: "https://admin.shopify.com/store/acme/apps/keha-inventory/app", unsubscribe: "https://inventory.test/email/unsubscribe?token=abc" },
};

describe("composeMondayEmail", () => {
  it("English: money subject, the 2 numbers of the Dashboard (clarity pass), change, links", () => {
    const e = composeMondayEmail(base);
    // Headline = Sales at risk + Cash stuck (1200 + 3400.5), not the past-period cards.
    expect(e.subject).toBe("€4,601 at stake this week");
    expect(e.text).toContain("Weekly stock summary for Acme Shoes");
    expect(e.text).toContain("Sales at risk, next 4 weeks: €1,200 (+€200 vs last week)");
    expect(e.text).toContain("Cash tied up in slow stock: €3,401 (Same as last week)");
    // The look-back figures are on the Actions page, not in the email (same 2 as the Dashboard).
    expect(e.text).not.toContain("Sales lost while sold out");
    expect(e.text).not.toContain("Sales missed on sold-out pages");
    expect(e.text).toContain(`Open in Keha: ${base.links.app}`);
    expect(e.text).toContain(`Unsubscribe: ${base.links.unsubscribe}`);
    expect(e.text).not.toContain("Refreshed weekly");
    expect(e.text).not.toMatch(/\b\d+ actions?\b/);
    expect(e.text).not.toMatch(/\b0 vs last week/);
    expect(e.html).toContain('<html lang="en">');
    expect(e.html).toContain(`href="${base.links.app}"`);
    expect(e.html).toContain(`href="${base.links.unsubscribe}"`);
    expect(e.html).toContain("+€200 vs last week");
    expect(composeMondayEmail({ ...base, now: { ...base.now, cashStuck: null } }).html).toContain(">—<"); // null → "—"
  });

  it("Spanish: translated labels, store-locale money, Free line", () => {
    const e = composeMondayEmail({ ...base, locale: "es", numberLocale: "es-ES", refresh: "weekly" });
    const eur = (n: number) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(n);
    expect(e.subject).toBe(`${eur(4601)} en juego esta semana`);
    expect(e.text).toContain("Resumen semanal de stock de Acme Shoes");
    expect(e.text).toContain(`Ventas en riesgo, próximas 4 semanas: ${eur(1200)} (`);
    expect(e.text).toContain("respecto a la semana pasada");
    expect(e.text).toContain("Dinero inmovilizado en stock lento");
    expect(e.text).toContain("Igual que la semana pasada");
    expect(e.text).toContain("Se actualiza cada semana en el plan Gratis");
    expect(e.text).toContain("Abrir en Keha:");
    expect(e.text).toContain("Darse de baja:");
    expect(e.html).toContain('<html lang="es">');
    expect(e.html).not.toContain("Sales at risk");
  });

  it("shows no change at all without a row from a week before", () => {
    const e = composeMondayEmail({ ...base, before: null });
    expect(e.text).not.toContain("last week");
    expect(e.html).not.toContain("last week");
  });

  it("formats the subject in the store currency, with '—' when nothing is known", () => {
    expect(composeMondayEmail({ ...base, currency: "USD", now: { atRisk: 12345.4, lost90: null, cashStuck: null, soldOutTraffic: null } }).subject).toBe(
      "$12,345 at stake this week",
    );
    expect(composeMondayEmail({ ...base, currency: "GBP" }).subject).toBe("£4,601 at stake this week");
    expect(composeMondayEmail({ ...base, now: { atRisk: null, lost90: null, cashStuck: null, soldOutTraffic: null } }).subject).toBe(
      "Your stock this week",
    );
    expect(formatMoneyWhole(12, "NOT_A_CURRENCY", "en")).toBe("12 NOT_A_CURRENCY");
  });

  it("headline counts only the forward-looking money; the past figures aren't in the email", () => {
    const e = composeMondayEmail({ ...base, now: { atRisk: null, lost90: 900, cashStuck: null, soldOutTraffic: 80 } });
    expect(e.subject).toBe("Your stock this week");
    expect(e.text).not.toContain("€900");
    expect(e.text).toMatch(/^Sales at risk, next 4 weeks: —/m); // null → "—"
    expect(e.html).toContain(">Your stock this week</h1>");
    expect(composeMondayEmail({ ...base, locale: "es", now: { atRisk: null, lost90: 900, cashStuck: null, soldOutTraffic: 80 } }).subject).toBe(
      "Tu stock esta semana",
    );
    expect(composeMondayEmail({ ...base, now: { atRisk: 100, lost90: 900, cashStuck: null, soldOutTraffic: 80 } }).subject).toBe(
      "€100 at stake this week",
    );
  });

  it("escapes the store name in HTML", () => {
    const e = composeMondayEmail({ ...base, storeName: `Tom & "Jerry" <b>` });
    expect(e.html).toContain("Tom &amp; &quot;Jerry&quot; &lt;b&gt;");
    expect(e.html).not.toContain("<b>");
  });

  it("later phases: actions add '— 5 actions' and the top 5; accuracy adds its line", () => {
    const actions = Array.from({ length: 7 }, (_, i) => ({ title: `Reorder item ${i + 1}`, reason: "Runs out in 9 days", amount: 100 * (i + 1), link: `https://x/${i + 1}` }));
    const e = composeMondayEmail({ ...base, actions, accuracyPct: 7.4 });
    expect(e.subject).toBe("€4,601 at stake this week — 5 actions");
    expect(e.text).toContain("This week's actions");
    expect(e.text).toContain("5. Reorder item 5 (€500)");
    expect(e.text).not.toContain("Reorder item 6");
    expect(e.text).toContain("Last month we were within 7% on your store total.");
    expect(e.html).toContain('href="https://x/5"');
    expect(composeMondayEmail({ ...base, actions: actions.slice(0, 1) }).subject).toBe("€4,601 at stake this week — 1 action");
    const pastOnly = { atRisk: null, lost90: 900, cashStuck: null, soldOutTraffic: 80 };
    expect(composeMondayEmail({ ...base, now: pastOnly, actions: actions.slice(0, 1) }).subject).toBe("Your stock this week — 1 action");
    expect(composeMondayEmail({ ...base, locale: "es", actions }).subject).toMatch(/— 5 acciones$/);
  });
});

// ---------------------------------------------------------------- sending

const S = "acme.myshopify.com";
const day = (d: string) => new Date(`${d}T00:00:00Z`);

function shopRow(over: Row = {}): Row {
  return { domain: S, currency: "EUR", timezone: "Europe/Madrid", locale: "es", uninstalledAt: null, settings: {}, ...over };
}
function money(d: string, atRisk: string | null, shop = S): Row {
  return { shop, day: day(d), atRisk, lost90: "300.00", cashStuck: null, soldOutTraffic: "40.00", basis: {} };
}

const MON = new Date("2026-10-19T07:00:00Z"); // Monday 09:00 in Madrid (W43)

beforeEach(() => {
  tables.shop = [];
  tables.moneyAtStake = [];
  tables.ownerEmailLog = [];
  tables.action = [];
  tables.variant = [];
  tables.accuracyMonth = [];
  deliverSlackOnce.mockClear();
  sendEmail.mockClear();
  planFor.mockReset();
  planFor.mockResolvedValue("growth");
  flow.transport.on = true;
  flow.pending.on = false;
  flow.fire.mockClear();
});

describe("runMondayEmails without an email provider: Shopify Flow 'Weekly order plan ready'", () => {
  it("no email goes out; the summary goes to Flow once per store week, also when the email switch is off", async () => {
    flow.transport.on = false;
    flow.pending.on = true;
    tables.shop = [shopRow({ locale: "en", settings: { mondayEmail: { enabled: false, recipients: [] } } })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00"), money("2026-10-11", "1000.00")];
    expect(await runMondayEmails(S, MON)).toBe("skipped:unsubscribed");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(flow.fire).toHaveBeenCalledTimes(1);
    const [shop, handle, period, payload] = flow.fire.mock.calls[0] as [string, string, string, Record<string, string>];
    expect([shop, handle, period]).toEqual([S, "weekly-order-plan-ready", "2026-W43"]);
    expect(Object.keys(payload).sort()).toEqual(["Cash due this week", "Order plan link", "Orders due this week", "Subject", "Summary text"]);
    expect(payload.Subject).toMatch(/at stake this week/);
    expect(payload["Summary text"]).toContain("Weekly stock summary for Acme Shoes");
    expect(payload["Summary text"]).toContain("Cash tied up in slow stock: —");
    // The Flow text has no email footer or unsubscribe link (the merchant's workflow controls it).
    expect(payload["Summary text"]).not.toContain("unsubscribe");
    expect(payload["Summary text"]).not.toContain("You get this email");
    expect(payload["Order plan link"]).toBe("https://admin.shopify.com/store/acme/apps/keha-inventory/app/reorder");
    // Nothing planned in the 13 weeks: the order plan didn't say → "—", never a made-up 0.
    expect(payload["Orders due this week"]).toBe("—");
    expect(payload["Cash due this week"]).toBe("—");
  });

  it("already fired this week: nothing to do (and no email)", async () => {
    flow.transport.on = false;
    tables.shop = [shopRow()];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    expect(await runMondayEmails(S, MON)).toBe("skipped:unsubscribed");
    expect(flow.fire).not.toHaveBeenCalled();
  });

  it("not before Monday 08:00 store time, never without numbers, never for an uninstalled store", async () => {
    flow.transport.on = false;
    flow.pending.on = true;
    tables.shop = [shopRow()];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    expect(await runMondayEmails(S, new Date("2026-10-19T05:00:00Z"))).toBe("skipped:unsubscribed");
    tables.moneyAtStake = [];
    expect(await runMondayEmails(S, MON)).toBe("skipped:no_data");
    tables.shop = [shopRow({ uninstalledAt: new Date("2026-10-01T00:00:00Z") })];
    expect(await runMondayEmails(S, MON)).toBe("skipped:not_installed");
    expect(flow.fire).not.toHaveBeenCalled();
  });

  it("Free gets it too, with its own link (the Dashboard)", async () => {
    flow.transport.on = false;
    flow.pending.on = true;
    planFor.mockResolvedValue("free");
    tables.shop = [shopRow({ locale: "en" })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    await runMondayEmails(S, MON);
    const payload = flow.fire.mock.calls[0]![3] as Record<string, string>;
    expect(payload["Order plan link"]).toBe("https://admin.shopify.com/store/acme/apps/keha-inventory/app");
  });

  it("with a provider the email still goes out, and Flow fires alongside it", async () => {
    flow.pending.on = true;
    tables.shop = [shopRow()];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    expect(await runMondayEmails(S, MON)).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(flow.fire).toHaveBeenCalledTimes(1);
  });
});

describe("runMondayEmails", () => {
  it("sends once per store week, in the store's language, with HTML and the unsubscribe link", async () => {
    tables.shop = [shopRow()];
    tables.moneyAtStake = [money("2026-10-18", "1500.00"), money("2026-10-17", "900.00"), money("2026-10-11", "1000.00")];

    expect(await runMondayEmails(S, MON)).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = sendEmail.mock.calls[0][0] as { to: string; subject: string; text: string; html: string };
    expect(sent.to).toBe("owner@acme.test");
    expect(sent.subject).toMatch(/en juego esta semana$/);
    expect(sent.text).toContain("Resumen semanal de stock de Acme Shoes");
    // vs the 11 Oct row (7 days back), not the 17 Oct one.
    const plus500 = new Intl.NumberFormat("es", { style: "currency", currency: "EUR", maximumFractionDigits: 0, minimumFractionDigits: 0, signDisplay: "exceptZero" }).format(500);
    expect(sent.text).toContain(`(${plus500} respecto a la semana pasada)`);
    expect(sent.text).toContain("Dinero inmovilizado en stock lento: —");
    expect(sent.text).toContain("https://admin.shopify.com/store/acme/apps/");
    expect(sent.text).toMatch(/https:\/\/inventory\.test\/email\/unsubscribe\?token=[\w-]+/);
    // Mail clients' own unsubscribe button (RFC 2369 / 8058), same link as the footer.
    const headers = (sendEmail.mock.calls[0][0] as { headers?: Record<string, string> }).headers;
    const link = /https:\/\/inventory\.test\/email\/unsubscribe\?token=[\w%-]+/.exec(sent.text)![0];
    expect(headers).toEqual({ "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(sent.html).toContain('<html lang="es">');
    expect(tables.ownerEmailLog).toEqual([expect.objectContaining({ shop: S, kind: "monday", periodKey: "2026-W43" })]);

    // Later the same Monday: nothing more goes out.
    expect(await runMondayEmails(S, new Date("2026-10-19T15:00:00Z"))).toBe("skipped:already_sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // The next Monday is a new store week (with that week's numbers).
    tables.moneyAtStake.push(money("2026-10-25", "1600.00"));
    expect(await runMondayEmails(S, new Date("2026-10-26T07:00:00Z"))).toBe("sent");
    expect(tables.ownerEmailLog.map((r) => r.periodKey)).toEqual(["2026-W43", "2026-W44"]);
  });

  it("two ticks racing in the same week send one email (OwnerEmailLog unique)", async () => {
    tables.shop = [shopRow()];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    const results = await Promise.all([runMondayEmails(S, MON), runMondayEmails(S, MON)]);
    expect(results.sort()).toEqual(["sent", "skipped"]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("uses the store-local week: Kiritimati's Monday while UTC is still Sunday", async () => {
    tables.shop = [shopRow({ timezone: "Pacific/Kiritimati" })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    expect(await runMondayEmails(S, new Date("2026-10-18T18:30:00Z"))).toBe("sent");
    expect(tables.ownerEmailLog[0].periodKey).toBe("2026-W43");
  });

  it("does not send when unsubscribed, without numbers, or before 08:00", async () => {
    tables.shop = [shopRow({ settings: { mondayEmail: { enabled: false, recipients: [] } } })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    expect(await runMondayEmails(S, MON)).toBe("skipped:unsubscribed");

    tables.shop = [shopRow()];
    tables.moneyAtStake = [];
    expect(await runMondayEmails(S, MON)).toBe("skipped:no_data");

    tables.moneyAtStake = [{ ...money("2026-10-18", null), lost90: null, soldOutTraffic: null }];
    expect(await runMondayEmails(S, MON)).toBe("skipped:no_data");

    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    expect(await runMondayEmails(S, new Date("2026-10-19T05:30:00Z"))).toBe("skipped:not_due");
    expect(await runMondayEmails("unknown.myshopify.com", MON)).toBe("skipped:not_installed");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(tables.ownerEmailLog).toEqual([]);
  });

  it("sends to the chosen recipients, and adds the Free line on Free", async () => {
    planFor.mockResolvedValue("free");
    tables.shop = [shopRow({ locale: "en", settings: { mondayEmail: { enabled: true, recipients: ["ops@acme.test", " buyer@acme.test "] } } })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    expect(await runMondayEmails(S, MON)).toBe("sent");
    const sent = sendEmail.mock.calls[0][0] as { to: string[]; text: string };
    expect(sent.to).toEqual(["ops@acme.test", "buyer@acme.test"]);
    expect(sent.text).toContain("Refreshed weekly on Free");
    expect(sent.text).not.toContain("vs last week"); // no row a week earlier
  });

  it("runs every installed store and skips uninstalled ones", async () => {
    const B = "beta.myshopify.com";
    tables.shop = [shopRow(), shopRow({ domain: B }), shopRow({ domain: "gone.myshopify.com", uninstalledAt: new Date() })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00"), money("2026-10-18", "10.00", B), money("2026-10-18", "10.00", "gone.myshopify.com")];
    expect(await runMondayEmailsAllShops(MON)).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(await runMondayEmailsAllShops(MON)).toEqual({ sent: 0, failed: 0, skipped: 2 });
  });
});

describe("stale numbers", () => {
  const computed = (hoursAgo: number, from = MON) => ({ computedAt: new Date(from.getTime() - hoursAgo * 3600000).toISOString() });

  it("paid plans: sends numbers up to 36 h old, skips (and logs) older ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    tables.shop = [shopRow()];
    tables.moneyAtStake = [{ ...money("2026-10-17", "1500.00"), basis: computed(37) }];
    expect(await runMondayEmails(S, MON)).toBe("skipped:stale_data");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/acme\.myshopify\.com: skipped .*37 h old, daily refresh/));
    expect(sendEmail).not.toHaveBeenCalled();
    expect(tables.ownerEmailLog).toEqual([]);

    tables.moneyAtStake = [{ ...money("2026-10-18", "1500.00"), basis: computed(35) }];
    expect(await runMondayEmails(S, MON)).toBe("sent");
    warn.mockRestore();
  });

  it("without basis.computedAt the row's day is used", async () => {
    tables.shop = [shopRow()];
    tables.moneyAtStake = [money("2026-10-17", "1500.00")]; // 55 h before MON
    expect(await runMondayEmails(S, MON)).toBe("skipped:stale_data");
  });

  it("Free (weekly refresh, audit 2026-10-17): up to 8 days, with the weekly line — never month-old numbers", async () => {
    planFor.mockResolvedValue("free");
    tables.shop = [shopRow({ locale: "en" })];
    // Monthly refresh used to send 34-day-old numbers as "this week".
    tables.moneyAtStake = [{ ...money("2026-09-15", "1500.00"), basis: computed(34 * 24) }];
    expect(await runMondayEmails(S, MON)).toBe("skipped:stale_data");
    tables.moneyAtStake = [{ ...money("2026-10-18", "1500.00"), basis: computed(7 * 24) }];
    expect(await runMondayEmails(S, MON)).toBe("sent");
    expect((sendEmail.mock.calls[0][0] as { text: string }).text).toContain("Refreshed weekly on Free");
  });
});

describe("one retry within the week", () => {
  const fail = () => sendEmail.mockResolvedValueOnce({ ok: false, reason: "provider_500: down" });
  const at = (iso: string) => new Date(iso);
  const log = () => tables.ownerEmailLog[0];
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tables.shop = [shopRow()];
    tables.moneyAtStake = [money("2026-10-19", "1500.00")]; // fresh all Monday
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errSpy.mockRestore());

  it("retries a failed send once, after an hour, and then never again", async () => {
    fail();
    expect(await runMondayEmails(S, at("2026-10-19T07:00:00Z"))).toBe("failed");
    expect(log()).toMatchObject({ status: "FAILED", error: "attempt 1: provider_500: down" });
    expect(await runMondayEmails(S, at("2026-10-19T07:30:00Z"))).toBe("skipped:already_sent"); // < 1 h
    expect(sendEmail).toHaveBeenCalledTimes(1);

    expect(await runMondayEmails(S, at("2026-10-19T08:00:00Z"))).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(tables.ownerEmailLog).toHaveLength(1);
    expect(log()).toMatchObject({ status: "SENT", error: null, periodKey: "2026-W43" });

    expect(await runMondayEmails(S, at("2026-10-19T12:00:00Z"))).toBe("skipped:already_sent");
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("a second failure is final for the week", async () => {
    fail();
    fail();
    expect(await runMondayEmails(S, at("2026-10-19T07:00:00Z"))).toBe("failed");
    expect(await runMondayEmails(S, at("2026-10-19T08:30:00Z"))).toBe("failed");
    expect(log()).toMatchObject({ status: "FAILED", error: "attempt 2: provider_500: down" });
    expect(await runMondayEmails(S, at("2026-10-19T12:00:00Z"))).toBe("skipped:already_sent");
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("two ticks racing for the retry send it once", async () => {
    fail();
    expect(await runMondayEmails(S, at("2026-10-19T07:00:00Z"))).toBe("failed");
    const later = at("2026-10-19T08:15:00Z");
    const results = await Promise.all([runMondayEmails(S, later), runMondayEmails(S, later)]);
    expect(results.sort()).toEqual(["sent", "skipped"]);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(log()).toMatchObject({ status: "SENT" });
  });
});

// ---------------------------------------------------------------- full email (task 2.6)

const P = (n: number) => `gid://shopify/Product/${n}`;
function act(n: number, over: Partial<MondayActionRow> = {}): MondayActionRow {
  return { kind: "reorder", productId: P(n), amount: n * 100, state: "open", stateAmount: null, snoozeUntil: null, reason: null, ...over };
}

describe("selectMondayActions", () => {
  const now = new Date("2026-10-19T07:00:00Z");

  it("visible rows only, ranked by €, top 5", () => {
    const rows = [
      act(1),
      act(2, { state: "dismissed", stateAmount: 200 }), // dismissed, not doubled → hidden
      act(3, { state: "dismissed", stateAmount: 100 }), // doubled since → back
      act(4, { state: "snoozed", snoozeUntil: new Date("2026-10-20T00:00:00Z"), stateAmount: 400 }), // still snoozed
      act(5, { state: "snoozed", snoozeUntil: new Date("2026-10-18T00:00:00Z"), stateAmount: 500 }), // snooze over
      act(6, { kind: "clear" }),
      act(7, { kind: "push" }),
      act(8, { kind: "bridge" }),
      act(9, { state: "done" }),
    ];
    const r = selectMondayActions(rows, "growth", now);
    expect(r.listed.map((x) => x.productId)).toEqual([P(8), P(7), P(6), P(5), P(3)]);
    expect(r.lockedFixes).toBe(0);
  });

  it("Growth lists Fix rows; Free only counts them, and only within its top 10", () => {
    const rows = [act(9, { kind: "fix_sizes" }), act(8), act(7, { kind: "fix_page" }), act(6), act(5), act(4), act(3)];
    expect(selectMondayActions(rows, "growth", new Date()).listed.map((x) => x.kind)).toEqual(["fix_sizes", "reorder", "fix_page", "reorder", "reorder"]);
    const free = selectMondayActions(rows, "free", new Date());
    expect(free.listed.map((x) => x.productId)).toEqual([P(8), P(6), P(5)]);
    expect(free.lockedFixes).toBe(2);
    // Free never sees past its top 10: a Fix row ranked 11th isn't counted either.
    const many = Array.from({ length: 10 }, (_, i) => act(100 + i)).concat(act(1, { kind: "fix_returns" }));
    expect(selectMondayActions(many, "free", new Date())).toMatchObject({ lockedFixes: 0 });
    expect(selectMondayActions(many, "free", new Date()).listed).toHaveLength(5);
  });
});

describe("action reasons and accuracy", () => {
  it("translates the reason template and fills its params; an unknown key shows as is", () => {
    expect(actionReasonText("es", { key: "reorder.low", params: { days: 9 } })).toBe("reorder.low");
    expect(actionReasonText("en", { key: "Runs out in {days} days", params: { days: 9 } })).toBe("Runs out in 9 days");
    expect(actionReasonText("en", null)).toBe("");
    expect(actionReasonText("en", { params: {} })).toBe("");
  });

  it("uses last month's store total only", () => {
    const row = (month: string, pct: number | null) => ({ month: new Date(`${month}-01T00:00:00Z`), storeErrorPct: pct });
    expect(lastMonthAccuracy(row("2026-09", 7.4), "2026-10-19")).toBe(7.4);
    expect(lastMonthAccuracy(row("2026-08", 7.4), "2026-10-19")).toBeNull(); // stale: not "last month"
    expect(lastMonthAccuracy(row("2026-09", null), "2026-10-19")).toBeNull();
    expect(lastMonthAccuracy(row("2025-12", 3), "2026-01-05")).toBe(3);
    expect(lastMonthAccuracy(null, "2026-10-19")).toBeNull();
  });
});

describe("composeMondayEmail — full", () => {
  const actions = Array.from({ length: 3 }, (_, i) => ({ title: `Tee ${i + 1}`, reason: "Runs out in 9 days", amount: 300 - i * 100, link: `https://x/${i}` }));

  it("Free: Fix rows become one count line with a plans button; they count as things to do", () => {
    const e = composeMondayEmail({ ...base, actions, lockedFixes: { count: 2, link: "https://x/plans" } });
    expect(e.subject).toBe("€4,601 at stake this week — 5 actions");
    expect(e.text).toContain("4. Product issues: 2. See which ones on the Growth plan.");
    expect(e.text).toContain("See plans: https://x/plans");
    expect(e.html).toContain('href="https://x/plans"');
    expect(composeMondayEmail({ ...base, lockedFixes: { count: 1, link: "https://x/plans" } }).subject).toBe("€4,601 at stake this week — 1 action");
  });

  it("no accuracy line without a number; translated with one", () => {
    expect(composeMondayEmail({ ...base, accuracyPct: null }).text).not.toContain("Last month");
    expect(composeMondayEmail({ ...base, accuracyPct: 12.6, locale: "es" }).text).toContain(
      "El mes pasado acertamos con un margen del 13% en el total de tu tienda.",
    );
    const de = composeMondayEmail({ ...base, locale: "de", actions, lockedFixes: { count: 1, link: "https://x/plans" } });
    expect(de.subject).toMatch(/— 4 Aufgaben$/);
    expect(de.text).toContain("Produktprobleme: 1.");
  });
});

describe("runMondayEmails — full email", () => {
  function seedActions() {
    tables.variant = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ shop: S, productId: P(n), productTitle: `Product ${n}` }));
    tables.action = [
      { shop: S, kind: "reorder", productId: P(1), amount: "900.00", state: "open", stateAmount: null, snoozeUntil: null, reason: { key: "Runs out in {days} days", params: { days: 9 } } },
      { shop: S, kind: "fix_sizes", productId: P(2), amount: "800.00", state: "open", stateAmount: null, snoozeUntil: null, reason: { key: "fix.sizes", params: {} } },
      { shop: S, kind: "clear", productId: P(3), amount: "700.00", state: "open", stateAmount: null, snoozeUntil: null, reason: {} },
      { shop: S, kind: "bridge", productId: P(4), amount: "600.00", state: "open", stateAmount: null, snoozeUntil: null, reason: {} },
      { shop: S, kind: "push", productId: P(5), amount: "500.00", state: "open", stateAmount: null, snoozeUntil: null, reason: {} },
      { shop: S, kind: "reorder", productId: P(6), amount: "400.00", state: "open", stateAmount: null, snoozeUntil: null, reason: {} },
      { shop: S, kind: "reorder", productId: P(7), amount: "9999.00", state: "dismissed", stateAmount: "9000.00", snoozeUntil: null, reason: {} },
      { shop: "other.myshopify.com", kind: "reorder", productId: P(8), amount: "99999.00", state: "open", stateAmount: null, snoozeUntil: null, reason: {} },
    ];
    tables.accuracyMonth = [
      { shop: S, month: day("2026-08-01"), storeErrorPct: 20 },
      { shop: S, month: day("2026-09-01"), storeErrorPct: 8.2 },
    ];
  }

  it("Growth: top 5 actions with buttons into the app, and the accuracy line", async () => {
    tables.shop = [shopRow({ locale: "en" })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    seedActions();
    expect(await runMondayEmails(S, MON)).toBe("sent");
    const sent = sendEmail.mock.calls[0][0] as { subject: string; text: string; html: string };
    expect(sent.subject).toMatch(/at stake this week — 5 actions$/);
    expect(sent.text).toContain("1. Product 1 (€900)");
    expect(sent.text).toContain("   Runs out in 9 days");
    expect(sent.text).toContain("2. Product 2 (€800)");
    expect(sent.text).toContain("   fix.sizes"); // ACTION_REASONS not filled on this branch: raw key
    expect(sent.text).toContain("5. Product 5 (€500)");
    expect(sent.text).not.toContain("Product 6");
    expect(sent.text).not.toContain("Product 7");
    expect(sent.text).toContain("Open: https://admin.shopify.com/store/acme/apps/keha-inventory/app?tab=reorder");
    expect(sent.html).toContain('href="https://admin.shopify.com/store/acme/apps/keha-inventory/app?tab=fix"');
    expect(sent.html).toContain('href="https://admin.shopify.com/store/acme/apps/keha-inventory/app?tab=clear"');
    expect(sent.text).toContain("Last month we were within 8% on your store total.");
    expect(deliverSlackOnce).not.toHaveBeenCalled(); // Slack not connected
  });

  it("Free: Fix rows only as a count, no accuracy line", async () => {
    planFor.mockResolvedValue("free");
    tables.shop = [shopRow({ locale: "en" })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    seedActions();
    expect(await runMondayEmails(S, MON)).toBe("sent");
    const sent = sendEmail.mock.calls[0][0] as { subject: string; text: string };
    expect(sent.subject).toMatch(/— 5 actions$/);
    expect(sent.text).not.toContain("Product 2");
    expect(sent.text).not.toContain("fix.sizes");
    expect(sent.text).toContain("5. Product issues: 1. See which ones on the Growth plan.");
    expect(sent.text).toContain("See plans: https://admin.shopify.com/store/acme/apps/keha-inventory/app/plans");
    expect(sent.text).not.toContain("Last month we were within");
  });

  it("no actions yet: the Phase 1 email (no list, no count in the subject)", async () => {
    tables.shop = [shopRow({ locale: "en" })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    expect(await runMondayEmails(S, MON)).toBe("sent");
    const sent = sendEmail.mock.calls[0][0] as { subject: string; text: string };
    expect(sent.subject).toMatch(/at stake this week$/);
    expect(sent.text).not.toContain("This week's actions");
  });

  const slackSettings = (over: Row = {}) => ({
    mondayEmail: { enabled: false, recipients: [] },
    alerts: { slackWebhook: "gcm:sealed", slackMonday: true, instant: true },
    ...over,
  });

  it("Slack (Growth): the same summary once per store week, even with the email off", async () => {
    tables.shop = [shopRow({ locale: "en", settings: slackSettings() })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    seedActions();
    expect(await runMondayEmails(S, MON)).toBe("skipped:unsubscribed");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(deliverSlackOnce).toHaveBeenCalledTimes(1);
    const [shop, key, , message] = deliverSlackOnce.mock.calls[0] as [string, { kind: string; periodKey: string }, unknown, { text: string }];
    expect(shop).toBe(S);
    expect(key).toEqual({ kind: "monday_slack", periodKey: "2026-W43" });
    expect(message.text).toMatch(/^\*€\d.* at stake this week\*/);
    expect(message.text).toContain("<https://admin.shopify.com/store/acme/apps/keha-inventory/app?tab=reorder|Product 1> · €900");
    expect(message.text).toContain("Last month we were within 8% on your store total.");
    expect(message.text).not.toContain("Unsubscribe");

    // Already sent this week (log row): nothing more.
    tables.ownerEmailLog.push({ shop: S, kind: "monday_slack", periodKey: "2026-W43", status: "SENT", error: null, sentAt: MON });
    expect(await runMondayEmails(S, new Date("2026-10-19T09:00:00Z"))).toBe("skipped:unsubscribed");
    expect(deliverSlackOnce).toHaveBeenCalledTimes(1);
  });

  it("Slack and email both on: both go out; Slack's failure never stops the email", async () => {
    tables.shop = [shopRow({ locale: "en", settings: slackSettings({ mondayEmail: { enabled: true, recipients: [] } }) })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    deliverSlackOnce.mockRejectedValueOnce(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runMondayEmails(S, MON)).toBe("sent");
    expect(deliverSlackOnce).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("Slack: not on Free, not when the Slack summary is off, not when stale", async () => {
    planFor.mockResolvedValue("free");
    tables.shop = [shopRow({ settings: slackSettings() })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    expect(await runMondayEmails(S, MON)).toBe("skipped:unsubscribed");
    planFor.mockResolvedValue("growth");
    tables.shop = [shopRow({ settings: slackSettings({ alerts: { slackWebhook: "gcm:sealed", slackMonday: false } }) })];
    expect(await runMondayEmails(S, MON)).toBe("skipped:unsubscribed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    tables.shop = [shopRow({ settings: slackSettings() })];
    tables.moneyAtStake = [money("2026-10-16", "1500.00")];
    expect(await runMondayEmails(S, MON)).toBe("skipped:stale_data");
    warn.mockRestore();
    expect(deliverSlackOnce).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- Order this week (audit 2026-10-17)

describe("Monday email: Order this week first, subject leads with the job", () => {
  const plan = (over: Partial<Extract<MondayOrders, { kind: "plan" }>> = {}): MondayOrders => ({
    kind: "plan",
    today: "2026-10-19",
    lines: [
      { name: "Acme Textiles", units: 120, cash: 1830.4, orderBy: "2026-10-21", overdue: false, link: "https://x/app/reorder?supplier=s%3A1" },
      { name: "Lisbon Linen", units: 40, cash: null, orderBy: "2026-10-23", overdue: false, link: "https://x/app/reorder?supplier=s%3A2" },
    ],
    next: null,
    ...over,
  });
  const actions = [{ title: "Reorder item", reason: "", amount: 100, link: "https://x/1" }];

  it("orders due: '{n} orders due this week · first by {day}', money in the preheader, the block before the money", () => {
    const e = composeMondayEmail({ ...base, orders: plan(), actions });
    expect(e.subject).toBe("2 orders due this week · first by Wed, Oct 21");
    expect(e.html).toContain(">€4,601 at stake · 1 action</div>");
    expect(e.html.indexOf("Due this week")).toBeLessThan(e.html.indexOf("Sales at risk"));
    expect(e.text.indexOf("Due this week")).toBeLessThan(e.text.indexOf("€4,601 at stake this week"));
    expect(e.text).toContain("- Acme Textiles · 120 units · €1,830 · Due Wed, Oct 21");
    expect(e.text).toContain("  Review order: https://x/app/reorder?supplier=s%3A1");
    // Unknown cost: left out, never "€0".
    expect(e.text).toContain("- Lisbon Linen · 40 units · Due Fri, Oct 23");
    expect(e.html).toContain('href="https://x/app/reorder?supplier=s%3A2"');
    // Still there: unsubscribe and the money rows.
    expect(e.text).toContain(`Unsubscribe: ${base.links.unsubscribe}`);
    expect(e.text).toContain("Sales at risk, next 4 weeks: €1,200");
    const one = plan() as Extract<MondayOrders, { kind: "plan" }>;
    expect(composeMondayEmail({ ...base, orders: plan({ lines: [one.lines[0]!] }) }).subject).toBe(
      "1 order due this week · by Wed, Oct 21",
    );
  });

  it("an order that can't wait leads: '{supplier}: order now · {units} units', flagged in the block", () => {
    const p = plan();
    if (p.kind !== "plan") throw new Error();
    const lines = [p.lines[0]!, { ...p.lines[1]!, overdue: true, orderBy: "2026-10-19" }];
    const e = composeMondayEmail({ ...base, orders: { ...p, lines } });
    expect(e.subject).toBe("Lisbon Linen: order now · 40 units");
    expect(e.text).toContain("- Order now: Lisbon Linen · 40 units · Due today");
    expect(e.html).toContain(">Order now</span>");
    // Overdue only below its buffer (late: false): "Order soon", amber, and the subject stays the orders due.
    const soon = composeMondayEmail({ ...base, orders: { ...p, lines: [p.lines[0]!, { ...lines[1]!, late: false }] } });
    expect(soon.text).toContain("- Order soon: Lisbon Linen · 40 units · Due today");
    expect(soon.subject).not.toContain("order now");
  });

  it("a line due today reads 'order today' and is not flagged overdue (one label rule)", () => {
    const p = plan();
    if (p.kind !== "plan") throw new Error();
    const e = composeMondayEmail({ ...base, orders: { ...p, lines: [{ ...p.lines[0]!, orderBy: p.today }] } });
    expect(e.text).toContain("- Acme Textiles · 120 units · €1,830 · Due today");
    expect(e.text).not.toContain("Overdue");
  });

  it("nothing due: 'Nothing to order this week · next: {supplier} by {date}'", () => {
    const e = composeMondayEmail({ ...base, orders: plan({ lines: [], next: { name: "Acme Textiles", orderBy: "2026-11-04" } }) });
    expect(e.subject).toBe("Nothing to order this week · next: Acme Textiles by Nov 4");
    expect(e.text).toContain("Nothing to order this week. Next order: Acme Textiles by Nov 4.");
    expect(e.html).not.toContain("Review order");
    expect(e.html).toContain(">€4,601 at stake</div>");
  });

  it("nothing due but products can't be planned: the caveat goes with 'Nothing to order this week'", () => {
    const e = composeMondayEmail({ ...base, orders: plan({ lines: [], next: null, cantPlan: { noData: 2, dead: 1 } }) });
    expect(e.text).toContain(
      "Nothing to order this week. 2 products can't be planned yet — not enough sales history. 1 product isn't selling (dead stock), so it isn't reordered.",
    );
  });

  it("store not ready (2026-10-17 click-through): the block says why and when; the subject is the money one, never 'Nothing to order'", () => {
    const orders: MondayOrders = { kind: "notReady", today: "2026-10-19", readiness: { ready: false, state: "noSales", readyOn: "2026-10-31" } };
    const e = composeMondayEmail({ ...base, orders, actions });
    expect(e.subject).toBe("€4,601 at stake this week — 1 action");
    expect(e.text).toContain("Due this week");
    expect(e.text).toContain("Your order plan isn't ready yet. Your first order plan needs 14 days of sales — expected on Oct 31.");
    expect(e.text).not.toContain("Nothing to order");
    expect(e.html).not.toContain("Nothing to order");
    const syncing = composeMondayEmail({ ...base, orders: { ...orders, readiness: { ready: false, state: "syncing", percent: 43 } } });
    expect(syncing.text).toContain("Still reading your store: 43%.");
    // Slack gets the same block.
    expect(JSON.stringify(buildSlackMonday(mondaySummary({ ...base, orders })))).toContain("Your first order plan needs 14 days of sales");
  });

  it("mondayOrders: a store that isn't ready gets the not-ready block, whatever the plan holds", async () => {
    readiness.mockResolvedValueOnce({ ready: false, state: "noSales", readyOn: "2026-10-31" });
    expect(await mondayOrders(S, "growth", "en", MON)).toEqual({ kind: "notReady", today: "2026-10-19", readiness: { ready: false, state: "noSales", readyOn: "2026-10-31" } });
    // Ready with nothing planned: no block (the money email as before).
    expect(await mondayOrders(S, "growth", "en", MON)).toBeNull();
  });

  it("Free: '{n} products to order by {date}', the top-10 preview read-only, a way to the plans", () => {
    const orders: MondayOrders = {
      kind: "preview",
      today: "2026-10-19",
      rows: [
        { title: "Linen shirt", variant: "M / White", qty: 24, orderBy: "2026-10-19", overdue: true },
        { title: "Linen shirt", variant: "L / White", qty: 12, orderBy: "2026-10-26", overdue: false },
        { title: "Cap", variant: "", qty: 6, orderBy: "2026-11-02", overdue: false },
      ],
      products: 2,
      link: "https://x/app",
      plansLink: "https://x/app/plans",
    };
    const e = composeMondayEmail({ ...base, refresh: "weekly", orders });
    expect(e.subject).toBe("2 products to order by Nov 2");
    expect(e.text).toContain("Your most urgent products");
    expect(e.text).toContain("- Order now: Linen shirt · M / White · 24 units · Due today");
    expect(e.text).toContain("- Cap · 6 units · Due Nov 2");
    expect(e.text).not.toContain("Review order"); // read-only
    expect(e.text).toContain("See plans: https://x/app/plans");
    expect(e.text).toContain("Refreshed weekly on Free");
    const allLate = { ...orders, rows: [orders.rows[0]!], products: 1 };
    expect(composeMondayEmail({ ...base, orders: allLate }).subject).toBe("1 product to order now");
  });

  it("translated (es), and without order data the money subject stays", () => {
    const e = composeMondayEmail({ ...base, locale: "es", numberLocale: "es-ES", orders: plan() });
    expect(e.subject).toMatch(/^2 pedidos para esta semana · el primero antes del /);
    expect(e.text).toContain("Para pedir esta semana");
    expect(composeMondayEmail({ ...base, orders: null }).subject).toBe("€4,601 at stake this week");
  });

  it("Slack leads with the same job line and lists the orders with a Review order link", () => {
    const msg = buildSlackMonday(mondaySummary({ ...base, orders: plan() }));
    expect(msg.text).toMatch(/^\*2 orders due this week · first by Wed, Oct 21\*/);
    expect(msg.text).toContain("• Acme Textiles · 120 units · €1,830 · Due Wed, Oct 21 <https://x/app/reorder?supplier=s%3A1|Review order>");
    expect(msg.text).toContain("*€4,601 at stake this week*");
    expect(buildSlackMonday(mondaySummary(base)).text).toMatch(/^\*€4,601 at stake this week\*/);
  });
});

describe("runMondayEmails: Order this week from the order plan", () => {
  const event = (supplierKey: string, orderBy: string, qty: number, cost: number | null, overdue = false, variantId = "gid://shopify/ProductVariant/1") => ({
    variantId,
    productId: "gid://shopify/Product/1",
    supplierKey,
    orderBy,
    arrives: "2026-11-20",
    qty,
    unitCost: cost === null ? null : cost / qty,
    cost,
    overdue,
    deadline: overdue ? "2026-10-15" : orderBy,
  });
  const planData = (events: ReturnType<typeof event>[]) => ({
    today: "2026-10-19",
    currency: "EUR",
    timezone: "Europe/Madrid",
    events,
    variants: {
      "gid://shopify/ProductVariant/1": { variantId: "gid://shopify/ProductVariant/1", productId: "gid://shopify/Product/1", productTitle: "Linen shirt", variantTitle: "M", sku: null, image: null, daysLeft: 3, neverRunsOut: false, deadline: "2026-10-15", valuePerDay: 50 },
    },
    suppliers: { "s:1": { key: "s:1", kind: "supplier", supplierId: "1", name: "Acme Textiles" } },
    suppliersSetUp: true,
    cantPlan: { noData: 0, dead: 0 },
  });

  afterEach(() => loadOrderPlan.mockReset());

  it("Flow 'Weekly order plan ready': orders due this week and their cash, from the same order plan", async () => {
    flow.transport.on = false;
    flow.pending.on = true;
    loadOrderPlan.mockResolvedValue(planData([event("s:1", "2026-10-19", 30, 450, true), event("s:1", "2026-12-01", 30, 450)]));
    tables.shop = [shopRow({ locale: "en" })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    await runMondayEmails(S, MON);
    const payload = flow.fire.mock.calls[0]![3] as Record<string, string>;
    expect(payload.Subject).toBe("Acme Textiles: order now · 30 units");
    expect(payload["Orders due this week"]).toBe("1");
    expect(payload["Cash due this week"]).toBe("€450");
    expect(payload["Summary text"]).toContain("- Order now: Acme Textiles · 30 units · €450 · Due today");
  });

  it("Growth: one line per supplier with Review order into Order now for that supplier", async () => {
    loadOrderPlan.mockResolvedValue(planData([event("s:1", "2026-10-19", 30, 450, true), event("s:1", "2026-12-01", 30, 450)]));
    tables.shop = [shopRow({ locale: "en" })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    expect(await runMondayEmails(S, MON)).toBe("sent");
    const sent = sendEmail.mock.calls[0][0] as { subject: string; text: string; headers?: Record<string, string> };
    expect(sent.subject).toBe("Acme Textiles: order now · 30 units");
    expect(sent.text).toContain("- Order now: Acme Textiles · 30 units · €450 · Due today");
    expect(sent.text).toContain("Review order: https://admin.shopify.com/store/acme/apps/keha-inventory/app/reorder?supplier=s%3A1");
    expect(JSON.stringify(sent)).toContain("List-Unsubscribe");
  });

  it("Free: the top-10 preview, read-only", async () => {
    planFor.mockResolvedValue("free");
    loadOrderPlan.mockResolvedValue(planData([event("s:1", "2026-10-28", 30, 450)]));
    tables.shop = [shopRow({ locale: "en" })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    expect(await runMondayEmails(S, MON)).toBe("sent");
    const sent = sendEmail.mock.calls[0][0] as { subject: string; text: string };
    expect(sent.subject).toBe("1 product to order by Oct 28");
    expect(sent.text).toContain("- Linen shirt · M · 30 units · Due Oct 28");
    expect(sent.text).not.toContain("Review order");
  });

  it("a plan that can't be read never stops the email (money subject)", async () => {
    loadOrderPlan.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    tables.shop = [shopRow({ locale: "en" })];
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    expect(await runMondayEmails(S, MON)).toBe("sent");
    expect((sendEmail.mock.calls[0][0] as { subject: string }).subject).toMatch(/at stake this week$/);
    err.mockRestore();
  });
});

// ---------------------------------------------------------------- unsubscribe page

const ttl = 180 * 24 * 60 * 60 * 1000;
const token = (shop = S) => seal(MONDAY_UNSUB_PURPOSE, { shop }, ttl);
const args = (request: Request) => ({ request, params: {}, context: {} }) as never;
const url = (t: string) => `https://inventory.test/email/unsubscribe?token=${encodeURIComponent(t)}`;

function renderPage(loaderData: unknown, actionData?: unknown) {
  const Stub = createRoutesStub([{ id: "unsub", path: "/email/unsubscribe", Component: UnsubscribePage, loader: () => loaderData }]);
  return renderToString(
    createElement(Stub, {
      initialEntries: ["/email/unsubscribe"],
      hydrationData: { loaderData: { unsub: loaderData }, ...(actionData ? { actionData: { unsub: actionData } } : {}) },
    }),
  );
}

describe("email unsubscribe route", () => {
  beforeEach(() => {
    tables.shop = [shopRow({ settings: { leadTimeDays: 30, mondayEmail: { enabled: true, recipients: ["ops@acme.test"] } } })];
  });

  it("GET shows the confirm page in the store's language and changes nothing", async () => {
    const t = token();
    const data = await unsubLoader(args(new Request(url(t))));
    expect(data).toEqual({ state: "confirm", locale: "es", shop: S, token: t, kind: "monday" });
    expect((tables.shop[0].settings as Row).mondayEmail).toEqual({ enabled: true, recipients: ["ops@acme.test"] });
    const html = renderPage(data);
    expect(html).toContain("¿Dejar de recibir el email del resumen semanal?");
    expect(html).toContain("Darse de baja");
    expect(html).toContain('method="post"');
    expect(html).toContain(`value="${t}"`);
  });

  it("POST turns the Monday email off and keeps every other setting", async () => {
    const form = new FormData();
    form.set("token", token());
    const data = await unsubAction(args(new Request("https://inventory.test/email/unsubscribe", { method: "POST", body: form })));
    expect(data).toEqual({ state: "done", locale: "es", shop: S, kind: "monday" });
    expect(tables.shop[0].settings).toEqual({ leadTimeDays: 30, mondayEmail: { enabled: false, recipients: ["ops@acme.test"] } });
    expect(renderPage({ state: "invalid", locale: "es" }, data)).toContain("Te has dado de baja");

    // …and then no Monday email goes out.
    tables.moneyAtStake = [money("2026-10-18", "1500.00")];
    expect(await runMondayEmails(S, MON)).toBe("skipped:unsubscribed");
  });

  it("POST also accepts the token in the URL (mail-client one-click)", async () => {
    const req = new Request(url(token()), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(await unsubAction(args(req))).toMatchObject({ state: "done" });
    expect((tables.shop[0].settings as Row).mondayEmail).toMatchObject({ enabled: false });
  });

  it("an alerts link stops instant alerts only (GET confirms, POST and one-click POST turn them off)", async () => {
    tables.shop = [shopRow({ settings: { mondayEmail: { enabled: true, recipients: [] }, alerts: { instant: true, slackMonday: true } } })];
    const t = seal(MONDAY_UNSUB_PURPOSE, { shop: S, kind: "alerts" }, ttl);
    const data = await unsubLoader(args(new Request(url(t))));
    expect(data).toEqual({ state: "confirm", locale: "es", shop: S, token: t, kind: "alerts" });
    const html = renderPage(data);
    expect(html).toContain("¿Dejar de recibir las alertas inmediatas de stock?");
    expect(html).not.toContain("lunes");
    expect((tables.shop[0].settings as Row).alerts).toMatchObject({ instant: true });

    const req = new Request(url(t), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    const done = await unsubAction(args(req));
    expect(done).toEqual({ state: "done", locale: "es", shop: S, kind: "alerts" });
    expect(tables.shop[0].settings).toEqual({ mondayEmail: { enabled: true, recipients: [] }, alerts: { instant: false, slackMonday: true } });
    expect(renderPage({ state: "invalid", locale: "es" }, done)).toContain("ya no recibirá alertas inmediatas de stock");
  });

  it("a bad, expired or other-purpose token gets a friendly page and changes nothing", async () => {
    const fr = { headers: { "Accept-Language": "fr-FR,fr;q=0.9" } };
    const bad = await unsubLoader(args(new Request(url("garbage"), fr)));
    expect(bad).toEqual({ state: "invalid", locale: "fr" });
    expect(renderPage(bad)).toContain("plus valide");

    const expired = seal(MONDAY_UNSUB_PURPOSE, { shop: S }, 1000, Date.now() - 10_000);
    expect(await unsubLoader(args(new Request(url(expired))))).toMatchObject({ state: "invalid" });
    const other = seal("supplier-confirm", { shop: S }, ttl);
    const form = new FormData();
    form.set("token", other);
    expect(await unsubAction(args(new Request("https://inventory.test/email/unsubscribe", { method: "POST", body: form })))).toMatchObject({
      state: "invalid",
    });
    expect(await unsubLoader(args(new Request("https://inventory.test/email/unsubscribe")))).toMatchObject({ state: "invalid", locale: "en" });
    expect((tables.shop[0].settings as Row).mondayEmail).toMatchObject({ enabled: true });
  });
});
