/**
 * Shared by tests/admin-schema.test.ts and tests/admin-scopes.test.ts:
 *  - the pinned 2026-10 Admin schema (tests/fixtures/admin-2026-10.graphql.gz);
 *  - every Admin GraphQL document the app sends: each `#graphql` template literal under app/
 *    plus the bulk catalog query (sent as a string inside bulkOperationRunQuery).
 *
 * The ShopifyQL wrapper (SHOPIFYQL_GRAPHQL) is a `#graphql` literal, so it is collected too.
 * The Partner API query in app-pricing.server.ts is not tagged `#graphql` and is not an
 * Admin document, so it is not collected.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildSchema, type GraphQLSchema } from "graphql";
import { CATALOG_BULK_QUERY } from "../../app/lib/sync/catalog-shared";

export const ROOT = join(__dirname, "..", "..");

export function loadAdminSchema(): GraphQLSchema {
  const sdl = gunzipSync(readFileSync(join(ROOT, "tests/fixtures/admin-2026-10.graphql.gz"))).toString("utf8");
  return buildSchema(sdl);
}

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

export type AdminDoc = { where: string; source: string };

const TAGGED = /`#graphql([\s\S]*?)`/g;

export function adminDocuments(): AdminDoc[] {
  const out: AdminDoc[] = [];
  for (const f of sourceFiles(join(ROOT, "app"))) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(TAGGED)) {
      const line = src.slice(0, m.index).split("\n").length;
      out.push({ where: `${relative(ROOT, f)}:${line}`, source: m[1] });
    }
  }
  out.push({ where: "app/lib/sync/catalog-shared.ts CATALOG_BULK_QUERY", source: CATALOG_BULK_QUERY });
  return out;
}
