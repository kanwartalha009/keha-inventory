/**
 * Settings → Locations (Phase 3, Pro `locations`): the save on Pro (roles and "counts for
 * online sales", this shop's locations only), the refusal below Pro (403 upgrade JSON),
 * validation (bad values, foreign locations, an empty online pool), and SSR of the tab:
 * editable on Pro, read-only with the one-pool teaching text on Growth.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type { FakeDb } from "./helpers/fake-prisma";

const m = vi.hoisted(() => ({ locations: true }));

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma();
  return { default: db.client, __fake: db };
});
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "acme.myshopify.com" } })) },
}));
vi.mock("../app/services/entitlements.server", () => ({
  getEntitlements: async () => ({ plan: m.locations ? "pro" : "growth", features: { locations: m.locations }, comped: false, checked: true }),
  upgradeResponse: (feature: string, message: string) =>
    Response.json({ ok: false, error: message, upgrade: { feature, plan: "pro" } }, { status: 403 }),
}));

import * as dbModule from "../app/db.server";
import LocationsSettings, { action, loader, type LocationsData } from "../app/routes/app.settings_.locations";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const SHOP = "acme.myshopify.com";
const W = "gid://shopify/Location/1";
const S = "gid://shopify/Location/2";
const FOREIGN = "gid://shopify/Location/9";

function seed() {
  db.reset();
  db.tables.location = [
    { id: W, shop: SHOP, name: "Main warehouse", active: true, online: true, role: "other", onlinePool: null },
    { id: S, shop: SHOP, name: "Barcelona", active: true, online: false, role: "other", onlinePool: null },
    { id: "gid://shopify/Location/3", shop: SHOP, name: "Closed", active: false, online: true, role: "store", onlinePool: null },
    { id: FOREIGN, shop: "other.myshopify.com", name: "Theirs", active: true, online: true, role: "other", onlinePool: null },
  ];
}

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = new Request("https://app.test/app/settings/locations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const r = await action({ request, params: {}, context: {} } as never);
  if (r instanceof Response) return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  return { status: 200, json: r as Record<string, unknown> };
}

const loc = (id: string) => db.tables.location.find((l) => l.id === id)!;

beforeEach(() => {
  m.locations = true;
  seed();
});

describe("Settings → Locations action", () => {
  it("Pro: saves roles and the online-pool choice", async () => {
    const r = await post({
      intent: "save",
      locations: [
        { id: W, role: "warehouse", pool: "follow" },
        { id: S, role: "store", pool: "yes" },
      ],
    });
    expect(r).toEqual({ status: 200, json: { ok: true, saved: 2 } });
    expect(loc(W)).toMatchObject({ role: "warehouse", onlinePool: null });
    expect(loc(S)).toMatchObject({ role: "store", onlinePool: true });
  });

  it("refuses another shop's location and leaves it alone", async () => {
    const r = await post({ intent: "save", locations: [{ id: FOREIGN, role: "store", pool: "no" }] });
    expect(r.json).toEqual({ ok: false, error: "unknown" });
    expect(loc(FOREIGN)).toMatchObject({ role: "other", onlinePool: null });
  });

  it("refuses an inactive location, bad values and an empty online pool", async () => {
    expect((await post({ intent: "save", locations: [{ id: "gid://shopify/Location/3", role: "store", pool: "no" }] })).json).toEqual({
      ok: false,
      error: "unknown",
    });
    expect((await post({ intent: "save", locations: [{ id: W, role: "pos", pool: "follow" }] })).json).toEqual({ ok: false, error: "invalid" });
    expect((await post({ intent: "save", locations: [{ id: W, role: "warehouse", pool: "no" }] })).json).toEqual({
      ok: false,
      error: "emptyPool",
    });
    expect(loc(W)).toMatchObject({ role: "other", onlinePool: null });
  });

  it("Growth: refused on the server with the upgrade JSON", async () => {
    m.locations = false;
    const r = await post({ intent: "save", locations: [{ id: S, role: "store", pool: "follow" }] });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ ok: false, upgrade: { feature: "locations" } });
    expect(loc(S).role).toBe("other");
  });

  it("the loader lists this shop's active locations with Shopify's online flag", async () => {
    const data = (await loader({ request: new Request("https://app.test/app/settings/locations"), params: {}, context: {} } as never)) as LocationsData;
    expect(data.enabled).toBe(true);
    expect(data.locations.map((l) => [l.name, l.online, l.counts, l.pool])).toEqual([
      ["Barcelona", false, false, "follow"],
      ["Main warehouse", true, true, "follow"],
    ]);
  });
});

function render(data: LocationsData) {
  const Stub = createRoutesStub([{ id: "locations", path: "/app/settings/locations", Component: LocationsSettings, loader: () => data }]);
  return renderToString(<Stub initialEntries={["/app/settings/locations"]} hydrationData={{ loaderData: { locations: data } }} />);
}

const rows: LocationsData["locations"] = [
  { id: W, name: "Main warehouse", online: true, role: "warehouse", pool: "follow", counts: true },
  { id: S, name: "Barcelona", online: false, role: "store", pool: "no", counts: false },
];

describe("Settings → Locations SSR", () => {
  it("Pro: each location with its role and online-pool choice, editable, and Save", () => {
    const html = render({ locations: rows, enabled: true });
    expect(html).toContain("Main warehouse");
    expect(html).toContain("Barcelona");
    expect(html).toContain("Fulfils online orders in Shopify");
    expect(html).toContain("Doesn&#x27;t fulfil online orders in Shopify");
    for (const s of ["Role", "Counts for online sales", "Warehouse", "Store", "Other", "Follow Shopify (Yes)", "Follow Shopify (No)"]) expect(html).toContain(s);
    expect(html).toContain("Save");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("See plans");
  });

  it("Growth: read-only, teaches the one stock pool, Upgrade", () => {
    const html = render({ locations: rows, enabled: false });
    expect(html).toContain("Free and Growth plan all your stock as one pool.");
    expect(html).toContain("Counting for online sales now: Main warehouse.");
    expect(html).toContain("Locations and stores");
    expect(html).toContain("See plans");
    expect(html).toContain("disabled");
  });

  it("empty state", () => {
    const html = render({ locations: [], enabled: true });
    expect(html).toContain("No active locations yet");
  });
});
