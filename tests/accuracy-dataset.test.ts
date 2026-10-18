/**
 * The frozen accuracy dataset (scripts/accuracy/data, docs/ACCURACY.md) stays anonymised and small,
 * and the harness runs on it: random variant ids, no names, SKUs, titles, handles, prices or money,
 * only units per day, sold-out days and the ABC role.
 */
import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DATA_FILE, loadDataset, readDatasetFile } from "../scripts/accuracy/data";
import { runForecast, wape } from "../scripts/accuracy/forecast";

describe("accuracy dataset (scripts/accuracy/data)", () => {
  it("holds only anonymous daily units: random ids, roles, units per day, sold-out days, the store's daily total", () => {
    const f = readDatasetFile();
    expect(Object.keys(f).sort()).toEqual(["days", "note", "start", "store", "variants", "version"]);
    expect(f.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.store).toHaveLength(f.days);
    expect(f.store.every((x) => Number.isInteger(x))).toBe(true);
    const ids = new Set<string>();
    for (const v of f.variants) {
      expect(Object.keys(v).sort()).toEqual(["id", "out", "role", "sold"]);
      expect(v.id).toMatch(/^v[0-9a-f]{8}$/);
      ids.add(v.id);
      expect(["A", "B", "C"]).toContain(v.role);
      expect(v.sold).toHaveLength(f.days);
      expect(v.sold.every((x) => Number.isInteger(x))).toBe(true);
      expect(v.out.every((i) => Number.isInteger(i) && i >= 0 && i < f.days)).toBe(true);
    }
    expect(ids.size).toBe(f.variants.length);
    // No free text anywhere but the note.
    const strings = JSON.stringify({ ...f, note: "" }).match(/"[^"]*"/g)!.map((s) => s.slice(1, -1));
    for (const s of strings) expect(s).toMatch(/^(v[0-9a-f]{8}|[ABC]|\d{4}-\d{2}-\d{2}|id|role|sold|out|version|start|days|note|store|variants|)$/);
    expect(statSync(DATA_FILE).size).toBeLessThan(64 * 1024);
  });

  it("the harness runs the real engine on it (rolling cutoffs, 28 days) and beats naive overall", () => {
    const r = runForecast(loadDataset(), { mode: "rolling", horizons: [28] })[28]!;
    expect(r.cutoffs).toBe(13);
    const all = r.groups.all!;
    expect(all.n).toBeGreaterThan(400);
    expect(wape(all, "keha")).toBeLessThan(wape(all, "naive"));
    expect(() => runForecast(loadDataset(), { mode: "holdout", strict: true, settings: { spikeCapK: 3 } })).toThrow(/strict/);
  });
});
