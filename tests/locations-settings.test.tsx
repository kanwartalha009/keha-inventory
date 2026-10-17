/**
 * Settings → Locations: the include toggle ("Counts in supplier orders") on every plan, roles
 * on Pro (a role change below Pro: 403 upgrade JSON), this shop's locations only,
 * validation (bad values, foreign locations, nothing counted), and SSR of the tab.
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
import { expectSettingsAnatomy } from "./helpers/settings-anatomy";

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
  it("Pro: saves roles and the include toggle", async () => {
    const r = await post({
      intent: "save",
      locations: [
        { id: W, role: "warehouse", include: true },
        { id: S, role: "store", include: true },
      ],
    });
    expect(r).toEqual({ status: 200, json: { ok: true, saved: 2 } });
    expect(loc(W)).toMatchObject({ role: "warehouse", onlinePool: null });
    // Every active location counts unless left out (countsForOnline): including an untouched
    // store keeps following that rule (null); leaving it out writes false, including it again true.
    expect(loc(S)).toMatchObject({ role: "store", onlinePool: null });
    await post({ intent: "save", locations: [{ id: S, role: "store", include: false }] });
    expect(loc(S)).toMatchObject({ onlinePool: false });
    await post({ intent: "save", locations: [{ id: S, role: "store", include: true }] });
    expect(loc(S)).toMatchObject({ onlinePool: true });
  });

  it("refuses another shop's location and leaves it alone", async () => {
    const r = await post({ intent: "save", locations: [{ id: FOREIGN, role: "store", include: false }] });
    expect(r.json).toEqual({ ok: false, error: "unknown" });
    expect(loc(FOREIGN)).toMatchObject({ role: "other", onlinePool: null });
  });

  it("refuses an inactive location, bad values and leaving nothing counted", async () => {
    expect((await post({ intent: "save", locations: [{ id: "gid://shopify/Location/3", role: "store", include: false }] })).json).toEqual({
      ok: false,
      error: "unknown",
    });
    expect((await post({ intent: "save", locations: [{ id: W, role: "pos", include: true }] })).json).toEqual({ ok: false, error: "invalid" });
    // Every active location counts by default, so leaving out both is what empties the pool.
    expect(
      (await post({ intent: "save", locations: [{ id: W, role: "warehouse", include: false }, { id: S, role: "store", include: false }] })).json,
    ).toEqual({
      ok: false,
      error: "emptyPool",
    });
    expect(loc(W)).toMatchObject({ role: "other", onlinePool: null });
  });

  it("Growth: the include toggle saves (every plan); a role change is refused with the upgrade JSON", async () => {
    m.locations = false;
    const ok = await post({ intent: "save", locations: [{ id: S, role: "other", include: false }] });
    expect(ok).toEqual({ status: 200, json: { ok: true, saved: 1 } });
    expect(loc(S)).toMatchObject({ role: "other", onlinePool: false });
    const r = await post({ intent: "save", locations: [{ id: S, role: "store", include: true }] });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ ok: false, upgrade: { feature: "locations" } });
    expect(loc(S).role).toBe("other");
  });

  it("the loader lists this shop's active locations with Shopify's online flag", async () => {
    const data = (await loader({ request: new Request("https://app.test/app/settings/locations"), params: {}, context: {} } as never)) as LocationsData;
    expect(data.enabled).toBe(true);
    expect(data.locations.map((l) => [l.name, l.online, l.counts, l.pool])).toEqual([
      ["Barcelona", false, true, "follow"], // counts by default (audit 2026-10-17)
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
  it("Pro: each location with its include toggle and role, editable, saved through the save bar", () => {
    const html = render({ locations: rows, enabled: true });
    expect(html).toContain("Main warehouse");
    expect(html).toContain("Barcelona");
    expect(html).toContain("Fulfils online orders in Shopify");
    expect(html).toContain("Doesn&#x27;t fulfil online orders in Shopify");
    for (const s of ["Role", "Counts in supplier orders", "Warehouse", "Store", "Other"]) expect(html).toContain(s);
    expect(html).toMatch(/<s-checkbox[^>]*accessibilityLabel="Does Main warehouse count in supplier orders\?"[^>]*checked=/);
    expect(html).not.toMatch(/<s-checkbox[^>]*Barcelona[^>]*checked=/);
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("See plans");
    expectSettingsAnatomy(html, { cards: ["Locations", "How this is used"], saveBar: "keha-settings-locations" });
    expect(html).toContain("Counted in supplier orders now: Main warehouse.");
    expect(html).not.toContain("Free and Growth plan all your stock as one pool.");
  });

  it("Growth: the include toggle is editable (save bar), the role is locked with the plan name", () => {
    const html = render({ locations: rows, enabled: false });
    expect(html).not.toContain("Free and Growth plan all your stock as one pool.");
    expect(html).toContain("POS stores count too, unless you leave them out.");
    expect(html).toContain("Pro plan"); // lock badge on the Role column
    expect(html).toContain("See plans");
    // Only the role selects are disabled; the checkboxes are not.
    expect(html).not.toMatch(/<s-checkbox[^>]*disabled/);
    expect((html.match(/<s-select[^>]*disabled/g) ?? []).length).toBe(2);
    expectSettingsAnatomy(html, { cards: ["Locations", "How this is used"], saveBar: "keha-settings-locations" });
  });

  it("empty state", () => {
    const html = render({ locations: [], enabled: true });
    expect(html).toContain("No active locations yet");
  });
});
