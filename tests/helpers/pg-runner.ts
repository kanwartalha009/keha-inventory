/**
 * A SqlRunner (services/db/sql.server) over psql for the Postgres tests: the app's raw SQL runs
 * unchanged. Parameters are bound as literals ($n → '…'; string arrays → '{"…","…"}'), the
 * script goes through stdin (no argument-length limit), row counts come from psql's command tags.
 */
import { execFileSync } from "node:child_process";
import { PG_CONN, real } from "./pg";
import type { SqlRunner, Statement } from "../../app/services/db/sql.server";

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const element = (v: unknown) => (v === null || v === undefined ? "NULL" : `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);

/** `$n` placeholders → SQL literals in one pass (arrays as array literals). */
export function bindAll(sql: string, params: readonly unknown[]): string {
  return sql.replace(/\$(\d+)/g, (m, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) return m;
    const v = params[i];
    if (v === null || v === undefined) return "NULL";
    if (Array.isArray(v)) return quote(`{${v.map(element).join(",")}}`);
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    return quote(String(v));
  });
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let sawQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') (quoted = true), (sawQuote = true);
    else if (c === ",") row.push(sawQuote ? field : field), (field = ""), (sawQuote = false);
    else if (c === "\n") row.push(field), rows.push(row), (row = []), (field = ""), (sawQuote = false);
    else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows;
}

const base = (db: string) => ["-X", "-v", "ON_ERROR_STOP=1", `${PG_CONN} dbname=${real(db)}`];

function run(db: string, args: string[], script: string): string {
  return execFileSync("psql", [...base(db), ...args, "-f", "-"], { input: script, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"] });
}

const tagCount = (line: string) => {
  const m = line.match(/^(INSERT \d+|UPDATE|DELETE|SELECT|MERGE|COPY) ?(\d+)?$/);
  if (!m) return null;
  const parts = line.split(" ");
  return Number(parts[parts.length - 1]);
};

export function psqlRunner(db: string): SqlRunner & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query(sql, params) {
      const text = bindAll(sql, params);
      queries.push(text);
      const out = run(db, ["-q", "--csv"], `${text};\n`);
      const [head, ...body] = parseCsv(out.trimEnd() + "\n").filter((r) => r.length && !(r.length === 1 && r[0] === ""));
      if (!head) return [];
      return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === "" ? null : r[i]])));
    },
    async execute(sql, params) {
      const text = bindAll(sql, params);
      queries.push(text);
      const out = run(db, [], `${text};\n`);
      const counts = out.split("\n").map(tagCount).filter((x): x is number => x !== null);
      return counts[counts.length - 1] ?? 0;
    },
    async transaction(statements: readonly Statement[]) {
      if (!statements.length) return [];
      const text = statements.map((s) => bindAll(s.sql, s.params)).join(";\n");
      queries.push(text);
      const out = run(db, ["-1"], `${text};\n`);
      return out.split("\n").map(tagCount).filter((x): x is number => x !== null);
    },
  };
}
