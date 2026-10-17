/**
 * Home mapping helpers (app/lib/dashboard-shared.ts, task 1.6).
 */
import { describe, expect, it } from "vitest";
import {
  COSTS_DONE_PCT,
  basisLines,
  buildHome,
  costPercent,
  formatAmount,
  formatUpdatedAt,
  homeState,
  readMoneyBasis,
  storeLabel,
  toMoneySnapshot,
  todayIn,
  updatedLabel,
  type Fmt,
  type HomeRaw,
} from "../app/lib/dashboard-shared";
import { homeBasis, homeRaw } from "./home-fixtures";

const id = (s: string) => s;
const fmt: Fmt = {
  money: (v) => formatAmount(v, "EUR", "en"),
  count: (v) => (v == null ? "—" : String(v)),
  percent: (v) => (v == null ? "—" : `${v * 100}%`),
  day: (v) => v ?? "—",
};
const NOW = new Date("2026-10-16T10:00:00Z");

describe("costPercent", () => {
  it("is null with no tracked variants", () => {
    expect(costPercent(0, 0)).toBeNull();
  });
  it("rounds down, so 89.9% does not tick the step", () => {
    expect(costPercent(899, 1000)).toBe(89);
    expect(costPercent(9, 10)).toBe(90);
    expect(costPercent(10, 10)).toBe(100);
  });
  it("uses a 90% threshold", () => {
    expect(COSTS_DONE_PCT).toBe(90);
  });
});

describe("homeState", () => {
  const base = { hasShop: true, backfillDone: false, first90Ready: false, catalogDone: false, trackedVariants: 10, salesDays: 14 };
  it("syncing without a shop row or before the first 90 days", () => {
    expect(homeState({ ...base, hasShop: false })).toBe("syncing");
    expect(homeState(base)).toBe("syncing");
  });
  it("no tracked stock once the catalog is read", () => {
    expect(homeState({ ...base, catalogDone: true, trackedVariants: 0 })).toBe("noTracked");
    // Catalog still loading: zero tracked is not a verdict yet.
    expect(homeState({ ...base, trackedVariants: 0 })).toBe("syncing");
  });
  it("needs 14 days of sales", () => {
    expect(homeState({ ...base, first90Ready: true, salesDays: 13 })).toBe("noSales");
    expect(homeState({ ...base, first90Ready: true, salesDays: 14 })).toBe("ready");
  });
  it("ready when the first 90 days are in even if older months still load", () => {
    expect(homeState({ ...base, first90Ready: true, catalogDone: true })).toBe("ready");
  });
});

describe("buildHome", () => {
  it("treats a missing Shop row as syncing and never crashes", () => {
    const h = buildHome({ shop: null, money: null, trackedVariants: 0, variantsWithCost: 0, salesDays: 0 }, "free", NOW);
    expect(h.state).toBe("syncing");
    expect(h.sync.done).toBe(false);
    expect(h.sync.datasets.map((d) => d.percent)).toEqual([0, 0, 0, 0]);
    expect(h.money).toBeNull();
    expect(h.lastNightlyAt).toBeNull();
    expect(h.dataLate).toBe(false);
    expect(h.setup.costPercent).toBeNull();
  });

  it("maps the ready state, setup steps and refresh cadence", () => {
    const h = buildHome(homeRaw(), "free", NOW);
    expect(h.state).toBe("ready");
    expect(h.storeName).toBe("acme");
    expect(h.refresh).toBe("weekly");
    expect(h.money?.values).toEqual({ atRisk: 1234.5, lost90: null, cashStuck: 800, soldOutTraffic: 0 });
    expect(h.setup).toMatchObject({ leadTimeDone: false, costPercent: 50, costsDone: false, mondayEnabled: true, allDone: false });
    expect(buildHome(homeRaw(), "growth", NOW).refresh).toBe("daily");
  });

  it("ticks every step from real state", () => {
    const raw = homeRaw();
    raw.shop!.settings = { leadTimeConfirmedAt: "2026-10-01T00:00:00Z", mondayEmail: { enabled: true, recipients: [] } };
    raw.variantsWithCost = 95;
    raw.trackedVariants = 100;
    expect(buildHome(raw, "growth", NOW).setup.allDone).toBe(true);
  });

  it("flags late data after 36 hours", () => {
    const raw = homeRaw();
    raw.shop!.lastNightlyAt = new Date("2026-10-14T03:00:00Z");
    expect(buildHome(raw, "growth", NOW).dataLate).toBe(true);
  });

  it("dataset bars from backfill progress", () => {
    const h = buildHome(homeRaw(), "growth", NOW);
    expect(h.sync.datasets).toEqual([
      { key: "products", percent: 100, failed: false },
      { key: "stock", percent: 31, failed: false },
      { key: "sales", percent: 46, failed: false },
      { key: "visits", percent: 23, failed: true },
    ]);
  });
});

describe("money snapshot", () => {
  it("keeps null as null (never 0) and falls back to the shop currency", () => {
    const s = toMoneySnapshot({ day: "2026-10-15", atRisk: null, lost90: 0, cashStuck: null, soldOutTraffic: null, basis: {} }, "GBP");
    expect(s?.values.atRisk).toBeNull();
    expect(s?.values.lost90).toBe(0);
    expect(s?.currency).toBe("GBP");
    expect(s?.basis).toBeNull();
  });
  it("rejects malformed basis JSON", () => {
    expect(readMoneyBasis(null)).toBeNull();
    expect(readMoneyBasis({ atRisk: {} })).toBeNull();
    expect(readMoneyBasis(homeBasis())).not.toBeNull();
  });
});

describe("formatting", () => {
  it("formats amounts in the store currency; null is a dash", () => {
    expect(formatAmount(null, "EUR", "en")).toBe("—");
    expect(formatAmount(1234.5, "EUR", "en")).toBe("€1,235");
    expect(formatAmount(1234.5, "EUR", "de")).toMatch(/1\.235\s€/);
    expect(formatAmount(10, "NOT-A-CODE", "en")).toBe("10 NOT-A-CODE");
  });
  it("shows the sync time in the store's time zone", () => {
    const iso = "2026-10-16T04:10:00Z";
    expect(formatUpdatedAt(iso, "Europe/Madrid", "en")).toContain("06:10");
    expect(formatUpdatedAt(iso, "UTC", "en")).toContain("04:10");
    expect(formatUpdatedAt(null, "UTC", "en")).toBe("—");
  });
  it("today in the store's time zone", () => {
    expect(todayIn("Pacific/Auckland", new Date("2026-10-16T13:00:00Z"))).toBe("2026-10-17");
    expect(todayIn("America/Los_Angeles", new Date("2026-10-16T03:00:00Z"))).toBe("2026-10-15");
  });
  it("store label from the domain", () => {
    expect(storeLabel("acme.myshopify.com")).toBe("acme");
  });
});

describe("basisLines", () => {
  const basis = homeBasis();
  it("ends every card with 'Based on:' and the window", () => {
    for (const key of ["atRisk", "lost90", "cashStuck", "soldOutTraffic"] as const) {
      const lines = basisLines(key, basis, id, fmt);
      expect(lines.at(-1)).toMatch(/^Based on: /);
      expect(lines.at(-1)).toContain("to");
    }
  });
  it("at-risk states the incoming assumption and the retail basis", () => {
    const lines = basisLines("atRisk", basis, id, fmt);
    expect(lines).toContain("Assumes stock on order arrives within 28 days");
    expect(lines).toContain("Valued at retail price");
    expect(lines).toContain("Skipped, no price: 2");
  });
  it("cash stuck labels the retail fallback with its count", () => {
    expect(basisLines("cashStuck", basis, id, fmt)).toContain("Valued at retail price, no cost found: 3");
  });
  it("traffic shows conversion rate and AOV, dashes when unknown", () => {
    const lines = basisLines("soldOutTraffic", basis, id, fmt);
    expect(lines).toContain("Store conversion rate: 2%");
    expect(lines).toContain("Average order value: €60");
    const unknown = homeBasis();
    unknown.soldOutTraffic.conversionRate = null;
    expect(basisLines("soldOutTraffic", unknown, id, fmt)).toContain("Store conversion rate: —");
  });
  it("is empty without a basis", () => {
    expect(basisLines("atRisk", null, id, fmt)).toEqual([]);
  });
});

// Type check: the fixture really is a HomeRaw.
const _raw: HomeRaw = homeRaw();
void _raw;

describe("updatedLabel (Dashboard header)", () => {
  it("today: the time only; another day: date and time; never run: first sync, never a dash", () => {
    // 04:10 UTC = 06:10 in Madrid, the same store day as NOW (12:00 Madrid).
    expect(updatedLabel("2026-10-16T04:10:00Z", "Europe/Madrid", "en", NOW, id)).toBe("Updated 06:10 AM today");
    expect(updatedLabel("2026-10-15T04:10:00Z", "Europe/Madrid", "en", NOW, id)).toBe("Updated Oct 15, 06:10 AM");
    expect(updatedLabel(null, "Europe/Madrid", "en", NOW, id)).toBe("First sync in progress");
    expect(updatedLabel("not a date", null, "en", NOW, id)).toBe("First sync in progress");
  });
});
