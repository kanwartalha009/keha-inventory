/**
 * Config contracts (playbook §4, §7, mistakes #9, #13, #14, #17):
 *  - the API version is the same everywhere it is pinned;
 *  - toml scopes equal the SCOPES env template, prod and dev tomls agree;
 *  - the handle and name are set, and the name fits the listing limit;
 *  - .env.example lists every env var the code reads, and nothing else.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const tomlValue = (src: string, key: string) => src.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

describe("config contracts", () => {
  const prod = read("shopify.app.toml");
  const dev = read("shopify.app.dev.toml");

  it("pins API 2026-10 in every place", () => {
    expect(tomlValue(prod, "api_version")).toBe("2026-10");
    expect(tomlValue(dev, "api_version")).toBe("2026-10");
    expect(read("app/shopify.server.ts")).not.toMatch(/ApiVersion\.(?!October26)\w+/);
    expect(read("app/shopify.server.ts")).toContain("ApiVersion.October26");
    expect(read(".graphqlrc.ts")).toContain("ApiVersion.October26");
  });

  it("keeps scopes identical in both tomls and the env template", () => {
    const scopes = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean).sort();
    const env = read(".env.example").match(/^SCOPES=(\S*)/m)?.[1];
    expect(scopes(tomlValue(prod, "scopes"))).toEqual(scopes(env));
    expect(scopes(tomlValue(dev, "scopes"))).toEqual(scopes(env));
  });

  it("sets the final name and handle, and never auto-updates production URLs", () => {
    const name = tomlValue(prod, "name") ?? "";
    expect(name).toBe("Keha Inventory Planner");
    expect(name.length).toBeLessThanOrEqual(30);
    expect(tomlValue(prod, "handle")).toBe("keha-inventory");
    expect(prod).toMatch(/^automatically_update_urls_on_dev = false/m);
    expect(read("app/lib/admin-url.server.ts")).toContain('"keha-inventory"');
  });

  it("subscribes the same webhook topics in both tomls, each to an existing route", () => {
    const subs = (src: string) =>
      [...src.matchAll(/\[\[webhooks\.subscriptions\]\]\s*\n(?:compliance_)?topics = \[ "([^"]+)" \]\s*\nuri = "([^"]+)"/g)].map(
        (m) => [m[1], m[2]] as const,
      );
    expect(subs(dev)).toEqual(subs(prod));
    const topics = subs(prod).map(([t]) => t);
    for (const t of ["inventory_levels/update", "products/update", "products/delete", "locations/create", "locations/update", "locations/delete"])
      expect(topics).toContain(t);
    for (const [topic, uri] of subs(prod)) {
      expect(uri).toBe(`/webhooks/${topic}`);
      const route = `app/routes/${uri.slice(1).replace(/\//g, ".")}.tsx`;
      expect(() => statSync(join(root, route)), route).not.toThrow();
    }
  });

  it("documents exactly the env vars the code reads", () => {
    const used = new Set<string>();
    for (const f of files(join(root, "app")))
      for (const m of readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)) used.add(m[1]);
    used.delete("NODE_ENV");
    const documented = new Set([...read(".env.example").matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
    expect([...used].filter((v) => !documented.has(v)).sort()).toEqual([]);
    expect([...documented].filter((v) => !used.has(v)).sort()).toEqual([]);
  });
});
