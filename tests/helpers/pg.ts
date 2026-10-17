/**
 * Real Postgres for the SQL tests (no Prisma engine in the sandbox): statements run through
 * `psql`, parameters bound as quoted literals. Enabled when KEHA_TEST_PG is a libpq connection
 * string (e.g. "host=/tmp/pg port=5433 user=postgres"), or when the sandbox's local server
 * socket (/tmp/pg, port 5433) exists; otherwise the tests using it are skipped.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SANDBOX = "host=/tmp/pg port=5433 user=postgres";

export const PG_CONN: string | null = process.env.KEHA_TEST_PG || (existsSync("/tmp/pg/.s.PGSQL.5433") ? SANDBOX : null);

function hasPsql(): boolean {
  try {
    execFileSync("psql", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
export const PG_AVAILABLE = !!PG_CONN && hasPsql();

/** `$n` placeholders → SQL literals, in one pass (a literal is never scanned again). */
export function bind(sql: string, params: readonly unknown[]): string {
  return sql.replace(/\$(\d+)/g, (m, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) return m;
    const v = params[i];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

/** Minimal CSV (psql --csv): quoted fields, doubled quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n") row.push(field), rows.push(row), (row = []), (field = "");
    else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows;
}

function toRows(csv: string): Record<string, unknown>[] {
  const [head, ...body] = parseCsv(csv.trimEnd() + "\n").filter((r) => r.length && !(r.length === 1 && r[0] === ""));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === "" ? null : r[i]])));
}

/**
 * KEHA_TEST_DB_SUFFIX (optional) is appended to every test database name, so parallel worktrees
 * sharing one sandbox server never create or drop each other's databases.
 */
const SUFFIX = (process.env.KEHA_TEST_DB_SUFFIX ?? "").replace(/[^a-z0-9_]/gi, "");
export const real = (db: string) => (db === "postgres" ? db : `${db}${SUFFIX}`);

const args = (db: string) => ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", `${PG_CONN} dbname=${real(db)}`];

/** Runs one statement (or a script) in `db`; rows of the last statement that returns rows. */
export function psql(db: string, sql: string): Record<string, unknown>[] {
  return toRows(execFileSync("psql", [...args(db), "-c", sql], { encoding: "utf8" }));
}

/** Async form (several at once = several sessions: real concurrency). */
export function psqlAsync(db: string, sql: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    execFile("psql", [...args(db), "-c", sql], { encoding: "utf8" }, (err, stdout, stderr) => (err ? reject(new Error(stderr || String(err))) : resolve(toRows(stdout))));
  });
}

/** A fresh database with every migration applied (also proves the migrations run on Postgres). */
export function freshDb(name: string): void {
  execFileSync("psql", [...args("postgres"), "-c", `DROP DATABASE IF EXISTS ${real(name)}`, "-c", `CREATE DATABASE ${real(name)}`], { stdio: "ignore" });
  const dir = join(__dirname, "..", "..", "prisma", "migrations");
  for (const f of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    execFileSync("psql", [...args(name), "-f", join(dir, f, "migration.sql")], { stdio: ["ignore", "ignore", "pipe"] });
  }
}

/** Drops a test database. */
export function dropDb(name: string): void {
  execFileSync("psql", [...args("postgres"), "-c", `DROP DATABASE IF EXISTS ${real(name)}`], { stdio: "ignore" });
}

/** A RawQuery (services/jobs/queue.server) over psql. */
export const psqlQuery = (db: string) => async (sql: string, params: unknown[]) => psqlAsync(db, bind(sql, params));

/** The migrations' SQL, concatenated (for reading). */
export function migrationsSql(): string {
  const dir = join(__dirname, "..", "..", "prisma", "migrations");
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readFileSync(join(dir, d.name, "migration.sql"), "utf8"))
    .join("\n");
}
