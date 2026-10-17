/**
 * Monthly partitions of the compact fact tables (DB scale "before 1,000 stores"): names, the
 * months each table keeps, and the DDL. Pure — services/partitions.server runs it (the
 * partition-maintenance job and the writers' "make sure the month exists"); the migration
 * 20261018000000_compact_facts creates the first set with the same names and settings.
 *
 * Retention (spec §8; owner 2026-10-17):
 *  - sales (SalesFact) and store visits (SessionsFact): 25 months (RETENTION_MONTHS) — the
 *    seasonal index and the trend read two years back;
 *  - stock (StockMonth): STOCK_KEEP_DAYS = 430 days. The owner asked for 13 months on the basis
 *    that stock is read ≤ 395 days back, but the out-of-stock pace fallback reads 427 days
 *    (engine/rate-shared PACE_LOOKBACK_DAYS): keeping less would change compute's numbers.
 * A month is dropped whole (DROP of its partition) once its LAST day is older than the cutoff, so
 * up to one month more than the minimum is kept; nothing older than the cutoff is ever read.
 */
import { addDays } from "./sync/shopifyql-shared";
import { RETENTION_MONTHS, retentionCutoff } from "./sync/store-time-shared";
import { PACE_LOOKBACK_DAYS } from "./engine/rate-shared";
import { addMonths, monthOf, monthsBetween } from "./ids-shared";

export const FACT_TABLES = ["SalesFact", "StockMonth", "SessionsFact"] as const;
export type FactTable = (typeof FACT_TABLES)[number];

/** Stock kept: the longest stock read (the pace fallback, 427 days) plus a few days' margin. */
export const STOCK_KEEP_DAYS = PACE_LOOKBACK_DAYS + 3;
/** Months created ahead of the current one (writes never wait for the maintenance job). */
export const MONTHS_AHEAD = 2;

/** Storage parameters per partition (Postgres takes none on the partitioned parent). */
export const PARTITION_SETTINGS: Record<FactTable, string> = {
  // Appended once a night; the last few days are re-read (few rows change in place).
  SalesFact: "fillfactor = 95, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05",
  SessionsFact: "fillfactor = 95, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05",
  // The current month's rows are updated every night (one more day in the array): free space for
  // in-place (HOT) updates and an early vacuum of the old versions.
  StockMonth: "fillfactor = 85, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05",
};

/** The partition column of each parent. */
export const PARTITION_COLUMN: Record<FactTable, "day" | "month"> = { SalesFact: "day", SessionsFact: "day", StockMonth: "month" };

/** `SalesFact_p202610` for October 2026. */
export function partitionName(table: FactTable, month: string): string {
  return `${table}_p${month.slice(0, 4)}${month.slice(5, 7)}`;
}

/** The month (YYYY-MM-01) of a partition name, or null when it is not one of ours. */
export function partitionMonth(table: FactTable, name: string): string | null {
  const m = name.match(new RegExp(`^${table}_p(\\d{4})(\\d{2})$`));
  if (!m) return null;
  const mm = Number(m[2]);
  return mm >= 1 && mm <= 12 ? `${m[1]}-${m[2]}-01` : null;
}

/** The first day still kept for a table: rows with an earlier day may be dropped. */
export function keepFrom(table: FactTable, today: string): string {
  return table === "StockMonth" ? addDays(today, -STOCK_KEEP_DAYS) : retentionCutoff(today, RETENTION_MONTHS);
}

/** The months that must exist today: from the cutoff's month through MONTHS_AHEAD ahead. */
export function wantedMonths(table: FactTable, today: string): string[] {
  return monthsBetween(monthOf(keepFrom(table, today)), addMonths(monthOf(today), MONTHS_AHEAD));
}

/** Months whose every day is older than the cutoff (their partition is dropped). */
export function droppableMonths(table: FactTable, existing: readonly string[], today: string): string[] {
  const cutoff = keepFrom(table, today);
  return existing.filter((m) => addMonths(m, 1) <= cutoff).sort();
}

/** Is a day of `table` still kept? (Writers skip older rows: their month has no partition.) */
export function isKept(table: FactTable, day: string, today: string): boolean {
  return monthOf(day) >= monthOf(keepFrom(table, today));
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** CREATE TABLE IF NOT EXISTS … PARTITION OF … for one month. */
export function createPartitionSql(table: FactTable, month: string): string {
  return `CREATE TABLE IF NOT EXISTS ${ident(partitionName(table, month))} PARTITION OF ${ident(table)} FOR VALUES FROM ('${monthOf(month)}') TO ('${addMonths(month, 1)}') WITH (${PARTITION_SETTINGS[table]})`;
}

/** Detaches a month without blocking readers or writers of the parent (outside a transaction). */
export function detachPartitionSql(table: FactTable, month: string, finalize = false): string {
  return `ALTER TABLE ${ident(table)} DETACH PARTITION ${ident(partitionName(table, month))} ${finalize ? "FINALIZE" : "CONCURRENTLY"}`;
}

/** Drops a (detached) month. */
export function dropPartitionSql(table: FactTable, month: string): string {
  return `DROP TABLE IF EXISTS ${ident(partitionName(table, month))}`;
}

/** Lists the partitions of a parent: rows { name }. $1 = parent name. */
export const SQL_LIST_PARTITIONS = `SELECT c.relname AS "name"
FROM pg_inherits i
JOIN pg_class c ON c.oid = i.inhrelid
JOIN pg_class p ON p.oid = i.inhparent
WHERE p.relname = $1::text AND c.relkind = 'r'
ORDER BY c.relname`;

/** Tables named like a partition of $1 but attached to nothing (a pass detached and stopped before the DROP). */
export const SQL_LIST_DETACHED = `SELECT c.relname AS "name"
FROM pg_class c
WHERE c.relkind = 'r' AND c.relname LIKE $1::text || '\\_p%' AND NOT c.relispartition
ORDER BY c.relname`;
