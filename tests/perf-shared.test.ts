/**
 * Perf 2026-10-18 (event-loop starvation, audit item 1): compute yields to the event loop every
 * YIELD_EVERY variants, and warns once when a large store is computed in a production process
 * that also serves pages (WORKER_MODE=all).
 */
import { describe, expect, it } from "vitest";
import { YIELD_EVERY, yielder } from "../app/lib/concurrency-shared";
import { SHARED_LOOP_WARN_VARIANTS, sharedLoopWarning } from "../app/lib/jobs-shared";

describe("yielder", () => {
  it("lets a macrotask run on every n-th call, not on the others", async () => {
    const breathe = yielder(3);
    let ran = 0;
    const timer = () => setImmediate(() => ran++);
    timer();
    await breathe(); // 1: no macrotask boundary
    await breathe(); // 2
    expect(ran).toBe(0);
    await breathe(); // 3: the pending setImmediate runs first
    expect(ran).toBe(1);
    expect(breathe()).toBeUndefined();
  });

  it("a 2,000-variant loop yields 20 times at the default", async () => {
    const breathe = yielder(YIELD_EVERY);
    let yields = 0;
    for (let i = 0; i < 2000; i++) if (breathe() !== undefined) yields++;
    expect(yields).toBe(20);
  });
});

describe("shared-loop warning", () => {
  it("only in production, only with WORKER_MODE=all, only above the variant threshold", () => {
    expect(sharedLoopWarning("all", "production", SHARED_LOOP_WARN_VARIANTS + 1)).toBe(true);
    expect(sharedLoopWarning("all", "production", SHARED_LOOP_WARN_VARIANTS)).toBe(false);
    expect(sharedLoopWarning("worker", "production", 50_000)).toBe(false);
    expect(sharedLoopWarning("all", "development", 50_000)).toBe(false);
    expect(sharedLoopWarning("all", undefined, 50_000)).toBe(false);
  });
});
