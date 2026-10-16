/**
 * Personal-data access log (2026-10-11): actor ids from the admin session
 * token, normalised entries, 90-day retention, and that logging never throws.
 */
import { describe, it, expect, vi } from "vitest";

const { rows, fail } = vi.hoisted(() => ({ rows: [] as unknown[], fail: { on: false } }));
vi.mock("../app/db.server", () => ({
  default: {
    personalDataAccessLog: {
      create: async (a: { data: unknown }) => {
        if (fail.on) throw new Error("db down");
        rows.push(a.data);
        return a.data;
      },
      deleteMany: async () => ({ count: 3 }),
    },
  },
}));

import { staffActor, normaliseEntry, retentionCutoff, PII_LOG_RETENTION_DAYS } from "../app/lib/pii-log-shared";
import { logPersonalDataAccess, purgeOldPersonalDataLogs } from "../app/services/pii-log.server";

describe("pii-log-shared", () => {
  it("names the staff member from the session token", () => {
    expect(staffActor({ sub: "88888" })).toBe("staff:88888");
    expect(staffActor({ sub: 42 })).toBe("staff:42");
    expect(staffActor({})).toBe("staff:unknown");
    expect(staffActor(null)).toBe("staff:unknown");
    expect(staffActor({ sub: "1<script>" })).toBe("staff:1script");
  });
  it("keeps counts whole and non-negative", () => {
    const e = normaliseEntry({ shop: "s", actor: "system", action: "view", resource: "orders", records: -2.5 });
    expect(e.records).toBe(0);
    expect(normaliseEntry({ ...e, records: 7.9 }).records).toBe(7);
  });
  it("keeps 90 days", () => {
    expect(PII_LOG_RETENTION_DAYS).toBe(90);
    const now = new Date("2026-10-11T00:00:00Z");
    expect(retentionCutoff(now).toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });
});

describe("pii-log.server", () => {
  it("writes an entry and skips empty ones", async () => {
    await logPersonalDataAccess({ shop: "s.myshopify.com", actor: "staff:1", action: "export", resource: "back_in_stock_contacts", records: 12 });
    await logPersonalDataAccess({ shop: "s.myshopify.com", actor: "staff:1", action: "view", resource: "orders", records: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "export", records: 12 });
    expect(JSON.stringify(rows[0])).not.toMatch(/@/); // no email addresses in the log
  });
  it("never throws when the database fails", async () => {
    fail.on = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      logPersonalDataAccess({ shop: "s", actor: "system", action: "share", resource: "supplier_po", records: 1 }),
    ).resolves.toBeUndefined();
    spy.mockRestore();
    fail.on = false;
  });
  it("purges old rows", async () => {
    expect(await purgeOldPersonalDataLogs(new Date())).toBe(3);
  });
});
