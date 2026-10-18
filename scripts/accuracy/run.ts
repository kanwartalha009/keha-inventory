/**
 * Forecast-accuracy harness on the frozen anonymised dataset (docs/ACCURACY.md).
 *
 *   npm run accuracy                       rolling cutoffs + strict hold-out + random sample
 *   npm run accuracy -- --mode rolling     one cutoff set: rolling | holdout | random
 *   npm run accuracy -- --mode holdout --strict      engine defaults only (overrides refused)
 *   npm run accuracy -- --mode random --samples 600 --seed 7
 *   npm run accuracy -- --settings '{"spikeCapK":3}' --engine '{"noCap":true}'   experiments
 *   npm run accuracy -- --young 365        as if the store had only 12 months of history
 *   npm run accuracy -- --service '{"L":75,"R":60,"late":0.2}'   fill vs target (scripts/accuracy/service.ts)
 *   npm run accuracy -- --json out.json    also write the numbers as JSON
 *
 * Read-only, offline: it reads scripts/accuracy/data/store.json.gz and the engine, nothing else.
 */
import { writeFileSync } from "node:fs";
import { loadDataset } from "./data";
import { formatReport, runForecast, type ForecastOptions, type Mode } from "./forecast";
import { formatService, runService, type ServiceOptions } from "./service";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const json = <T>(s: string | undefined): T | undefined => (s ? (JSON.parse(s) as T) : undefined);

const ds = loadDataset();
const out: Record<string, unknown> = {};
const service = arg("service");
if (service !== undefined) {
  const o = json<ServiceOptions>(service) ?? {};
  const r = runService(ds, o);
  console.log(formatService(r, o));
  out.service = r;
} else {
  const modeArg = arg("mode") as Mode | undefined;
  const base: Omit<ForecastOptions, "mode"> = {
    horizons: arg("h")?.split(",").map(Number),
    settings: json(arg("settings")),
    engine: json(arg("engine")),
    historyDays: arg("young") ? Number(arg("young")) : undefined,
    samples: arg("samples") ? Number(arg("samples")) : undefined,
    seed: arg("seed") ? Number(arg("seed")) : undefined,
  };
  const runs: [string, ForecastOptions][] = modeArg
    ? [[modeArg, { ...base, mode: modeArg, strict: flag("strict") }]]
    : [
        ["rolling", { ...base, mode: "rolling" }],
        ["holdout", { ...base, mode: "holdout", strict: !base.settings && !base.engine && !base.historyDays }],
        ["random", { ...base, mode: "random" }],
      ];
  for (const [name, o] of runs) {
    const r = runForecast(ds, o);
    const title =
      name === "holdout"
        ? `== Hold-out: weekly cutoffs inside the last 120 days${o.strict ? " (strict: engine defaults, nothing tuned)" : ""} ==`
        : name === "random"
          ? `== Random sample: ${o.samples ?? 400} (cutoff, variant) pairs, seed ${o.seed ?? 1} ==`
          : "== Rolling: every 28 days from 2025-10-06 (tune = horizon ends before the hold-out) ==";
    console.log(formatReport(r, title) + "\n");
    out[name] = r;
  }
}
const file = arg("json");
if (file) writeFileSync(file, JSON.stringify(out, null, 1));
