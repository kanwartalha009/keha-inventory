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
  poolChoiceLabel,
  poolChoiceOf,
  readRole,
  resolveScope,
  sortLocations,
  toSettingsRow,
  validateLocationsForm,
} from "../app/lib/locations-shared";
import { carriedAt, keptScopes, locationStockDays } from "../app/lib/compute-locations-shared";

describe("online pool with the merchant's override", () => {
  const L = (id: string, active: boolean, online: boolean, onlinePool?: boolean | null) => ({ id, active, online, onlinePool });

  it("follows Shopify when the override is not set (null or absent)", () => {
    expect(poolLocationIds([L("a", true, true, null), L("b", true, false), L("c", false, true)])).toEqual(["a"]);
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

  it("'follow Shopify' says what Shopify says today", () => {
    const t = (s: string) => s;
    expect(poolChoiceLabel("follow", true, t)).toBe("Follow Shopify (Yes)");
    expect(poolChoiceLabel("follow", false, t)).toBe("Follow Shopify (No)");
  });

  it("settings rows: counts reflects the override; sorted warehouses, stores, others", () => {
    const rows = [
      toSettingsRow({ id: "3", name: "Zeta", active: true, online: false, onlinePool: true, role: "other" }),
      toSettingsRow({ id: "2", name: "Barcelona", active: true, online: false, onlinePool: null, role: "store" }),
      toSettingsRow({ id: "1", name: "Main", active: true, online: true, onlinePool: false, role: "warehouse" }),
    ];
    expect(rows.map((r) => [r.id, r.counts, r.pool])).toEqual([
      ["3", true, "yes"],
      ["2", false, "follow"],
      ["1", false, "no"],
    ]);
    expect(sortLocations(rows).map((r) => r.name)).toEqual(["Main", "Barcelona", "Zeta"]);
  });
});

describe("Settings → Locations validation", () => {
  const active = [
    { id: "W", active: true, online: true, onlinePool: null },
    { id: "S", active: true, online: false, onlinePool: null },
  ];

  it("accepts known locations, roles and choices", () => {
    const r = validateLocationsForm(
      [
        { id: "W", role: "warehouse", pool: "follow" },
        { id: "S", role: "store", pool: "no" },
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
    expect(validateLocationsForm([{ id: "W", role: "shop", pool: "follow" }], active)).toEqual({ ok: false, error: "invalid" });
    expect(validateLocationsForm([{ id: "W", role: "store", pool: "maybe" }], active)).toEqual({ ok: false, error: "invalid" });
    expect(validateLocationsForm("nope", active)).toEqual({ ok: false, error: "invalid" });
    expect(validateLocationsForm([], active)).toEqual({ ok: false, error: "invalid" });
    expect(validateLocationsForm([{ id: "X", role: "store", pool: "yes" }], active)).toEqual({ ok: false, error: "unknown" });
  });

  it("refuses leaving no location counting for online sales", () => {
    expect(validateLocationsForm([{ id: "W", role: "warehouse", pool: "no" }], active)).toEqual({ ok: false, error: "emptyPool" });
    // …but moving the pool to the store is fine.
    expect(
      validateLocationsForm(
        [
          { id: "W", role: "warehouse", pool: "no" },
          { id: "S", role: "store", pool: "yes" },
        ],
        active,
      ).ok,
    ).toBe(true);
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
