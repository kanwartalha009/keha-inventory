/**
 * Locations (Phase 3, pure): the online pool override, roles and the "counts for online
 * sales" choice, the Settings → Locations validation, planning locations, the location
 * switcher's scope resolution, and the per-location stock day shape.
 */
import { describe, expect, it } from "vitest";
import { countsForOnline, poolLocationIds } from "../app/lib/compute-shared";
import {
  onlinePoolOf,
  parseLocationParam,
  planningLocations,
  onlinePoolForInclude,
  poolChoiceOf,
  readRole,
  resolveScope,
  sortLocations,
  toSettingsRow,
  validateLocationsForm,
} from "../app/lib/locations-shared";
import { carriedAt, demandSourceFor, keptScopes, locationStockDays, neutralWarehouse } from "../app/lib/compute-locations-shared";

describe("online pool with the merchant's override", () => {
  const L = (id: string, active: boolean, online: boolean, onlinePool?: boolean | null) => ({ id, active, online, onlinePool });

  it("counts every active location when the override is not set (null or absent) — audit 2026-10-17, on every plan", () => {
    // Shopify's fulfillsOnlineOrders no longer decides it: a POS store's stock counts in supplier orders.
    expect(poolLocationIds([L("a", true, true, null), L("b", true, false), L("c", false, true)])).toEqual(["a", "b"]);
  });

  it("the override wins: Yes adds a location, No removes one", () => {
    expect(poolLocationIds([L("a", true, true, false), L("b", true, false, true)])).toEqual(["b"]);
  });

  it("an inactive location never counts, whatever the override", () => {
    expect(countsForOnline({ active: false, online: true, onlinePool: true })).toBe(false);
  });
});

describe("roles and pool choices", () => {
  it("unknown roles read as other", () => {
    expect(readRole("store")).toBe("store");
    expect(readRole("pos")).toBe("other");
    expect(readRole(null)).toBe("other");
  });

  it("maps the override to the three choices and back", () => {
    expect(poolChoiceOf(null)).toBe("follow");
    expect(poolChoiceOf(undefined)).toBe("follow");
    expect(poolChoiceOf(true)).toBe("yes");
    expect(poolChoiceOf(false)).toBe("no");
    expect(onlinePoolOf("follow")).toBeNull();
    expect(onlinePoolOf("yes")).toBe(true);
    expect(onlinePoolOf("no")).toBe(false);
  });

  it("include toggle → override: leave out writes false; include keeps a counting row's override, else writes true (countsForOnline)", () => {
    expect(onlinePoolForInclude(false, { active: true, online: true, onlinePool: null })).toBe(false);
    expect(onlinePoolForInclude(true, { active: true, online: true, onlinePool: null })).toBeNull(); // untouched
    expect(onlinePoolForInclude(true, { active: true, online: false, onlinePool: true })).toBe(true);
    expect(onlinePoolForInclude(true, { active: true, online: true, onlinePool: false })).toBe(true);
    // Every active location counts unless left out (countsForOnline), so an untouched POS store
    // already counts and keeps following the default; only a left-out one is written back to true.
    expect(onlinePoolForInclude(true, { active: true, online: false, onlinePool: null })).toBeNull();
    // An inactive location doesn't count: including it writes true.
    expect(onlinePoolForInclude(true, { active: false, online: true, onlinePool: null })).toBe(true);
  });

  it("settings rows: counts reflects the override; sorted warehouses, stores, others", () => {
    const rows = [
      toSettingsRow({ id: "3", name: "Zeta", active: true, online: false, onlinePool: true, role: "other" }),
      toSettingsRow({ id: "2", name: "Barcelona", active: true, online: false, onlinePool: null, role: "store" }),
      toSettingsRow({ id: "1", name: "Main", active: true, online: true, onlinePool: false, role: "warehouse" }),
    ];
    expect(rows.map((r) => [r.id, r.counts, r.pool])).toEqual([
      ["3", true, "yes"],
      ["2", true, "follow"],
      ["1", false, "no"],
    ]);
    expect(sortLocations(rows).map((r) => r.name)).toEqual(["Main", "Barcelona", "Zeta"]);
  });
});

describe("Settings → Locations validation", () => {
  const active = [
    { id: "W", active: true, online: true, onlinePool: null, role: "other" },
    { id: "S", active: true, online: false, onlinePool: null, role: "other" },
  ];

  it("accepts known locations, roles and include toggles", () => {
    const r = validateLocationsForm(
      [
        { id: "W", role: "warehouse", include: true },
        { id: "S", role: "store", include: false },
      ],
      active,
    );
    expect(r).toEqual({
      ok: true,
      updates: [
        { id: "W", role: "warehouse", onlinePool: null },
        { id: "S", role: "store", onlinePool: false },
      ],
    });
  });

  it("refuses bad values and locations that aren't this shop's active ones", () => {
    expect(validateLocationsForm([{ id: "W", role: "shop", include: true }], active)).toEqual({ ok: false, error: "invalid" });
    expect(validateLocationsForm([{ id: "W", role: "store", include: "yes" }], active)).toEqual({ ok: false, error: "invalid" });
    expect(validateLocationsForm([{ id: "W", role: "store", pool: "follow" }], active)).toEqual({ ok: false, error: "invalid" });
    expect(validateLocationsForm("nope", active)).toEqual({ ok: false, error: "invalid" });
    expect(validateLocationsForm([], active)).toEqual({ ok: false, error: "invalid" });
    expect(validateLocationsForm([{ id: "X", role: "store", include: true }], active)).toEqual({ ok: false, error: "unknown" });
  });

  it("refuses leaving no location counted", () => {
    expect(
      validateLocationsForm(
        [
          { id: "W", role: "warehouse", include: false },
          { id: "S", role: "store", include: false },
        ],
        active,
      ),
    ).toEqual({ ok: false, error: "emptyPool" });
    // The store counts by default now, so leaving the warehouse out alone is fine.
    expect(validateLocationsForm([{ id: "W", role: "warehouse", include: false }], active).ok).toBe(true);
    // …and moving it to the store is fine.
    expect(
      validateLocationsForm(
        [
          { id: "W", role: "warehouse", include: false },
          { id: "S", role: "store", include: true },
        ],
        active,
      ).ok,
    ).toBe(true);
  });

  it("below Pro: the include toggle works, a role change is refused", () => {
    const opts = { rolesAllowed: false };
    expect(validateLocationsForm([{ id: "S", role: "other", include: true }], active, opts)).toEqual({
      ok: true,
      updates: [{ id: "S", role: "other", onlinePool: null }],
    });
    expect(validateLocationsForm([{ id: "S", role: "other", include: false }], active, opts)).toEqual({
      ok: true,
      updates: [{ id: "S", role: "other", onlinePool: false }],
    });
    expect(validateLocationsForm([{ id: "S", role: "store", include: true }], active, opts)).toEqual({ ok: false, error: "rolesLocked" });
  });
});

describe("planning locations and the switcher", () => {
  const rows = [
    { id: "gid://shopify/Location/1", name: "Main", active: true, role: "warehouse" },
    { id: "gid://shopify/Location/2", name: "Barcelona", active: true, role: "store" },
    { id: "gid://shopify/Location/3", name: "Closed", active: false, role: "store" },
    { id: "gid://shopify/Location/4", name: "Office", active: true, role: "other" },
  ];
  const planning = planningLocations(rows);

  it("are the active warehouses and stores", () => {
    expect(planning.map((l) => l.name)).toEqual(["Main", "Barcelona"]);
  });

  it("parses ?location as a gid or a numeric id", () => {
    expect(parseLocationParam("gid://shopify/Location/2")).toBe("gid://shopify/Location/2");
    expect(parseLocationParam("2")).toBe("gid://shopify/Location/2");
    expect(parseLocationParam("gid://shopify/Product/2")).toBeNull();
    expect(parseLocationParam("")).toBeNull();
    expect(parseLocationParam(null)).toBeNull();
  });

  it("Pro honours a planning location; everything else is the online pool", () => {
    expect(resolveScope("gid://shopify/Location/2", true, planning)).toEqual({ scope: "gid://shopify/Location/2", location: planning[1] });
    expect(resolveScope("gid://shopify/Location/2", false, planning)).toEqual({ scope: "online", location: null });
    expect(resolveScope("gid://shopify/Location/4", true, planning)).toEqual({ scope: "online", location: null });
    expect(resolveScope("gid://shopify/Location/3", true, planning)).toEqual({ scope: "online", location: null });
    expect(resolveScope(null, true, planning)).toEqual({ scope: "online", location: null });
  });
});

describe("per-location compute helpers", () => {
  it("one location's stock rows become one-reporter days; out when 0 or reported out", () => {
    const days = locationStockDays([
      { variantId: "a", day: "2026-10-01", endUnits: 4, outOfStock: false },
      { variantId: "a", day: "2026-10-02", endUnits: 0, outOfStock: true },
    ]);
    expect(days).toEqual([
      { variantId: "a", day: "2026-10-01", endUnits: 4, reported: 1, outReported: 0 },
      { variantId: "a", day: "2026-10-02", endUnits: 0, reported: 1, outReported: 1 },
    ]);
  });

  it("carried = stock now or stock history; kept scopes = online + planning ids", () => {
    expect([...carriedAt(["a"], ["b", "a"])].sort()).toEqual(["a", "b"]);
    expect(keptScopes(["L1", "L2"])).toEqual(["online", "L1", "L2"]);
  });
});

describe("review fix: where a location's demand comes from", () => {
  it("warehouses in the online pool use the pool's pace; stores and other warehouses their own", () => {
    expect(demandSourceFor("warehouse", true)).toBe("online_pool");
    expect(demandSourceFor("warehouse", false)).toBe("own");
    expect(demandSourceFor("store", true)).toBe("own");
  });

  it("a warehouse outside the pool with no own sales is neutral, never Dead", () => {
    const r = { status: "dead", daysLeft: Infinity, safetyDays: 0, orderQty: null, orderBy: null, rate: 0 } as unknown as Parameters<typeof neutralWarehouse>[0];
    expect(neutralWarehouse(r, "warehouse", "own", 0)).toMatchObject({ status: "not_enough_data", daysLeft: null, rate: 0 });
    expect(neutralWarehouse(r, "warehouse", "own", 3).status).toBe("dead"); // it sold there: its own numbers stand
    expect(neutralWarehouse(r, "store", "own", 0).status).toBe("dead");
    expect(neutralWarehouse(r, "warehouse", "online_pool", 0).status).toBe("dead");
  });
});
