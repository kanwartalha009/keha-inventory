/**
 * POST /app/transfers (Phase 3, Pro `transfers`): Pro only (Growth gets the upgrade reply),
 * the plan re-read on the server, inventory item ids looked up in Shopify, the mutation
 * sent with the @idempotent key, a Transfer row stored, the same plan retried the same day
 * reusing the key (no second transfer), Shopify's user errors shown, and the refusals.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] });
  const tr = (db.client as Record<string, Record<string, unknown>>).transfer!;
  const create = tr.create as (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  let n = 0;
  tr.create = async ({ data }: { data: Record<string, unknown> }) => {
    if ((db.tables.transfer ?? []).some((r) => r.idempotencyKey === data.idempotencyKey)) {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
    }
    return create({ data: { id: `t${++n}`, createdAt: new Date("2026-10-16T09:00:00Z"), ...data } });
  };
  return { default: db.client, __fake: db };
});
const m = vi.hoisted(() => ({
  graphql: vi.fn(),
  can: vi.fn(async () => true),
  createResponse: null as unknown,
}));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ admin: { graphql: m.graphql }, session: { shop: "acme.myshopify.com" } })) },
}));
vi.mock("../app/services/entitlements.server", () => ({ can: m.can }));

import * as dbModule from "../app/db.server";
import { action } from "../app/routes/app.transfers";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const SHOP = "acme.myshopify.com";
const W = "gid://shopify/Location/1";
const S = "gid://shopify/Location/2";
const V1 = "gid://shopify/ProductVariant/11";
const V2 = "gid://shopify/ProductVariant/12";
const inputs = { leadTimeDays: 10, cycleDays: 10, z: 1.65, seasonal: 1, trend: 1 };

function seed() {
  db.reset();
  db.tables.shop = [{ domain: SHOP, timezone: "Europe/Madrid", locale: "es", currency: "EUR" }];
  db.tables.location = [
    { id: W, shop: SHOP, name: "Main", active: true, online: false, onlinePool: null, role: "warehouse" },
    { id: S, shop: SHOP, name: "Barcelona", active: true, online: false, onlinePool: null, role: "store" },
    { id: "gid://shopify/Location/3", shop: SHOP, name: "Web", active: true, online: true, onlinePool: null, role: "other" },
  ];
  db.tables.variant = [
    { id: V1, shop: SHOP, productTitle: "Linen shirt", variantTitle: "S", sku: "LS-S", image: null, tracked: true, isBundle: false },
    { id: V2, shop: SHOP, productTitle: "Linen shirt", variantTitle: "M", sku: "LS-M", image: null, tracked: true, isBundle: false },
  ];
  db.tables.variantMetric = [
    // Every active location counts in supplier orders by default (audit 2026-10-17): compute writes
    // pool warehouses' metrics at their share of the online pace (demandSource "online_pool").
    { shop: SHOP, variantId: V1, scope: W, status: "healthy", rate: 0, sigma: 0, daysLeft: null, inputs: { ...inputs, demandSource: "online_pool" } },
    { shop: SHOP, variantId: V2, scope: W, status: "healthy", rate: 0, sigma: 0, daysLeft: null, inputs: { ...inputs, demandSource: "online_pool" } },
    { shop: SHOP, variantId: V1, scope: S, status: "out", rate: 1, sigma: 0, daysLeft: 0, inputs }, // needs 20
    { shop: SHOP, variantId: V2, scope: S, status: "running_low", rate: 0.5, sigma: 0, daysLeft: 3, inputs }, // needs 10 − 2 = 8
  ];
  db.tables.stockNow = [
    { shop: SHOP, variantId: V1, locationId: W, onHand: 50, available: 50, incoming: 0 },
    { shop: SHOP, variantId: V2, locationId: W, onHand: 50, available: 50, incoming: 0 },
    { shop: SHOP, variantId: V1, locationId: S, onHand: 0, available: 0, incoming: 0 },
    { shop: SHOP, variantId: V2, locationId: S, onHand: 2, available: 2, incoming: 0 },
  ];
  db.tables.transfer = [];
}

const json = (body: unknown) => new Response(JSON.stringify(body));
const created = (id = "gid://shopify/InventoryTransfer/77", name = "#T0077") =>
  json({ data: { inventoryTransferCreate: { inventoryTransfer: { id, name, status: "DRAFT" }, userErrors: [] } } });

function wireGraphql() {
  m.graphql.mockImplementation(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    if (query.includes("KehaInvTransferItems")) {
      const ids = (opts?.variables?.ids ?? []) as string[];
      return json({ data: { nodes: ids.map((id) => ({ id, inventoryItem: { id: id.replace("ProductVariant", "InventoryItem") } })) } });
    }
    if (query.includes("KehaInvTransferCreate")) return (m.createResponse as () => Response)();
    throw new Error(`unexpected query ${query}`);
  });
}

async function post(body: unknown): Promise<Record<string, unknown>> {
  const request = new Request("https://app.test/app/transfers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return ((await action({ request, params: {}, context: {} } as never)) as Response).json() as Promise<Record<string, unknown>>;
}

const createCalls = () => m.graphql.mock.calls.filter((c) => String(c[0]).includes("KehaInvTransferCreate"));
const plan = { originId: W, destinationId: S, quantities: { [V1]: 20, [V2]: 8 } };

beforeEach(() => {
  vi.clearAllMocks();
  m.can.mockResolvedValue(true);
  m.createResponse = () => created();
  wireGraphql();
  seed();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("review fix: pending transfers and the spare cap", () => {
  it("a transfer Keha created in the last 14 days is pending: its units aren't proposed again; an older one no longer counts", async () => {
    const { loadTransfers } = await import("../app/models/transfers.server");
    const now = new Date("2026-10-20T09:00:00Z");
    const sent = (daysAgo: number) => ({
      id: `p${daysAgo}`,
      shop: SHOP,
      shopifyTransferId: "gid://shopify/InventoryTransfer/1",
      originLocationId: W,
      destinationLocationId: S,
      lines: [{ variantId: V1, inventoryItemId: "gid://shopify/InventoryItem/11", quantity: 20 }],
      idempotencyKey: `k${daysAgo}`,
      createdAt: new Date(now.getTime() - daysAgo * 86_400_000),
    });
    db.tables.transfer = [sent(2)];
    const lines = (await loadTransfers(SHOP, now)).groups.flatMap((g) => g.lines);
    expect(lines.find((l) => l.variantId === V1)).toBeUndefined(); // Barcelona's 20 are on their way
    expect(lines.find((l) => l.variantId === V2)).toMatchObject({ qty: 8 });
    db.tables.transfer = [sent(15)];
    expect((await loadTransfers(SHOP, now)).groups.flatMap((g) => g.lines).find((l) => l.variantId === V1)).toMatchObject({ qty: 20 });
  });

  it("refuses quantities above the plan's spare at the warehouse; nothing is created in Shopify", async () => {
    // Main has 50 of V1 and keeps none: 50 spare.
    const r = await post({ ...plan, quantities: { [V1]: 51, [V2]: 8 } });
    expect(r).toEqual({ ok: false, error: "over_spare", variantIds: [V1] });
    expect(createCalls()).toHaveLength(0);
    expect(db.tables.transfer).toEqual([]);
    expect(await post({ ...plan, quantities: { [V1]: 50, [V2]: 8 } })).toMatchObject({ ok: true });
  });
});

describe("create a transfer in Shopify", () => {
  it("looks up inventory items, sends the idempotent mutation, stores the transfer and links to it", async () => {
    const r = await post(plan);
    expect(r).toEqual({ ok: true, id: "gid://shopify/InventoryTransfer/77", name: "#T0077", href: "shopify://admin/transfers/77", existing: false });
    const [doc, opts] = createCalls()[0]! as [string, { variables: { idempotencyKey: string; input: Record<string, unknown> } }];
    expect(doc).toContain("@idempotent(key: $idempotencyKey)");
    expect(opts.variables.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(opts.variables.input).toMatchObject({
      originLocationId: W,
      destinationLocationId: S,
      lineItems: [
        { inventoryItemId: "gid://shopify/InventoryItem/11", quantity: 20 },
        { inventoryItemId: "gid://shopify/InventoryItem/12", quantity: 8 },
      ],
    });
    expect(String(opts.variables.input.note)).toContain("Keha"); // in the store's language
    expect(db.tables.transfer).toHaveLength(1);
    expect(db.tables.transfer[0]).toMatchObject({
      shop: SHOP,
      shopifyTransferId: "gid://shopify/InventoryTransfer/77",
      originLocationId: W,
      destinationLocationId: S,
      idempotencyKey: opts.variables.idempotencyKey,
    });
  });

  it("the same plan again (a retry) reuses the key: no second transfer, the first one is returned", async () => {
    await post(plan);
    const again = await post(plan);
    expect(again).toMatchObject({ ok: true, existing: true, id: "gid://shopify/InventoryTransfer/77" });
    expect(createCalls()).toHaveLength(1);
    expect(db.tables.transfer).toHaveLength(1);
  });

  it("a retry after a lost answer sends the same key to Shopify (Shopify dedupes it)", async () => {
    m.createResponse = () => {
      throw new Error("socket hang up");
    };
    expect(await post(plan)).toEqual({ ok: false, error: "failed" });
    m.createResponse = () => created();
    await post(plan);
    const keys = createCalls().map((c) => (c[1] as { variables: { idempotencyKey: string } }).variables.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("different quantities are a different transfer (a new key)", async () => {
    await post({ ...plan, quantities: { [V1]: 10, [V2]: 8 } });
    // 10 of V1's 20 are pending now: the other 10 are still proposed and can be sent.
    await post({ ...plan, quantities: { [V1]: 10 } });
    const keys = createCalls().map((c) => (c[1] as { variables: { idempotencyKey: string } }).variables.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(db.tables.transfer).toHaveLength(2);
  });

  it("shows Shopify's user errors and stores nothing", async () => {
    m.createResponse = () =>
      json({ data: { inventoryTransferCreate: { inventoryTransfer: null, userErrors: [{ field: ["input"], message: "Not enough inventory", code: "INVALID_QUANTITY" }] } } });
    expect(await post(plan)).toEqual({ ok: false, error: "shopify", userErrors: ["Not enough inventory"] });
    expect(db.tables.transfer).toHaveLength(0);
  });

  it("Growth: refused on the server, Shopify never called", async () => {
    m.can.mockResolvedValue(false);
    expect(await post(plan)).toEqual({ ok: false, error: "upgrade", upgrade: { feature: "transfers", plan: "pro" } });
    expect(m.graphql).not.toHaveBeenCalled();
  });

  it("refuses a route that isn't in the plan, variants outside it and empty quantities", async () => {
    expect(await post({ ...plan, originId: S, destinationId: W })).toEqual({ ok: false, error: "gone" });
    expect(await post({ ...plan, quantities: { "gid://shopify/ProductVariant/999": 5 } })).toEqual({ ok: false, error: "empty" });
    expect(await post({ ...plan, quantities: { [V1]: 0 } })).toEqual({ ok: false, error: "empty" });
    expect(await post({ originId: "nope", destinationId: S, quantities: {} })).toEqual({ ok: false, error: "bad_request" });
    expect(createCalls()).toHaveLength(0);
  });

  it("a variant Shopify no longer knows stops the transfer", async () => {
    m.graphql.mockImplementation(async (query: string) => {
      if (query.includes("KehaInvTransferItems")) return json({ data: { nodes: [{ id: V1, inventoryItem: { id: "gid://shopify/InventoryItem/11" } }, null] } });
      return created();
    });
    expect(await post(plan)).toEqual({ ok: false, error: "gone" });
    expect(createCalls()).toHaveLength(0);
  });
});
