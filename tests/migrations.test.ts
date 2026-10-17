/**
 * Schema ↔ migrations contract (spec §8, decision D6: real `prisma migrate`
 * from day one). Every model and column in schema.prisma must be created by
 * the SQL in prisma/migrations, and the migrations must create nothing the
 * schema doesn't know. Fails when the schema changes without a migration.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";

const dir = join(__dirname, "..", "prisma", "migrations");

function migratedColumns(): Set<string> {
  const out = new Set<string>();
  const folders = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const f of folders) {
    const sql = readFileSync(join(dir, f, "migration.sql"), "utf8");
    // A partitioned table ends `\n) PARTITION BY RANGE ("day");` (DB scale: monthly partitions).
    for (const m of sql.matchAll(/CREATE TABLE "(\w+)" \(([\s\S]*?)\n\)(?: PARTITION BY [^;]*)?;/g)) {
      for (const line of m[2].split("\n")) {
        const col = line.trim().match(/^"(\w+)"\s/);
        if (col) out.add(`${m[1]}.${col[1]}`);
      }
    }
    // Prisma writes several columns per statement: ALTER TABLE "T" ADD COLUMN "a" …,\nADD COLUMN "b" …;
    for (const m of sql.matchAll(/ALTER TABLE "(\w+)"([^;]*);/g)) {
      for (const c of m[2].matchAll(/ADD COLUMN\s+"(\w+)"/g)) out.add(`${m[1]}.${c[1]}`);
      for (const c of m[2].matchAll(/DROP COLUMN\s+"(\w+)"/g)) out.delete(`${m[1]}.${c[1]}`);
    }
  }
  return out;
}

function schemaColumns(): Set<string> {
  const out = new Set<string>();
  for (const model of Prisma.dmmf.datamodel.models)
    for (const field of model.fields) if (field.kind !== "object") out.add(`${model.dbName ?? model.name}.${field.dbName ?? field.name}`);
  return out;
}

describe("migrations", () => {
  it("use PostgreSQL", () => {
    expect(readFileSync(join(dir, "migration_lock.toml"), "utf8")).toContain('provider = "postgresql"');
  });

  it("create exactly the schema's tables and columns", () => {
    const migrated = migratedColumns();
    const schema = schemaColumns();
    expect([...schema].filter((c) => !migrated.has(c)).sort(), "in schema, missing from migrations").toEqual([]);
    expect([...migrated].filter((c) => !schema.has(c)).sort(), "in migrations, missing from schema").toEqual([]);
  });

  it("never use db push", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const [name, cmd] of Object.entries(pkg.scripts)) expect(cmd, name).not.toMatch(/db push/);
    expect(readFileSync(join(__dirname, "..", "shopify.web.toml"), "utf8")).not.toMatch(/db push/);
  });
});
