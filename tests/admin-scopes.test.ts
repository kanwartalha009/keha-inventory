/**
 * Access-scope coverage (invariant I-8, machine-checked).
 *
 * The schema test proves every field EXISTS; this one proves the app is ALLOWED to read it.
 * Production backfill once failed with "Access denied for shopLocales field. Required access:
 * read_locales" because nothing checked scopes. Here:
 *  1. every top-level field (and every `nodes(ids:)` fragment type) the app selects must be in
 *     the hand-kept map tests/fixtures/admin-2026-10.scopes.ts, with its shopify.dev source;
 *  2. every mapped field the app selects (top-level or nested) is granted by the toml scopes;
 *  3. every subscribed webhook topic is mapped and granted;
 *  4. every requested scope is needed by at least one selected field, topic or documented
 *     non-GraphQL use, and a `write_x` scope is needed as write (not only to read).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Kind, TypeInfo, getNamedType, parse, visit, visitWithTypeInfo, type GraphQLSchema } from "graphql";
import { describe, expect, it } from "vitest";
import { FIELD_SCOPES, NON_GRAPHQL_SCOPE_USES, WEBHOOK_TOPIC_SCOPES } from "./fixtures/admin-2026-10.scopes";
import { ROOT, adminDocuments, loadAdminSchema, type AdminDoc } from "./helpers/admin-documents";

const toml = (name: string) => readFileSync(join(ROOT, name), "utf8");

function tomlScopes(src: string): string[] {
  const raw = src.match(/^scopes\s*=\s*"([^"]*)"/m)?.[1] ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function tomlTopics(src: string): string[] {
  return [...src.matchAll(/^(?:compliance_)?topics\s*=\s*\[([^\]]*)\]/gm)].flatMap((m) =>
    [...m[1].matchAll(/"([^"]+)"/g)].map((t) => t[1]),
  );
}

/** `write_x` grants `read_x` (shopify.dev access scopes: write implies read). */
function grants(granted: string[], needed: string): boolean {
  if (granted.includes(needed)) return true;
  return needed.startsWith("read_") && granted.includes(`write_${needed.slice(5)}`);
}

/** Every map key the documents touch: `Parent.field`, plus `QueryRoot.nodes on Type`. */
function usedFields(schema: GraphQLSchema, docs: AdminDoc[]): Map<string, { topLevel: boolean; where: Set<string> }> {
  const roots = new Set([schema.getQueryType()?.name, schema.getMutationType()?.name].filter(Boolean) as string[]);
  const out = new Map<string, { topLevel: boolean; where: Set<string> }>();
  const add = (key: string, topLevel: boolean, where: string) => {
    const hit = out.get(key) ?? { topLevel, where: new Set<string>() };
    hit.where.add(where);
    out.set(key, hit);
  };
  for (const d of docs) {
    const info = new TypeInfo(schema);
    visit(
      parse(d.source),
      visitWithTypeInfo(info, {
        Field(node) {
          const parent = info.getParentType();
          const def = info.getFieldDef();
          if (!parent || !def) return;
          const key = `${parent.name}.${def.name}`;
          const topLevel = roots.has(parent.name);
          add(key, topLevel, d.where);
          // Interface roots (nodes / node): the fragment types decide the scope.
          if (topLevel && (def.name === "nodes" || def.name === "node")) {
            for (const sel of node.selectionSet?.selections ?? []) {
              if (sel.kind === Kind.INLINE_FRAGMENT && sel.typeCondition) add(`${key} on ${sel.typeCondition.name.value}`, true, d.where);
              else if (sel.kind === Kind.FIELD && sel.name.value !== "__typename" && sel.name.value !== "id")
                add(`${key} on ${getNamedType(def.type).name}`, true, d.where);
            }
          }
        },
      }),
    );
  }
  return out;
}

const schema = loadAdminSchema();
const docs = adminDocuments();
const used = usedFields(schema, docs);
const prodScopes = tomlScopes(toml("shopify.app.toml"));
const devScopes = tomlScopes(toml("shopify.app.dev.toml"));
const topics = tomlTopics(toml("shopify.app.toml"));

function missingScopes(granted: string[]): string[] {
  const out: string[] = [];
  for (const [key, hit] of used) {
    const entry = FIELD_SCOPES[key];
    if (!entry || entry.scopes.length === 0) continue;
    if (!entry.scopes.some((s) => grants(granted, s)))
      out.push(`${key} needs one of [${entry.scopes.join(", ")}] (${[...hit.where].join(", ")})`);
  }
  for (const t of topics) {
    const need = WEBHOOK_TOPIC_SCOPES[t];
    if (need?.length && !need.some((s) => grants(granted, s))) out.push(`webhook ${t} needs one of [${need.join(", ")}]`);
  }
  return out;
}

describe("Admin API access scopes vs what the code uses (I-8)", () => {
  it("reads the toml scopes and the app's documents", () => {
    expect(prodScopes.length).toBeGreaterThan(0);
    expect([...devScopes].sort()).toEqual([...prodScopes].sort());
    expect(used.size).toBeGreaterThan(50);
  });

  it("maps every top-level field the app selects", () => {
    const unmapped = [...used]
      .filter(([key, hit]) => hit.topLevel && !FIELD_SCOPES[key])
      .map(([key, hit]) => `add ${key} to the scope map with its required scope from shopify.dev (${[...hit.where].join(", ")})`);
    expect(unmapped).toEqual([]);
  });

  it("every map entry names a field that exists in the 2026-10 schema and its shopify.dev source", () => {
    const bad: string[] = [];
    for (const [key, entry] of Object.entries(FIELD_SCOPES)) {
      const [path, onType] = key.split(" on ");
      const [type, field] = path.split(".");
      const t = schema.getType(type);
      const fields = t && "getFields" in t ? t.getFields() : {};
      if (!fields[field]) bad.push(`${key}: no such field`);
      if (onType && !schema.getType(onType)) bad.push(`${key}: no such type ${onType}`);
      if (!/shopify\.dev/.test(entry.source)) bad.push(`${key}: source must be a shopify.dev page`);
    }
    expect(bad).toEqual([]);
  });

  it("the toml scopes grant every mapped field and webhook topic the app uses", () => {
    expect(missingScopes(prodScopes)).toEqual([]);
  });

  it("fails when a needed scope is missing (read_locales → QueryRoot.shopLocales)", () => {
    const without = prodScopes.filter((s) => s !== "read_locales");
    expect(missingScopes(without).join("\n")).toContain("QueryRoot.shopLocales");
  });

  it("maps every subscribed webhook topic", () => {
    expect(topics.filter((t) => !(t in WEBHOOK_TOPIC_SCOPES)).map((t) => `add webhook topic ${t} to WEBHOOK_TOPIC_SCOPES`)).toEqual([]);
  });

  it("requests only scopes the code uses (write scopes only where something writes)", () => {
    const needed = new Set<string>();
    for (const [key] of used) for (const s of FIELD_SCOPES[key]?.scopes ?? []) needed.add(s);
    for (const t of topics) for (const s of WEBHOOK_TOPIC_SCOPES[t] ?? []) needed.add(s);
    for (const s of Object.keys(NON_GRAPHQL_SCOPE_USES)) needed.add(s);
    const unused = prodScopes.filter((s) => {
      if (s.startsWith("write_")) return !needed.has(s);
      return !needed.has(s) && !needed.has(`write_${s.slice(5)}`);
    });
    expect(unused).toEqual([]);
  });
});
