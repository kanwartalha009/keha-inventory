/**
 * Planner data side (task 2.5) against an in-memory Prisma: the scenario limit is checked on the
 * server (Growth 1, Pro unlimited, Free 0), results are calculated on save and stored versioned,
 * edits / recalculations / deletes are scoped to the shop, collection goals are validated and
 * their share uses the channel view only, and the accuracy scorecard (empty + graded).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ collectionGoal: ["shop", "collectionId"] });
  return { default: db.client, __fake: db };
});

const m = vi.hoisted(() => ({ plan: "growth" as "free" | "growth" | "pro" }));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "acme.myshopify.com" } })) },
}));
vi.mock("../app/services/entitlements.server", async () => {
  const { featureMap } = await import("../app/lib/plan-shared");
  return {
    getEntitlements: vi.fn(async () => ({ plan: m.plan, features: featureMap(m.plan), comped: false, checked: true })),
    upgradeResponse: (feature: string, message: string) => Response.json({ ok: false, error: message, upgrade: { feature } }, { status: 403 }),
  };
});

import * as dbModule from "../app/db.server";
import { action } from "../app/routes/app.planner";
import {
  createScenario,
  deleteGoal,
  deleteScenario,
  listScenarios,
  loadGoals,
  loadPlanner,
  loadScorecard,
  recalculateScenario,
  saveGoal,
  updateScenario,
} from "../app/models/planner.server";
import { computeScenarioFor } from "../app/services/planner.server";
import { RESULT_VERSION, type ScenarioInput } from "../app/lib/planner-shared";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const SHOP = "acme.myshopify.com";
const OTHER = "other.myshopify.com";
const NOW = new Date("2026-10-16T10:00:00Z");
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const P = (n: number) => `gid://shopify/Product/${n}`;
const WH = "gid://shopify/Location/1";
const POS = "gid://shopify/Location/2";
const D = (day: string) => new Date(`${day}T00:00:00.000Z`);

const BF: ScenarioInput = { name: "Black Friday", event: "black_friday", start: "2026-11-26", end: "2026-11-30", targetType: "growth", targetValue: 20 };

let seq = 0;
function seed() {
  db.reset();
  db.tables.shop = [{ domain: SHOP, currency: "EUR", timezone: "UTC", settings: { leadTimeDays: 10 }, backfillState: {} }];
  db.tables.location = [
    { id: WH, shop: SHOP, active: true, online: true },
    { id: POS, shop: SHOP, active: true, online: false },
  ];
  const variant = (n: number, collections: string[]) => ({
    id: V(n),
    shop: SHOP,
    productId: P(n),
    productTitle: `Shirt ${n}`,
    variantTitle: "M",
    sku: null,
    image: null,
    vendor: "Acme",
    supplierId: null,
    collections,
    caseQty: null,
    cost: 4,
    costCurrency: "EUR",
    price: 20,
    tracked: true,
    isBundle: false,
    status: "ACTIVE",
  });
  db.tables.variant = [variant(1, ["C1", "C2"]), variant(2, ["C2"]), { ...variant(3, ["C1"]), shop: OTHER }];
  db.tables.variantMetric = [
    { shop: SHOP, variantId: V(1), scope: "online", rate: 2, sigma: 1, status: "running_low", inputs: { z: 1.65, enoughData: true } },
    { shop: SHOP, variantId: V(2), scope: "online", rate: 1, sigma: 0.5, status: "out", inputs: { z: 1.28, enoughData: true } },
  ];
  db.tables.stockNow = [
    { shop: SHOP, variantId: V(1), locationId: WH, onHand: 5, incoming: 0 },
    { shop: SHOP, variantId: V(1), locationId: POS, onHand: 500, incoming: 0 }, // not in the online pool
  ];
  db.tables.purchaseOrder = [
    { shop: SHOP, source: "keha", status: "sent", lines: [{ variantId: V(1), qty: 3, received: 0 }], confirmedShipDate: null, expectedDate: null },
    { shop: SHOP, source: "keha", status: "draft", lines: [{ variantId: V(1), qty: 99 }], confirmedShipDate: null, expectedDate: null },
  ];
  db.tables.supplier = [];
  db.tables.salesDaily = [];
  db.tables.scenario = [];
  db.tables.collection = [
    { id: "C1", shop: SHOP, title: "Summer", handle: "summer" },
    { id: "C2", shop: SHOP, title: "", handle: "basics" },
    { id: "C9", shop: OTHER, title: "Theirs", handle: "theirs" },
  ];
  db.tables.collectionGoal = [];
  db.tables.action = [];
  db.tables.accuracyMonth = [];
  db.tables.forecastSnapshot = [];
}

// The fake has no @default(cuid()): give created scenarios an id like Prisma would.
beforeEach(() => {
  seed();
  const client = db.client as Record<string, { create: (a: { data: Record<string, unknown> }) => Promise<unknown> }>;
  const model = client.scenario;
  const create = model.create;
  model.create = async (args) => create({ data: { id: `sc${++seq}`, createdAt: new Date(NOW.getTime() + seq), ...args.data } });
});

describe("scenario limit (checked on the server)", () => {
  it("Growth keeps 1 scenario; the second is refused", async () => {
    expect((await createScenario(SHOP, "growth", BF, NOW)).ok).toBe(true);
    expect(await createScenario(SHOP, "growth", { ...BF, name: "Christmas" }, NOW)).toEqual({ ok: false, error: "limit" });
    expect(db.tables.scenario).toHaveLength(1);
  });

  it("Pro is unlimited; Free has none; other shops' scenarios don't count", async () => {
    db.tables.scenario.push({ id: "x", shop: OTHER, name: "Theirs", start: D("2026-11-01"), end: D("2026-11-02") });
    for (let i = 0; i < 3; i++) expect((await createScenario(SHOP, "pro", { ...BF, name: `S${i}` }, NOW)).ok).toBe(true);
    expect(await createScenario(SHOP, "free", BF, NOW)).toEqual({ ok: false, error: "limit" });
    expect(db.tables.scenario.filter((s) => s.shop === SHOP)).toHaveLength(3);
    expect((await createScenario(OTHER, "growth", BF, NOW)).ok).toBe(false); // OTHER already has 1
  });

  it("a store above its limit after a downgrade can still edit, recalculate and delete", async () => {
    for (let i = 0; i < 2; i++) await createScenario(SHOP, "pro", { ...BF, name: `S${i}` }, NOW);
    const [a] = await listScenarios(SHOP);
    expect((await updateScenario(SHOP, a!.id, { ...BF, name: "Renamed", targetType: "keep_pace", targetValue: 0 }, NOW)).ok).toBe(true);
    expect((await recalculateScenario(SHOP, a!.id, new Date("2026-10-17T10:00:00Z"))).ok).toBe(true);
    const data = await loadPlanner(SHOP, { plan: "growth", features: { collectionGoals: true, accuracy: true }, selectedId: a!.id, edit: "new", now: NOW });
    expect(data.canAdd).toBe(false);
    expect(data.limit).toBe(1);
    expect(data.editing).toBeNull(); // "new" is refused at the limit
    expect(data.selected).toMatchObject({ name: "Renamed", targetType: "keep_pace", computedAt: "2026-10-17T10:00:00.000Z" });
    expect(await deleteScenario(SHOP, a!.id)).toBe(true);
    expect(await listScenarios(SHOP)).toHaveLength(1);
  });
});

describe("planner action (server-side plan checks)", () => {
  const post = async (body: unknown) => {
    const request = new Request("https://app.test/app/planner", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const r = (await action({ request, params: {}, context: {} } as never)) as unknown;
    return r instanceof Response ? { status: r.status, body: await r.json() } : { status: 200, body: r };
  };
  const form = { name: "Black Friday", event: "black_friday", start: "2026-11-26", end: "2026-11-30", targetType: "growth", targetValue: "20" };

  it("Growth: the first save creates, the second is refused at the limit; validation errors come back", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      m.plan = "growth";
      expect((await post({ intent: "save", form })).body).toMatchObject({ ok: true, intent: "save" });
      expect((await post({ intent: "save", form: { ...form, name: "Second" } })).body).toEqual({ ok: false, error: "limit" });
      expect((await post({ intent: "save", form: { ...form, name: "" } })).body).toEqual({ ok: false, errors: { name: "name" } });
      expect(db.tables.scenario).toHaveLength(1);
      m.plan = "pro";
      expect((await post({ intent: "save", form: { ...form, name: "Second" } })).body).toMatchObject({ ok: true });
      expect(db.tables.scenario).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Free: every intent is refused with the upgrade answer", async () => {
    m.plan = "free";
    const r = await post({ intent: "save", form });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, upgrade: { feature: "planner" } });
    expect(db.tables.scenario).toHaveLength(0);
    m.plan = "growth";
  });

  it("goals: saved and removed through the action; unknown intents are a 400", async () => {
    m.plan = "growth";
    expect((await post({ intent: "goal_save", collectionId: "C1", goalPct: "40" })).body).toEqual({ ok: true, intent: "goal_save" });
    expect((await post({ intent: "goal_save", collectionId: "C1", goalPct: "400" })).body).toEqual({ ok: false, error: "pct" });
    expect((await post({ intent: "goal_delete", collectionId: "C1" })).body).toEqual({ ok: true, intent: "goal_delete" });
    await expect(post({ intent: "nope" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("results calculated on save", () => {
  it("stores a versioned result with computedAt; pool stock + sent Keha orders only", async () => {
    await createScenario(SHOP, "growth", BF, NOW);
    const [s] = await listScenarios(SHOP);
    expect(s!.result).not.toBeNull();
    expect(s!.result).toMatchObject({ version: RESULT_VERSION, status: "ok", computedAt: NOW.toISOString(), currency: "EUR" });
    const line = s!.result!.groups.flatMap((g) => g.lines).find((l) => l.variantId === V(1))!;
    // onHand: the online pool only (5, not 505); incoming: the sent Keha order (3), not the draft.
    expect(line).toMatchObject({ onHand: 5, incoming: 3, leadTimeDays: 10 });
    expect(s!.result!.history.enough).toBe(false);
    expect(s!.result!.lastYear).toMatchObject({ from: "2025-11-26", to: "2025-11-30", units: null, revenue: null });
  });

  it("review fix: the pool honours the 'counts for online sales' override; Keha units compute saw land are not incoming again", async () => {
    const { computeScenarioFor } = await import("../app/services/planner.server");
    db.tables.variantMetric[0]!.rate = 100; // enough demand that V1 always gets a line
    db.tables.variantMetric[0]!.inputs = { z: 1.65, enoughData: true, kehaLanded: 2 };
    const line = async () =>
      (await computeScenarioFor(SHOP, BF, NOW)).groups.flatMap((g) => g.lines).find((l) => l.variantId === V(1))!;
    // Shopify's flag: the POS store is not online → 5 on hand; Keha 3 sent − 2 landed → 1 incoming.
    expect(await line()).toMatchObject({ onHand: 5, incoming: 1 });
    // The merchant counts the POS store for online sales → its 500 join the pool.
    db.tables.location[1]!.onlinePool = true;
    expect(await line()).toMatchObject({ onHand: 505 });
  });

  it("edits and deletes are scoped to the shop", async () => {
    db.tables.scenario.push({ id: "theirs", shop: OTHER, name: "Theirs", event: "custom", start: D("2026-11-01"), end: D("2026-11-02"), targetType: "keep_pace", targetValue: 0, result: null });
    expect(await updateScenario(SHOP, "theirs", BF, NOW)).toEqual({ ok: false, error: "notFound" });
    expect(await recalculateScenario(SHOP, "theirs", NOW)).toEqual({ ok: false, error: "notFound" });
    expect(await deleteScenario(SHOP, "theirs")).toBe(false);
    expect(db.tables.scenario.find((s) => s.id === "theirs")!.name).toBe("Theirs");
  });

  it("last year same period reads the channel view only (never added to the location view)", async () => {
    db.tables.shop[0]!.backfillState = { datasets: { sales: { doneThrough: "2025-08-01", syncedThrough: "2026-10-15" } } };
    db.tables.salesDaily = [
      { shop: SHOP, day: D("2025-11-27"), variantId: V(1), locationKey: "all", channel: "Online Store", sold: 10, returned: 0, gross: 200 },
      { shop: SHOP, day: D("2025-11-27"), variantId: V(1), locationKey: "all", channel: "Point of Sale", sold: 2, returned: 0, gross: 40 },
      { shop: SHOP, day: D("2025-11-27"), variantId: V(1), locationKey: "online", channel: "all", sold: 10, returned: 0, gross: 0 },
      { shop: OTHER, day: D("2025-11-27"), variantId: V(3), locationKey: "all", channel: "Online Store", sold: 99, returned: 0, gross: 999 },
    ];
    const r = await computeScenarioFor(SHOP, BF, NOW);
    expect(r.lastYear).toMatchObject({ from: "2025-11-26", to: "2025-11-30", units: 12, revenue: 240, coverage: 1 });
    expect(r.history.enough).toBe(true);
  });
});

describe("collection goals", () => {
  it("validates the collection (this shop's only) and the share", async () => {
    expect(await saveGoal(SHOP, { collectionId: "C9", goalPct: 10 })).toEqual({ ok: false, error: "collection" });
    expect(await saveGoal(SHOP, { collectionId: "C1", goalPct: 120 })).toEqual({ ok: false, error: "pct" });
    expect(await saveGoal(SHOP, { collectionId: "C1", goalPct: "30" })).toEqual({ ok: true });
    expect(await saveGoal(SHOP, { collectionId: "C1", goalPct: 35 })).toEqual({ ok: true });
    expect(db.tables.collectionGoal).toEqual([{ shop: SHOP, collectionId: "C1", goalPct: 35 }]);
    expect(await deleteGoal(SHOP, "C1")).toBe(true);
    expect(db.tables.collectionGoal).toEqual([]);
  });

  it("actual share over 90 days from the channel view, overlapping collections, products holding it back", async () => {
    db.tables.shop[0]!.backfillState = { datasets: { sales: { doneThrough: "2026-01-01", syncedThrough: "2026-10-15" } } };
    db.tables.collectionGoal = [
      { shop: SHOP, collectionId: "C1", goalPct: 60 },
      { shop: SHOP, collectionId: "C2", goalPct: 70 },
    ];
    db.tables.salesDaily = [
      { shop: SHOP, day: D("2026-10-01"), variantId: V(1), locationKey: "all", channel: "Online Store", sold: 5, returned: 0, gross: 300 },
      { shop: SHOP, day: D("2026-10-01"), variantId: V(2), locationKey: "all", channel: "Online Store", sold: 5, returned: 0, gross: 100 },
      { shop: SHOP, day: D("2026-10-01"), variantId: V(99), locationKey: "all", channel: "Online Store", sold: 5, returned: 0, gross: 600 }, // not in the catalog: still store revenue
      { shop: SHOP, day: D("2026-10-01"), variantId: V(1), locationKey: "online", channel: "all", sold: 5, returned: 0, gross: 0 }, // location view: ignored
      { shop: SHOP, day: D("2026-06-01"), variantId: V(1), locationKey: "all", channel: "Online Store", sold: 5, returned: 0, gross: 5000 }, // older than 90 days
    ];
    db.tables.action = [{ shop: SHOP, kind: "reorder", state: "open", productId: P(1), amount: 250 }];
    const g = await loadGoals(SHOP, { today: "2026-10-16", coverage: { from: "2026-01-01", to: "2026-10-15" } });
    expect(g.total).toBe(130);
    expect(g.window).toEqual({ from: "2026-07-18", to: "2026-10-15" });
    const byId = new Map(g.rows.map((r) => [r.collectionId, r]));
    expect(byId.get("C1")).toMatchObject({ title: "Summer", actualShare: 0.3, gapPts: 30 });
    expect(byId.get("C2")).toMatchObject({ title: "basics", actualShare: 0.4, gapPts: 30 });
    expect(byId.get("C2")!.holdingBack.map((p) => [p.productId, p.atRisk, p.out, p.low])).toEqual([
      [P(1), 250, 0, 1],
      [P(2), null, 1, 0],
    ]);
  });
});

describe("accuracy scorecard", () => {
  it("empty: the date the first scorecard arrives", async () => {
    expect(await loadScorecard(SHOP, "2026-10-16")).toEqual({ kind: "empty", firstDate: "2026-12-01" });
    db.tables.forecastSnapshot = [{ shop: SHOP, month: D("2026-10-01"), variantId: V(1), predicted: 10, actual: null }];
    expect(await loadScorecard(SHOP, "2026-10-16")).toEqual({ kind: "empty", firstDate: "2026-11-01" });
  });

  it("graded: the latest month and its top rows by revenue in the month before (the ranking the grade used)", async () => {
    db.tables.accuracyMonth = [
      { shop: SHOP, month: D("2026-08-01"), storeErrorPct: 30, top20ErrorPct: 40, graded: 1 },
      { shop: SHOP, month: D("2026-09-01"), storeErrorPct: 12.5, top20ErrorPct: 18, graded: 2 },
    ];
    db.tables.forecastSnapshot = [
      { shop: SHOP, month: D("2026-09-01"), variantId: "__store__", predicted: 30, actual: 26 },
      { shop: SHOP, month: D("2026-09-01"), variantId: V(1), predicted: 20, actual: 16 },
      { shop: SHOP, month: D("2026-09-01"), variantId: V(2), predicted: 10, actual: 10 },
    ];
    db.tables.salesDaily = [
      { shop: SHOP, day: D("2026-08-10"), variantId: V(2), locationKey: "all", channel: "Online Store", sold: 10, returned: 0, gross: 500 },
      { shop: SHOP, day: D("2026-08-10"), variantId: V(1), locationKey: "all", channel: "Online Store", sold: 16, returned: 0, gross: 320 },
      // The graded month's own revenue (look-ahead) would rank V(1) first: ignored.
      { shop: SHOP, day: D("2026-09-10"), variantId: V(1), locationKey: "all", channel: "Online Store", sold: 16, returned: 0, gross: 9000 },
    ];
    const s = await loadScorecard(SHOP, "2026-10-16");
    expect(s).toMatchObject({ kind: "graded", month: "2026-09-01", storeErrorPct: 12.5, top20ErrorPct: 18, graded: 2 });
    if (s.kind !== "graded") throw new Error("graded");
    expect(s.rows.map((r) => [r.variantId, r.productTitle, r.predicted, r.actual, r.errorPct])).toEqual([
      [V(2), "Shirt 2", 10, 10, 0],
      [V(1), "Shirt 1", 20, 16, 25],
    ]);
  });
});
