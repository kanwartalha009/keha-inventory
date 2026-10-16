/**
 * POST /app/actions and models/actions.server.ts (task 2.3): snooze / dismiss
 * / done / undo scoped to the session's shop; Clear → discount behind the
 * plan check, the form check and Shopify's user errors, then a Clearance row
 * with its baseline and the action marked done; Home's list read (variants,
 * clearances, the Keha Preorder check only when needed).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma();
  return { default: db.client, __fake: db };
});
const m = vi.hoisted(() => ({
  shop: "acme.myshopify.com",
  graphql: vi.fn(),
  can: vi.fn(async () => true),
}));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ admin: { graphql: m.graphql }, session: { shop: m.shop } })) },
}));
vi.mock("../app/services/entitlements.server", () => ({ can: m.can }));

import * as dbModule from "../app/db.server";
import { action, loader } from "../app/routes/app.actions";
import { getActionList, updateActionState } from "../app/models/actions.server";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const SHOP = "acme.myshopify.com";
const OTHER = "other.myshopify.com";
const P1 = "gid://shopify/Product/1";
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const WH = "gid://shopify/Location/1";
const STORE = "gid://shopify/Location/2";

function post(body: unknown) {
  const request = new Request("https://app.test/app/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return action({ request, params: {}, context: {} } as never).then((r) => (r as Response).json());
}

function seed() {
  db.tables.shop = [{ domain: SHOP, currency: "EUR", timezone: "Europe/Madrid" }];
  db.tables.location = [
    { id: WH, shop: SHOP, active: true, online: true },
    { id: STORE, shop: SHOP, active: true, online: false },
  ];
  db.tables.action = [
    { id: "a1", shop: SHOP, kind: "reorder", productId: P1, variantIds: [V(11)], amount: 300, currency: "EUR", reason: {}, state: "open", snoozeUntil: null, stateAmount: null, doneAt: null },
    { id: "c1", shop: SHOP, kind: "clear", productId: P1, variantIds: [V(11), V(12)], amount: 900, currency: "EUR", reason: {}, state: "open", snoozeUntil: null, stateAmount: null, doneAt: null },
    { id: "x1", shop: OTHER, kind: "clear", productId: P1, variantIds: [V(11)], amount: 50, currency: "EUR", reason: {}, state: "open", snoozeUntil: null, stateAmount: null, doneAt: null },
  ];
  db.tables.variant = [
    { id: V(11), shop: SHOP, productId: P1, productTitle: "Linen shirt", variantTitle: "S", image: null, cost: 10, price: 40 },
    { id: V(12), shop: SHOP, productId: P1, productTitle: "Linen shirt", variantTitle: "M", image: null, cost: null, price: 40 },
  ];
  db.tables.stockNow = [
    { shop: SHOP, variantId: V(11), locationId: WH, onHand: 20 },
    { shop: SHOP, variantId: V(11), locationId: STORE, onHand: 99 }, // not in the online pool
    { shop: SHOP, variantId: V(12), locationId: WH, onHand: 5 },
  ];
  db.tables.clearance = [];
}

const okDiscount = (key: "discountAutomaticBasicCreate" | "discountCodeBasicCreate", id: string) =>
  new Response(
    JSON.stringify({
      data: {
        [key]: {
          [key === "discountCodeBasicCreate" ? "codeDiscountNode" : "automaticDiscountNode"]: { id },
          userErrors: [],
        },
      },
    }),
  );

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  m.can.mockResolvedValue(true);
  seed();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("snooze / dismiss / done / undo", () => {
  it("snooze sets 7 days and remembers the amount", async () => {
    expect(await post({ op: "snooze", id: "a1" })).toEqual({ ok: true, op: "snooze", id: "a1" });
    const row = db.tables.action!.find((r) => r.id === "a1")!;
    expect(row.state).toBe("snoozed");
    expect(row.stateAmount).toBe(300);
    const days = ((row.snoozeUntil as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
  });

  it("dismiss, done and undo", async () => {
    await post({ op: "dismiss", id: "a1" });
    expect(db.tables.action![0]).toMatchObject({ state: "dismissed", stateAmount: 300, snoozeUntil: null });
    await post({ op: "undo", id: "a1" });
    expect(db.tables.action![0]).toMatchObject({ state: "open", stateAmount: null, snoozeUntil: null, doneAt: null });
    await post({ op: "done", id: "a1" });
    expect(db.tables.action![0]!.state).toBe("done");
    expect(db.tables.action![0]!.doneAt).toBeInstanceOf(Date);
  });

  it("never touches another shop's action", async () => {
    expect(await post({ op: "dismiss", id: "x1" })).toEqual({ ok: false, error: "not_found" });
    expect(db.tables.action!.find((r) => r.id === "x1")!.state).toBe("open");
    expect(await updateActionState(SHOP, "x1", "done", new Date())).toBeNull();
  });

  it("rejects a bad body or op", async () => {
    expect(await post("not json")).toEqual({ ok: false, error: "bad_request" });
    expect(await post([1])).toEqual({ ok: false, error: "bad_request" });
    expect(await post({ op: "snooze" })).toEqual({ ok: false, error: "bad_request" });
    expect(await post({ op: "explode", id: "a1" })).toEqual({ ok: false, error: "bad_request" });
  });

  it("has no GET", async () => {
    await expect(loader({ request: new Request("https://app.test/app/actions"), params: {}, context: {} } as never)).rejects.toMatchObject({ status: 405 });
  });
});

describe("clear → discount", () => {
  const form = { op: "clear", id: "c1", kind: "automatic", percent: "25", endsOn: "2099-01-31", code: "" };

  it("Free: refused on the server with an upgrade hint, nothing sent to Shopify", async () => {
    m.can.mockResolvedValue(false);
    expect(await post(form)).toEqual({ ok: false, error: "upgrade", upgrade: { feature: "clearance", plan: "growth" } });
    expect(m.graphql).not.toHaveBeenCalled();
  });

  it("invalid form: field errors, nothing sent", async () => {
    expect(await post({ ...form, percent: "95", endsOn: "2001-01-01" })).toEqual({ ok: false, error: "invalid", errors: { percent: true, endsOn: true } });
    expect(m.graphql).not.toHaveBeenCalled();
  });

  it("only this shop's open Clear actions", async () => {
    expect(await post({ ...form, id: "x1" })).toEqual({ ok: false, error: "not_found" });
    expect(await post({ ...form, id: "a1" })).toEqual({ ok: false, error: "not_found" });
    expect(m.graphql).not.toHaveBeenCalled();
  });

  it("Shopify user errors come back to the dialog; nothing recorded", async () => {
    m.graphql.mockResolvedValue(
      new Response(JSON.stringify({ data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ["basicCodeDiscount", "code"], message: "Code must be unique", code: "TAKEN" }] } } })),
    );
    expect(await post({ ...form, kind: "code", code: "CLEAR-7Q3K" })).toEqual({ ok: false, error: "shopify", userErrors: ["Code must be unique"] });
    expect(db.tables.clearance).toEqual([]);
    expect(db.tables.action!.find((r) => r.id === "c1")!.state).toBe("open");
  });

  it("a thrown Admin call is a generic failure", async () => {
    m.graphql.mockRejectedValue(new Error("network"));
    expect(await post(form)).toEqual({ ok: false, error: "failed" });
  });

  it("automatic: creates the discount, records the Clearance with its baseline, marks the action done", async () => {
    m.graphql.mockResolvedValue(okDiscount("discountAutomaticBasicCreate", "gid://shopify/DiscountAutomaticNode/9"));
    expect(await post(form)).toEqual({ ok: true, op: "clear", id: "c1", discountId: "gid://shopify/DiscountAutomaticNode/9" });

    const [query, opts] = m.graphql.mock.calls[0]!;
    expect(query).toContain("discountAutomaticBasicCreate");
    const input = (opts as { variables: { input: Record<string, unknown> } }).variables.input;
    expect(input).toMatchObject({
      title: "-25%",
      context: { all: "ALL" },
      customerGets: { value: { percentage: 0.25 }, items: { products: { productsToAdd: [P1] } } },
      endsAt: "2099-01-31T22:59:59.000Z", // end of day in Madrid (UTC+1 in winter)
    });
    expect(input).not.toHaveProperty("code");

    expect(db.tables.clearance).toHaveLength(1);
    expect(db.tables.clearance![0]).toMatchObject({
      shop: SHOP,
      actionId: "c1",
      discountId: "gid://shopify/DiscountAutomaticNode/9",
      kind: "automatic",
      code: null,
      percent: 25,
      productIds: [P1],
      variantIds: [V(11), V(12)],
      // online pool only: 20 × cost 10 + 5 × retail 40 (no cost)
      baselineCash: 400,
      baselineUnits: 25,
      currency: "EUR",
    });
    const act = db.tables.action!.find((r) => r.id === "c1")!;
    expect(act.state).toBe("done");
    expect(act.doneAt).toBeInstanceOf(Date);
  });

  it("code: sends the normalised code", async () => {
    m.graphql.mockResolvedValue(okDiscount("discountCodeBasicCreate", "gid://shopify/DiscountCodeNode/3"));
    const r = await post({ ...form, kind: "code", code: "clear-ab12", endsOn: "" });
    expect(r).toMatchObject({ ok: true, discountId: "gid://shopify/DiscountCodeNode/3" });
    const input = (m.graphql.mock.calls[0]![1] as { variables: { input: Record<string, unknown> } }).variables.input;
    expect(input).toMatchObject({ code: "CLEAR-AB12", title: "CLEAR-AB12", endsAt: null });
    expect(db.tables.clearance![0]).toMatchObject({ kind: "code", code: "CLEAR-AB12", endsAt: null });
  });
});

describe("getActionList (Home)", () => {
  it("joins variants, values running clearances, and asks about Keha Preorder only when a Bridge row shows", async () => {
    db.tables.clearance = [
      { id: "cl1", shop: SHOP, kind: "automatic", code: null, percent: 20, productIds: [P1], variantIds: [V(11), V(12)], startsAt: new Date("2026-10-01T00:00:00Z"), endsAt: null, baselineCash: 1000, baselineUnits: 60, currency: "EUR", createdAt: new Date("2026-10-01T00:00:00Z") },
    ];
    const check = vi.fn(async () => true);
    const now = new Date("2026-10-19T08:00:00Z");
    const list = (await getActionList(SHOP, "growth", now, { preorderInstalled: check }))!;
    expect(check).not.toHaveBeenCalled();
    expect(list.rows.map((r) => r.id)).toEqual(["c1", "a1"]);
    expect(list.rows[0]!.productTitle).toBe("Linen shirt");
    expect(list.rows[0]!.variants).toEqual(["S", "M"]);
    expect(list.clearances).toEqual([
      { id: "cl1", kind: "automatic", code: null, percent: 20, productTitle: "Linen shirt", endsOn: null, cashFreed: 600, retail: true, currency: "EUR" },
    ]);

    db.tables.action!.push({ id: "b1", shop: SHOP, kind: "bridge", productId: P1, variantIds: [V(11)], amount: 50, currency: "EUR", reason: { facts: { arrivalDate: "2026-11-02" } }, state: "open", snoozeUntil: null, stateAmount: null, doneAt: null });
    const withBridge = (await getActionList(SHOP, "growth", now, { preorderInstalled: check }))!;
    expect(check).toHaveBeenCalledTimes(1);
    const b = withBridge.rows.find((r) => r.id === "b1")!;
    expect(b.button.kind).toBe("preorder");
    expect(b.button.kind === "preorder" && b.button.href).toBe(
      "https://admin.shopify.com/store/acme/apps/keha-preorder/app/campaigns/new?variants=11&trigger=stock&ship=2026-11-02&name=Linen+shirt",
    );

    check.mockClear();
    const free = (await getActionList(SHOP, "free", now, { preorderInstalled: check }))!;
    expect(check).not.toHaveBeenCalled();
    expect(free.rows.find((r) => r.id === "b1")!.button).toEqual({ kind: "locked", feature: "bridge" });

    const failing = (await getActionList(SHOP, "growth", now, { preorderInstalled: async () => Promise.reject(new Error("x")) }))!;
    expect(failing.rows.find((r) => r.id === "b1")!.button.kind).toBe("signups");
  });

  it("no Shop row yet → null", async () => {
    db.tables.shop = [];
    expect(await getActionList(SHOP, "growth", new Date())).toBeNull();
  });
});
