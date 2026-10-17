/** App Store review request rules (lib/review-ask-shared, audit 2026-10-17). */
import { describe, expect, it } from "vitest";
import {
  ACCURACY_TARGET_PCT,
  isFinalReviewCode,
  readReviewAsk,
  reviewMoment,
  shouldAskForReview,
} from "../app/lib/review-ask-shared";

const NOW = new Date("2026-10-17T10:00:00Z");

describe("review request", () => {
  it("success moments: a supplier confirmation, accuracy within target, a clearance discount", () => {
    expect(reviewMoment({ supplierConfirmations: 1, lastStoreErrorPct: null, clearances: 0 })).toBe("supplier_confirmed");
    expect(reviewMoment({ supplierConfirmations: 0, lastStoreErrorPct: ACCURACY_TARGET_PCT, clearances: 0 })).toBe("accuracy");
    expect(reviewMoment({ supplierConfirmations: 0, lastStoreErrorPct: ACCURACY_TARGET_PCT + 0.1, clearances: 0 })).toBeNull();
    expect(reviewMoment({ supplierConfirmations: 0, lastStoreErrorPct: null, clearances: 2 })).toBe("clearance");
    expect(reviewMoment({ supplierConfirmations: 0, lastStoreErrorPct: Number.NaN, clearances: 0 })).toBeNull();
  });

  it("asks only after 24 h, after a moment, and never twice", () => {
    const base = { now: NOW, asked: null, moment: "clearance" as const };
    expect(shouldAskForReview({ ...base, installedAt: "2026-10-16T10:00:00Z" })).toBe(true);
    expect(shouldAskForReview({ ...base, installedAt: "2026-10-16T10:00:01Z" })).toBe(false); // 23:59:59
    expect(shouldAskForReview({ ...base, installedAt: null })).toBe(false);
    expect(shouldAskForReview({ ...base, installedAt: "2026-10-01T00:00:00Z", moment: null })).toBe(false);
    expect(shouldAskForReview({ ...base, installedAt: "2026-10-01T00:00:00Z", asked: { askedAt: "2026-10-10T00:00:00Z", code: "success" } })).toBe(false);
  });

  it("reads 'asked at' from the settings JSON defensively", () => {
    expect(readReviewAsk({ reviewAsk: { askedAt: "2026-10-10T00:00:00Z", code: "success" } })).toEqual({ askedAt: "2026-10-10T00:00:00Z", code: "success" });
    expect(readReviewAsk({ reviewAsk: { askedAt: "" } })).toBeNull();
    expect(readReviewAsk(null)).toBeNull();
    expect(readReviewAsk({ reviewAsk: "yes" })).toBeNull();
  });

  it("final answers stop asking; transient ones leave it for the next open", () => {
    for (const c of ["success", "already-reviewed", "annual-limit-reached", "cooldown-period", "merchant-ineligible"]) expect(isFinalReviewCode(c)).toBe(true);
    for (const c of ["mobile-app", "already-open", "open-in-progress", "cancelled", "recently-installed", 42]) expect(isFinalReviewCode(c)).toBe(false);
  });
});
