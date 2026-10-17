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
import { useFakeFacts } from "./helpers/fake-facts";
import { computeShop } from "../app/services/compute.server";
import { slimInputs } from "../app/lib/metric-store-shared";
import { FX_NOW, FX_SHOP, computeOutput, seedScaleFixture, type FixtureOptions } from "./fixtures/scale-compute-fixture";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
useFakeFacts(db);
const GOLDEN = join(__dirname, "fixtures", "scale-compute-golden.json");
const SCENARIOS: Record<string, FixtureOptions> = { pool: {}, storeLeftOut: { excludeStore: true } };

type Golden = Record<string, unknown>;
/**
 * DB scale "before 1,000 stores": VariantMetric stores slim inputs (lib/metric-store-shared — the
 * fields no reader uses that move with the calendar are not stored). The recorded rows are the
 * full ones; every number and every field that IS stored must still equal them.
 */
const slimmed = (g: Golden): Golden =>
  Object.fromEntries(
    Object.entries(g).map(([name, v]) => {
      const run = v as { result: unknown; output: { metrics: Record<string, unknown>[] } & Record<string, unknown> };
      return [name, { ...run, output: { ...run.output, metrics: run.output.metrics.map((m) => ({ ...m, inputs: slimInputs(m.inputs) })) } }];
    }),
  );
const golden: Golden = process.env.KEHA_WRITE_GOLDEN === "1" ? {} : slimmed(JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden);

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

    for (const chunkSize of [1, 7, 2000]) {
      it(`${name}: the same in chunks of ${chunkSize} variant(s) (DB scale #4)`, async () => {
        if (process.env.KEHA_WRITE_GOLDEN === "1") return;
        const { result, output } = await run(opts, () => computeShop(FX_SHOP, { now: () => FX_NOW, chunkSize }));
        expect(result).toEqual((golden[name] as { result: unknown }).result);
        expect(output).toEqual((golden[name] as { output: unknown }).output);
      }, 60_000);
    }

    it(`${name}: the same with the stored days not built (reads the facts, DB scale #3)`, async () => {
      if (process.env.KEHA_WRITE_GOLDEN === "1") return;
      const { output } = await run(opts, () => computeShop(FX_SHOP, { now: () => FX_NOW, buildDays: false }));
      expect(db.tables.shop[0].factDaysAt ?? null).toBeNull();
      expect(output).toEqual((golden[name] as { output: unknown }).output);
    }, 60_000);

    it(`${name}: the same on a second run, the days kept by the sync (built on the first)`, async () => {
      if (process.env.KEHA_WRITE_GOLDEN === "1") return;
      seedScaleFixture(db, opts);
      await computeShop(FX_SHOP, { now: () => FX_NOW });
      expect(db.tables.shop[0].factDaysAt).toBeInstanceOf(Date);
      expect((db.tables.variantLocationDays ?? []).length).toBeGreaterThan(90);
      db.tables.variantMetric = [];
      db.tables.moneyAtStake = [];
      db.tables.action = [];
      await computeShop(FX_SHOP, { now: () => FX_NOW });
      expect(computeOutput(db)).toEqual((golden[name] as { output: unknown }).output);
    }, 60_000);
  }
});
