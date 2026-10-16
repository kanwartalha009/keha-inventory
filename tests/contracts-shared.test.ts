/**
 * Shared JSON shapes: settings defaults (zero setup), backfill progress and
 * freshness, money-card change. Pure.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, readSettings } from "../app/lib/settings-shared";
import { backfillPercent, datasetPercent, isBackfillDone, isDataLate, readBackfillState } from "../app/lib/sync/backfill-shared";
import { change } from "../app/lib/money-shared";

describe("settings", () => {
  it("defaults to the spec values with the Monday email on", () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({ leadTimeDays: 14, cycleDays: 14, safetyLevel: "balanced", tooMuchDays: 180, deadDays: 90 });
    expect(DEFAULT_SETTINGS.mondayEmail.enabled).toBe(true);
  });
  it("ignores malformed values", () => {
    const s = readSettings({ leadTimeDays: -3, cycleDays: "x", safetyLevel: "yolo", mondayEmail: { enabled: false, recipients: ["a@b.c", 4] } });
    expect(s.leadTimeDays).toBe(14);
    expect(s.cycleDays).toBe(14);
    expect(s.safetyLevel).toBe("balanced");
    expect(s.mondayEmail).toEqual({ enabled: false, recipients: ["a@b.c"] });
  });
});

describe("backfill progress", () => {
  it("computes per-dataset and overall percent", () => {
    const st = readBackfillState({ datasets: { products: { done: 1, total: 1 }, sales: { done: 13, total: 13 }, stock: { done: 6, total: 13 } } });
    expect(datasetPercent(st.datasets?.stock)).toBe(46);
    expect(datasetPercent(st.datasets?.visits)).toBe(0);
    expect(backfillPercent(st)).toBe(Math.round((100 + 46 + 100 + 0) / 4));
    expect(isBackfillDone(st)).toBe(false);
    expect(readBackfillState("garbage")).toEqual({});
  });
  it("calls data late only after 36 hours, never before the first run", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    expect(isDataLate(null, now)).toBe(false);
    expect(isDataLate("2026-10-15T01:00:00Z", now)).toBe(false);
    expect(isDataLate("2026-10-14T23:59:00Z", now)).toBe(true);
  });
});

describe("money change", () => {
  it("is null when either side is unknown", () => {
    expect(change(100, null)).toBeNull();
    expect(change(null, 5)).toBeNull();
    expect(change(150.5, 100.25)).toBe(50.25);
  });
});
