/**
 * Compute equality, old vs new (DB scale work 2026-10-17, items 3 and 4): the rows computeShop
 * wrote on the scale fixture BEFORE compute was split into variant chunks and before it read
 * stored first / last days are recorded in tests/fixtures/scale-compute-golden.json. Every version
 * since must write exactly the same VariantMetric (online pool and every location), MoneyAtStake
 * and Action rows — whatever the chunk size, and whether the shop's stored days are ready or not.
 *
 * Re-record only for an intended behaviour change: KEHA_WRITE_GOLDEN=1 npx vitest run tests/scale-compute-golden.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ variantMetric: ["shop", "variantId", "scope"], moneyAtStake: ["shop", "day"], action: ["shop", "dedupeKey"] });
  return { default: db.client, __fake: db };
});
vi.mock("../app/services/entitlements.server", () => ({ planFor: async () => "pro" }));

import * as dbModule from "../app/db.server";
import { computeShop } from "../app/services/compute.server";
import { FX_NOW, FX_SHOP, computeOutput, seedScaleFixture, type FixtureOptions } from "./fixtures/scale-compute-fixture";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const GOLDEN = join(__dirname, "fixtures", "scale-compute-golden.json");
const SCENARIOS: Record<string, FixtureOptions> = { pool: {}, storeLeftOut: { excludeStore: true } };

type Golden = Record<string, unknown>;
const golden: Golden = process.env.KEHA_WRITE_GOLDEN === "1" ? {} : (JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

async function run(opts: FixtureOptions, compute: () => Promise<unknown> = () => computeShop(FX_SHOP, { now: () => FX_NOW })) {
  seedScaleFixture(db, opts);
  const result = await compute();
  return { result, output: computeOutput(db) };
}

describe("compute on the scale fixture equals the recorded output", () => {
  for (const [name, opts] of Object.entries(SCENARIOS)) {
    it(`${name}: same metrics, money cards and actions`, async () => {
      const { result, output } = await run(opts);
      if (process.env.KEHA_WRITE_GOLDEN === "1") {
        golden[name] = { result, output };
        writeFileSync(GOLDEN, JSON.stringify(golden) + "\n");
        return;
      }
      const want = golden[name] as { result: unknown; output: { metrics: unknown[] } };
      expect(want.output.metrics.length).toBeGreaterThan(60); // the fixture really computed (pool + locations)
      expect(result).toEqual(want.result);
      expect(output).toEqual(want.output);
    }, 60_000);
  }
});
