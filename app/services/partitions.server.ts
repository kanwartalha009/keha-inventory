/**
 * Monthly partitions of the compact fact tables (lib/partitions-shared):
 *
 *  - ensurePartitions: the writers make sure a month exists before writing into it (cached per
 *    process; CREATE TABLE IF NOT EXISTS, a concurrent create is fine);
 *  - maintainPartitions: the partition-maintenance job (job kind "maintenance", shop "*", queued
 *    by the hourly tick): creates every month from the retention cutoff to MONTHS_AHEAD ahead and
 *    drops the months past retention — DETACH PARTITION … CONCURRENTLY (readers and writers of
 *    the parent never wait) then DROP TABLE. Retention is a few DROPs, never millions of row
 *    deletes and the vacuum behind them.
 */
import { prismaRunner, type SqlRunner } from "./db/sql.server";
import {
  FACT_TABLES,
  SQL_LIST_DETACHED,
  SQL_LIST_PARTITIONS,
  createPartitionSql,
  detachPartitionSql,
  droppableMonths,
  dropPartitionSql,
  partitionMonth,
  partitionName,
  wantedMonths,
  type FactTable,
} from "../lib/partitions-shared";

const known = new Map<FactTable, Set<string>>();

/** Months (YYYY-MM-01) that have a partition, read from the catalog. */
export async function listPartitions(runner: SqlRunner, table: FactTable): Promise<string[]> {
  const rows = await runner.query(SQL_LIST_PARTITIONS, [table]);
  const months = rows.map((r) => partitionMonth(table, String(r.name))).filter((m): m is string => m !== null);
  known.set(table, new Set(months));
  return months.sort();
}

const isDuplicate = (e: unknown) => /already exists|42P07|would overlap/i.test(e instanceof Error ? e.message : String(e));

/** Creates the missing months among `months` (idempotent; another process creating one is fine). */
export async function ensurePartitions(runner: SqlRunner, table: FactTable, months: readonly string[]): Promise<number> {
  let have = known.get(table);
  if (!have || months.some((m) => !have!.has(m))) have = new Set(await listPartitions(runner, table));
  let created = 0;
  for (const m of [...new Set(months)].sort()) {
    if (have.has(m)) continue;
    try {
      await runner.execute(createPartitionSql(table, m), []);
      created++;
    } catch (e) {
      if (!isDuplicate(e)) throw e;
    }
    have.add(m);
  }
  return created;
}

/** Tests: forget the cached partition lists. */
export function forgetPartitions(): void {
  known.clear();
}

export type MaintenanceResult = { created: number; dropped: string[]; ms: number };

/**
 * One maintenance pass for every fact table (idempotent): create the wanted months, drop the
 * months whose every day is past retention. A partition left "detach pending" by an interrupted
 * pass is finalized.
 */
export async function maintainPartitions(today: string, runner: SqlRunner = prismaRunner): Promise<MaintenanceResult> {
  const started = Date.now();
  let created = 0;
  const dropped: string[] = [];
  for (const table of FACT_TABLES) {
    created += await ensurePartitions(runner, table, wantedMonths(table, today));
    const existing = await listPartitions(runner, table);
    for (const month of droppableMonths(table, existing, today)) {
      try {
        await runner.execute(detachPartitionSql(table, month), []);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/pending|FINALIZE/i.test(msg)) await runner.execute(detachPartitionSql(table, month, true), []);
        else if (!/is not a partition|does not exist/i.test(msg)) throw e;
      }
      await runner.execute(dropPartitionSql(table, month), []);
      dropped.push(partitionName(table, month));
    }
    // Detached by an earlier pass that stopped before its DROP.
    const detached = (await runner.query(SQL_LIST_DETACHED, [table])).map((r) => partitionMonth(table, String(r.name))).filter((m): m is string => m !== null);
    for (const month of droppableMonths(table, detached, today)) {
      await runner.execute(dropPartitionSql(table, month), []);
      dropped.push(partitionName(table, month));
    }
    known.delete(table);
  }
  return { created, dropped, ms: Date.now() - started };
}
