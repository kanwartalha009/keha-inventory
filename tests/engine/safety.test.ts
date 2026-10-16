/** Safety level → service level → z (spec §7.4; Kanwar 2026-10-16). */
import { describe, expect, it } from "vitest";
import { ENGINE_DEFAULTS } from "../../app/lib/engine/types-shared";
import {
  SAFETY_LEVELS,
  SAFETY_Z,
  SERVICE_LEVELS,
  inverseNormal,
  serviceLevelFor,
  zForSafetyLevel,
} from "../../app/lib/engine/safety-shared";

describe("inverse normal", () => {
  it("matches known quantiles", () => {
    expect(inverseNormal(0.5)).toBeCloseTo(0, 9);
    expect(inverseNormal(0.95)).toBeCloseTo(1.644854, 5);
    expect(inverseNormal(0.9)).toBeCloseTo(1.281552, 5);
    expect(inverseNormal(0.85)).toBeCloseTo(1.036433, 5);
    expect(inverseNormal(0.98)).toBeCloseTo(2.053749, 5);
    expect(inverseNormal(0.01)).toBeCloseTo(-2.326348, 5);
    expect(() => inverseNormal(1)).toThrow();
    expect(() => inverseNormal(0)).toThrow();
  });
});

describe("safety levels", () => {
  it("every z constant is the inverse normal of its service level (within 0.006)", () => {
    for (const level of SAFETY_LEVELS) {
      for (const role of ["A", "B", "C"] as const) {
        expect(Math.abs(SAFETY_Z[level][role] - inverseNormal(SERVICE_LEVELS[level][role]))).toBeLessThan(0.006);
      }
    }
  });

  it("Balanced is the spec (95/90/85 % → 1.65/1.28/1.04)", () => {
    expect(SERVICE_LEVELS.balanced).toEqual({ A: 0.95, B: 0.9, C: 0.85 });
    expect(zForSafetyLevel("balanced")).toEqual(ENGINE_DEFAULTS.z);
  });

  it("Lean 85/80/75 % and Safe 98/95/90 %", () => {
    expect(SERVICE_LEVELS.lean).toEqual({ A: 0.85, B: 0.8, C: 0.75 });
    expect(SERVICE_LEVELS.safe).toEqual({ A: 0.98, B: 0.95, C: 0.9 });
    expect(zForSafetyLevel("lean")).toEqual({ A: 1.04, B: 0.84, C: 0.67 });
    expect(zForSafetyLevel("safe")).toEqual({ A: 2.05, B: 1.65, C: 1.28 });
  });

  it("an unknown level is Balanced", () => {
    expect(zForSafetyLevel("reckless")).toEqual(ENGINE_DEFAULTS.z);
    expect(serviceLevelFor(undefined, "A")).toBe(0.95);
    expect(serviceLevelFor("safe", "C")).toBe(0.9);
  });
});
