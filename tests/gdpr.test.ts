/**
 * GDPR handlers: reinstall cancels the 48h purge, the shop purge covers every
 * shop-scoped table, customer redaction removes delivered outbox copies, and
 * the data request tells the store owner that no shopper data is stored.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown> & { id?: string; shop?: string };
const { tables, calls, fakeDb, sendEmail, failing } = vi.hoisted(() => {
const tables: Record<string, Row[]> = {};
const failing = new Set<string>();
const calls: { table: string; op: string; where: unknown }[] = [];

// Tiny where-matcher: equality, { in }, { not: null }, { lt }, { contains }, OR.
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    if (k === "NOT") return !matches(row, cond as Record<string, unknown>);
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(v);
      if ("not" in c) return c.not === null ? v != null : v !== c.not;
      if ("lt" in c) return v instanceof Date && v < (c.lt as Date);
      if ("contains" in c) return typeof v === "string" && v.includes(c.contains as string);
      return false;
    }
    return v === cond;
  });
}

function model(table: string) {
  const rows = () => (tables[table] ??= []);
  return {
    findMany: async ({ where }: { where: Record<string, unknown> }) => rows().filter((r) => matches(r, where)),
    count: async ({ where }: { where: Record<string, unknown> }) => rows().filter((r) => matches(r, where)).length,
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      calls.push({ table, op: "deleteMany", where });
      if (failing.has(table)) throw new Error(`${table} delete failed`);
      const keep = rows().filter((r) => !matches(r, where));
      const count = rows().length - keep.length;
      tables[table] = keep;
      return { count };
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      let count = 0;
      for (const r of rows()) if (matches(r, where)) (Object.assign(r, data), count++);
      return { count };
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const r = rows().find((x) => matches(x, where));
      if (r) Object.assign(r, data);
      return r;
    },
  };
}

  const fakeDb = new Proxy({}, { get: (_t, name: string) => model(name) });
  const sendEmail = vi.fn(async (...args: unknown[]) => ({ ok: args.length > 0 }));
  return { tables, calls, fakeDb, sendEmail, failing };
});

vi.mock("../app/db.server", () => ({ default: fakeDb }));
vi.mock("../app/services/pii-log.server", () => ({
  logPersonalDataAccess: vi.fn(async () => {}),
  deleteShopPersonalDataLogs: vi.fn(async () => 0),
}));
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/services/email.server", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
  emailTransportConfigured: () => true,
}));
vi.mock("../app/services/shop-contact.server", () => ({
  getShopContact: async () => ({ name: "Acme", contactEmail: "hello@acme.com", ownerEmail: "owner@acme.com" }),
}));

import { setFactsStore } from "../app/services/facts-store.server";
import { delegateFactsStore } from "./helpers/fake-facts";
import {
  purgeDueShops,
  purgeShopData,
  redactCustomer,
  deliverDataRequest,
  cancelPendingPurge,
} from "../app/services/gdpr.server";
import { emailForms } from "../app/lib/gdpr-shared";
import { Prisma } from "@prisma/client";
import { PURGE_KEEP, PurgeIncompleteError, delegateName, purgePlan } from "../app/services/gdpr.server";

// The compact facts (keyed by Shop.num) are purged through the facts store: here, its in-memory
// form over this file's fake (salesDaily / stockDaily / sessionsDaily rows keyed by shop).
setFactsStore(delegateFactsStore(fakeDb as Record<string, unknown>));

const S = "acme.myshopify.com";
const OLD = new Date(Date.now() - 49 * 60 * 60 * 1000);

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  calls.length = 0;
  sendEmail.mockClear();
});

describe("gdpr-shared", () => {
  it("matches the email as sent and lower-cased", () => {
    expect(emailForms(" Ann@X.com ")).toEqual(["Ann@X.com", "ann@x.com"]);
    expect(emailForms(null)).toEqual([]);
  });
});

describe("48h purge", () => {
  it("cancels the purge for a shop that reinstalled, purges the rest", async () => {
    tables.uninstalledShop = [
      { shop: S, uninstalledAt: OLD, purgedAt: null },
      { shop: "gone.myshopify.com", uninstalledAt: OLD, purgedAt: null },
    ];
    tables.session = [{ id: "s1", shop: S }];
    tables.billingState = [{ shop: S }, { shop: "gone.myshopify.com" }];
    const res = await purgeDueShops();
    expect(res.map((r) => r.shop)).toEqual(["gone.myshopify.com"]);
    expect(tables.billingState.map((c) => c.shop)).toEqual([S]);
    expect(tables.uninstalledShop.map((u) => u.shop)).toEqual(["gone.myshopify.com"]);
  });
  it("afterAuth cancel leaves already-purged rows as the audit trail", async () => {
    tables.uninstalledShop = [{ shop: S, uninstalledAt: OLD, purgedAt: null }];
    expect(await cancelPendingPurge(S)).toBe(1);
    tables.uninstalledShop = [{ shop: S, uninstalledAt: OLD, purgedAt: new Date() }];
    expect(await cancelPendingPurge(S)).toBe(0);
  });
  it("shop purge covers billing, referral and delivered outbox rows", async () => {
    tables.billingState = [{ shop: S }];
    tables.novaReferral = [{ shop: S }];
    tables.novaOutbox = [
      { id: "o1", status: "SENT", headers: `{"X-Nova-Shop-Domain":"${S}"}`, body: "" },
      { id: "o2", status: "DEAD", headers: "{}", body: `{"shopDomain":"${S}"}` },
      { id: "o3", status: "PENDING", headers: `{"X-Nova-Shop-Domain":"${S}"}`, body: "{}" },
      { id: "o4", status: "SENT", headers: `{"X-Nova-Shop-Domain":"x${S}"}`, body: "" },
    ];
    const counts = await purgeShopData(S);
    expect(counts.billingState).toBe(1);
    expect(counts.novaReferral).toBe(1);
    expect(tables.novaOutbox.map((o) => o.id)).toEqual(["o3", "o4"]);
  });
});

describe("shop purge covers every shop table (invariant I-3)", () => {
  // Expected list derived from the generated schema, never written by hand.
  const shopModels = Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === "shop")).map((m) => m.name);

  it("only the purge bookkeeping is kept", () => {
    expect([...PURGE_KEEP]).toEqual(["UninstalledShop"]);
    expect(shopModels).toContain("UninstalledShop");
  });

  it("deletes from every model with a shop column, plus Shop by domain, Session last", async () => {
    tables.shop = [{ id: "x", domain: S }, { id: "y", domain: "other.myshopify.com" }];
    tables.salesDaily = [{ shop: S }, { shop: "other.myshopify.com" }];
    await purgeShopData(S);
    const deleted = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    const expected = shopModels.filter((m) => !(PURGE_KEEP as readonly string[]).includes(m)).map(delegateName);
    for (const t of expected) expect(deleted, t).toContain(t);
    expect(deleted).toContain("shop");
    expect(deleted).toContain("novaOutbox");
    expect(deleted).not.toContain("uninstalledShop");
    expect(deleted[deleted.length - 1]).toBe("session");
    const shopCall = calls.find((c) => c.table === "shop" && c.op === "deleteMany");
    expect(shopCall?.where).toEqual({ domain: S });
    expect(tables.shop.map((r) => r.domain)).toEqual(["other.myshopify.com"]);
    expect(tables.salesDaily.map((r) => r.shop)).toEqual(["other.myshopify.com"]);
    expect(purgePlan().length).toBe(expected.length + 1); // + Shop
  });
});

describe("purge failures are retried, never stamped (review M)", () => {
  it("a failed table delete throws, keeps the sessions, and purgeDueShops does not stamp purgedAt", async () => {
    tables.uninstalledShop = [{ shop: S, uninstalledAt: OLD, purgedAt: null }];
    tables.session = []; // uninstalled: no session
    tables.salesDaily = [{ shop: S }];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    failing.add("salesDaily");
    try {
      await expect(purgeShopData(S)).rejects.toBeInstanceOf(PurgeIncompleteError);
      expect(calls.some((c) => c.table === "session" && c.op === "deleteMany")).toBe(false);
      const res = await purgeDueShops();
      expect(res).toEqual([]);
      expect(tables.uninstalledShop[0].purgedAt).toBeNull();
    } finally {
      failing.delete("salesDaily");
      spy.mockRestore();
    }
    // Next tick, the table works again: purged and stamped.
    const res = await purgeDueShops();
    expect(res.map((r) => r.shop)).toEqual([S]);
    expect(tables.uninstalledShop[0].purgedAt).toBeInstanceOf(Date);
    expect(tables.salesDaily).toEqual([]);
  });
});

describe("customers/redact", () => {
  it("removes delivered outbox copies carrying the email, keeps pending ones", async () => {
    tables.novaOutbox = [
      { id: "o1", status: "SENT", headers: "{}", body: '{"email":"ann@x.com"}' },
      { id: "o2", status: "PENDING", headers: "{}", body: '{"email":"ann@x.com"}' },
      { id: "o3", status: "SENT", headers: "{}", body: '{"email":"bob@x.com"}' },
    ];
    const r = await redactCustomer(S, { customer: { id: 5, email: "Ann@x.com" } });
    expect(r.outboxDeleted).toBe(1);
    expect(tables.novaOutbox.map((o) => o.id)).toEqual(["o2", "o3"]);
  });
});

describe("customers/data_request", () => {
  it("tells the store owner no shopper data is stored", async () => {
    const r = await deliverDataRequest(S, { customer: { email: "ann@x.com" }, data_request: { id: 9 } });
    expect(r.ok).toBe(true);
    const arg = (sendEmail.mock.calls[0] as unknown as [{ to: string; text: string }])[0];
    expect(arg.to).toBe("owner@acme.com");
    expect(arg.text).toContain("stores no personal data about this customer");
    expect(arg.text).toContain("request 9");
  });
});
