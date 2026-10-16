/**
 * Flow trigger extension lint (spec §11; Encore's deploy failures, playbook):
 * `shopify app deploy` rejects field keys that are not letters and spaces and
 * descriptions over 140 characters, and every extension handle must be unique.
 * Also: the toml fields equal FLOW_FIELDS (the payload the app sends).
 * A small line parser keeps this dependency-free.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FLOW_FIELDS, FLOW_NEEDS_REORDER, FLOW_WENT_DEAD } from "../app/lib/flow-shared";

const ROOT = join(__dirname, "..");
const EXT = join(ROOT, "extensions");

type Field = { type?: string; key?: string; description?: string };
type Ext = { file: string; name?: string; type?: string; handle?: string; description?: string; fields: Field[] };

/** extensions/*\/*.extension.toml — the same glob the Shopify CLI uses. */
function tomlFiles(): string[] {
  return readdirSync(EXT)
    .map((d) => join(EXT, d))
    .filter((d) => statSync(d).isDirectory())
    .flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".extension.toml")).map((f) => join(d, f)));
}

function parse(file: string): Ext[] {
  const out: Ext[] = [];
  let section: "ext" | "field" | "other" = "other";
  let fields: Field[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[extensions]]") {
      out.push({ file: relative(ROOT, file), fields: (fields = []) });
      section = "ext";
    } else if (line === "[[settings.fields]]") {
      fields.push({});
      section = "field";
    } else if (line.startsWith("[")) section = "other";
    else {
      const m = /^([A-Za-z_]+)\s*=\s*"((?:[^"\\]|\\.)*)"$/.exec(line);
      if (!m) continue;
      const [, k, v] = m;
      if (section === "ext") (out[out.length - 1] as Record<string, unknown>)[k] = v;
      if (section === "field") (fields[fields.length - 1] as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

const ALL = tomlFiles().flatMap(parse);
const FLOW = ALL.filter((e) => e.type === "flow_trigger");

describe("Flow trigger extensions", () => {
  it("both triggers live in extensions/keha-inventory-flow/", () => {
    expect(FLOW.map((e) => [e.handle, e.name, e.file]).sort()).toEqual([
      ["product-needs-reorder", "Product needs reorder", "extensions/keha-inventory-flow/product-needs-reorder.extension.toml"],
      ["product-went-dead", "Product went dead", "extensions/keha-inventory-flow/product-went-dead.extension.toml"],
    ]);
  });

  it("handles are unique across every extension, lowercase with hyphens, ≤ 30 characters", () => {
    const handles = ALL.map((e) => e.handle ?? "");
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) {
      expect(h).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(h.length).toBeLessThanOrEqual(30);
    }
  });

  it("field keys are letters and spaces only; reference fields have no key", () => {
    for (const e of FLOW)
      for (const f of e.fields) {
        if (f.type?.endsWith("_reference")) expect(f.key, `${e.handle} ${f.type}`).toBeUndefined();
        else expect(f.key, `${e.handle} ${f.type}`).toMatch(/^[A-Za-z ]+$/);
      }
  });

  it("every description (trigger and field) is set and ≤ 140 characters", () => {
    for (const e of FLOW) {
      expect(e.description?.length, e.handle).toBeGreaterThan(0);
      expect(e.description!.length, e.handle).toBeLessThanOrEqual(140);
      for (const f of e.fields) {
        expect(f.description?.length, `${e.handle} ${f.key ?? f.type}`).toBeGreaterThan(0);
        expect(f.description!.length, `${e.handle} ${f.key ?? f.type}`).toBeLessThanOrEqual(140);
      }
    }
  });

  it("the toml fields are exactly the payload keys the app sends", () => {
    const keys = (h: string) => {
      const e = FLOW.find((x) => x.handle === h)!;
      return e.fields.map((f) => (f.type === "product_reference" ? "product_id" : f.key)).sort();
    };
    expect(keys(FLOW_NEEDS_REORDER)).toEqual([...FLOW_FIELDS[FLOW_NEEDS_REORDER]].sort());
    expect(keys(FLOW_WENT_DEAD)).toEqual([...FLOW_FIELDS[FLOW_WENT_DEAD]].sort());
  });

  it("uses field types Flow knows", () => {
    for (const e of FLOW)
      for (const f of e.fields) expect(["product_reference", "single_line_text_field", "number_decimal"]).toContain(f.type);
  });
});
