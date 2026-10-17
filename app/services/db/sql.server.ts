/**
 * Raw SQL for the data layer's set-based statements (DB scale "before 1,000 stores"): the compact
 * fact tables, batched change-only upserts, partition maintenance. One small interface so the
 * same SQL text runs through Prisma in the app and through psql in the Postgres tests
 * (tests/helpers/pg-runner) — the code tested against Postgres is the code that runs.
 *
 * Statements use positional parameters ($1 …), every value a string or an array of strings with
 * an explicit cast in the SQL (lib/facts-sql-shared).
 */
import type { PrismaClient } from "@prisma/client";
import prisma from "../../db.server";

export type Statement = { sql: string; params: unknown[] };

export interface SqlRunner {
  /** Rows of one statement. */
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  /** Rows changed by one statement. */
  execute(sql: string, params: unknown[]): Promise<number>;
  /** Every statement in one transaction (all or nothing); the rows each changed. */
  transaction(statements: readonly Statement[]): Promise<number[]>;
}

/** A runner over a Prisma client: raw queries, a batch $transaction for transactions (no time limit). */
export function prismaRunnerFor(client: PrismaClient): SqlRunner {
  return {
    query: (sql, params) => client.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params),
    execute: (sql, params) => client.$executeRawUnsafe(sql, ...params),
    transaction: async (statements) => {
      if (!statements.length) return [];
      return client.$transaction(statements.map((s) => client.$executeRawUnsafe(s.sql, ...s.params)));
    },
  };
}

/** The app's runner (the shared Prisma client). */
export const prismaRunner: SqlRunner = {
  query: (sql, params) => prismaRunnerFor(prisma).query(sql, params),
  execute: (sql, params) => prismaRunnerFor(prisma).execute(sql, params),
  transaction: (statements) => prismaRunnerFor(prisma).transaction(statements),
};
