/**
 * Store-time helpers (task 1.4b): local date / hour / yesterday across DST changes and the
 * extreme offsets (UTC−11, UTC+14, +05:45), the 14-month window, nightly due rule, retention.
 */
import { describe, expect, it } from "vitest";
import {
  historyRange,
  isNightlyDue,
  localDate,
  localHour,
  localParts,
  localYesterday,
  monthsBefore,
  retentionCutoff,
  safeTimeZone,
} from "../../app/lib/sync/store-time-shared";
import { monthChunks } from "../../app/lib/sync/shopifyql-shared";

const at = (iso: string) => new Date(iso);

describe("local date and hour", () => {
  it("Europe/Madrid across the spring-forward and fall-back changes (2026)", () => {
    // 29 Mar 2026: 02:00 CET → 03:00 CEST (01:00Z).
    expect(localParts(at("2026-03-29T00:59:00Z"), "Europe/Madrid")).toEqual({ date: "2026-03-29", hour: 1, minute: 59 });
    expect(localParts(at("2026-03-29T01:00:00Z"), "Europe/Madrid")).toEqual({ date: "2026-03-29", hour: 3, minute: 0 });
    // 25 Oct 2026: 03:00 CEST → 02:00 CET (01:00Z); 02:30 happens twice.
    expect(localHour(at("2026-10-25T00:30:00Z"), "Europe/Madrid")).toBe(2);
    expect(localHour(at("2026-10-25T01:30:00Z"), "Europe/Madrid")).toBe(2);
    expect(localHour(at("2026-10-25T02:00:00Z"), "Europe/Madrid")).toBe(3);
  });

  it("America/New_York across its DST change", () => {
    expect(localParts(at("2026-03-08T06:59:00Z"), "America/New_York")).toEqual({ date: "2026-03-08", hour: 1, minute: 59 });
    expect(localParts(at("2026-03-08T07:00:00Z"), "America/New_York")).toEqual({ date: "2026-03-08", hour: 3, minute: 0 });
  });

  it("UTC−11 and UTC+14 put the same instant on different calendar days", () => {
    const t = at("2026-10-16T10:30:00Z");
    expect(localDate(t, "Pacific/Pago_Pago")).toBe("2026-10-15"); // 23:30 the day before
    expect(localHour(t, "Pacific/Pago_Pago")).toBe(23);
    expect(localDate(t, "Pacific/Kiritimati")).toBe("2026-10-17"); // 00:30 the day after
    expect(localHour(t, "Pacific/Kiritimati")).toBe(0);
    expect(localYesterday(t, "Pacific/Pago_Pago")).toBe("2026-10-14");
    expect(localYesterday(t, "Pacific/Kiritimati")).toBe("2026-10-16");
  });

  it("quarter-hour offsets (Asia/Kathmandu +05:45)", () => {
    expect(localParts(at("2026-10-16T18:20:00Z"), "Asia/Kathmandu")).toEqual({ date: "2026-10-17", hour: 0, minute: 5 });
  });

  it("midnight is hour 0, never 24", () => {
    expect(localHour(at("2026-10-16T00:00:00Z"), "UTC")).toBe(0);
  });

  it("an unknown or empty zone falls back to UTC instead of throwing", () => {
    expect(safeTimeZone("Mars/Olympus")).toBe("UTC");
    expect(safeTimeZone(null)).toBe("UTC");
    expect(safeTimeZone("Europe/Madrid")).toBe("Europe/Madrid");
    expect(localDate(at("2026-10-16T23:30:00Z"), "Mars/Olympus")).toBe("2026-10-16");
  });

  it("yesterday crosses month and year boundaries", () => {
    expect(localYesterday(at("2026-03-01T12:00:00Z"), "UTC")).toBe("2026-02-28");
    expect(localYesterday(at("2028-03-01T12:00:00Z"), "UTC")).toBe("2028-02-29");
    expect(localYesterday(at("2027-01-01T12:00:00Z"), "UTC")).toBe("2026-12-31");
  });
});

describe("history window", () => {
  it("14 calendar months ending yesterday → 14 chunks, newest first", () => {
    const r = historyRange("2026-10-15");
    expect(r).toEqual({ from: "2025-09-01", until: "2026-10-15" });
    const chunks = monthChunks(r.from, r.until);
    expect(chunks).toHaveLength(14);
    expect(chunks[0]).toEqual({ since: "2026-10-01", until: "2026-10-15" });
    expect(chunks[13]).toEqual({ since: "2025-09-01", until: "2025-09-30" });
  });

  it("yesterday on the 1st still gives 14 months", () => {
    const r = historyRange("2026-01-01");
    expect(r.from).toBe("2024-12-01");
    expect(monthChunks(r.from, r.until)).toHaveLength(14);
  });

  it("monthsBefore clamps to the month's length", () => {
    expect(monthsBefore("2026-03-31", 1)).toBe("2026-02-28");
    expect(monthsBefore("2028-03-31", 1)).toBe("2028-02-29");
    expect(monthsBefore("2026-01-15", 13)).toBe("2024-12-15");
  });

  it("retention keeps 25 months", () => {
    expect(retentionCutoff("2026-10-16")).toBe("2024-09-16");
  });
});

describe("nightly due", () => {
  const tz = "Europe/Madrid";
  it("not before 03:00 store-local", () => {
    expect(isNightlyDue(at("2026-10-16T00:59:00Z"), tz, null)).toBe(false); // 02:59 CEST
    expect(isNightlyDue(at("2026-10-16T01:00:00Z"), tz, null)).toBe(true); // 03:00 CEST
  });
  it("once per store-local day", () => {
    const ran = at("2026-10-16T01:05:00Z");
    expect(isNightlyDue(at("2026-10-16T21:00:00Z"), tz, ran)).toBe(false); // 23:00 same local day
    expect(isNightlyDue(at("2026-10-16T22:30:00Z"), tz, ran)).toBe(false); // 00:30 next day, before 03:00
    expect(isNightlyDue(at("2026-10-17T01:00:00Z"), tz, ran)).toBe(true); // 03:00 next day
  });
  it("uses the store's day, not UTC's (UTC+14)", () => {
    // 13:00Z on 16 Oct is 03:00 on 17 Oct in Kiritimati; a run at 10:00Z (00:00 on 17 Oct local) already counts for the 17th.
    expect(isNightlyDue(at("2026-10-16T13:00:00Z"), "Pacific/Kiritimati", at("2026-10-16T10:00:00Z"))).toBe(false);
    expect(isNightlyDue(at("2026-10-16T13:00:00Z"), "Pacific/Kiritimati", at("2026-10-15T13:00:00Z"))).toBe(true);
  });
});
