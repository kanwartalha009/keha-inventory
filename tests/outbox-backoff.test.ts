/**
 * NovaOutbox retry backoff — reliability path for every event Keha Inventory sends to
 * the Nova platform. Wrong backoff = hammering the platform or never retrying.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../app/db.server", () => ({ default: {} }));

import { backoffMs } from "../app/lib/nova.server";

describe("backoffMs", () => {
  it("doubles per attempt: 1m, 2m, 4m, 8m…", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(4)).toBe(480_000);
  });

  it("caps at 6 hours", () => {
    expect(backoffMs(10)).toBe(6 * 60 * 60 * 1000);
    expect(backoffMs(30)).toBe(6 * 60 * 60 * 1000);
  });

  it("treats attempt 0 and negative safely (minimum 1 minute)", () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(-3)).toBe(60_000);
  });
});
