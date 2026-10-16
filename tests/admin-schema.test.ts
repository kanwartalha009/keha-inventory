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
 * not an Admin document, so it is not checked here. The collector lives in
 * tests/helpers/admin-documents.ts (shared with tests/admin-scopes.test.ts).
 */
import { parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { adminDocuments, loadAdminSchema } from "./helpers/admin-documents";

const schema = loadAdminSchema();
const DOCS = adminDocuments();

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
