/**
 * Every Admin GraphQL document the app sends is valid against the pinned
 * 2026-10 Admin schema (CLAUDE.md rule 5, spec §20 task 0.2).
 *
 * The schema fixture is the 2026-10 introspection from shopify.dev's
 * admin-graphql-direct-proxy, printed as SDL without descriptions and gzipped
 * (tests/fixtures/admin-2026-10.graphql.gz). When the API version moves,
 * replace the fixture in the same commit as the version bump.
 *
 * Documents checked: every `#graphql` template literal under app/ plus the
 * bulk catalog query (sent as a string inside bulkOperationRunQuery). The
 * Partner API query in app-pricing.server.ts is not tagged `#graphql` and is
 * not an Admin document, so it is not checked here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildSchema, parse, validate, type GraphQLSchema } from "graphql";
import { describe, expect, it } from "vitest";
import { CATALOG_BULK_QUERY } from "../app/lib/sync/catalog-shared";

const ROOT = join(__dirname, "..");

function loadSchema(): GraphQLSchema {
  const sdl = gunzipSync(readFileSync(join(ROOT, "tests/fixtures/admin-2026-10.graphql.gz"))).toString("utf8");
  return buildSchema(sdl);
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

type Doc = { where: string; source: string };

const TAGGED = /`#graphql([\s\S]*?)`/g;

function documents(): Doc[] {
  const out: Doc[] = [];
  for (const f of files(join(ROOT, "app"))) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(TAGGED)) {
      const line = src.slice(0, m.index).split("\n").length;
      out.push({ where: `${relative(ROOT, f)}:${line}`, source: m[1] });
    }
  }
  out.push({ where: "app/lib/sync/catalog-shared.ts CATALOG_BULK_QUERY", source: CATALOG_BULK_QUERY });
  return out;
}

const schema = loadSchema();
const DOCS = documents();

describe("Admin GraphQL documents vs the 2026-10 schema", () => {
  it("loads the pinned schema", () => {
    const query = schema.getQueryType()?.getFields() ?? {};
    // Fields that only exist in recent versions: proves the fixture is not an older schema.
    expect(query.shopifyqlQuery).toBeDefined();
    expect(query.inventoryPurchaseOrders).toBeDefined();
  });

  it("finds the app's documents", () => {
    expect(DOCS.length).toBeGreaterThanOrEqual(15);
  });

  it("uses static documents only (no ${} interpolation)", () => {
    expect(DOCS.filter((d) => d.source.includes("${")).map((d) => d.where)).toEqual([]);
  });

  it("validates every document", () => {
    const failures: string[] = [];
    for (const d of DOCS) {
      try {
        const errors = validate(schema, parse(d.source));
        for (const e of errors) failures.push(`${d.where}: ${e.message}`);
      } catch (e) {
        failures.push(`${d.where}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
