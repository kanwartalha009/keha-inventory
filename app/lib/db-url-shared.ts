/**
 * Database connection pool settings (DB scale #5, audit 2026-10-17). Pure.
 *
 * Prisma's default pool is `num_cpus × 2 + 1` connections per process — on a large Railway
 * instance that is 17+ connections from the web service alone, and a second service (the
 * worker, WORKER_MODE=worker) doubles it. Postgres on Railway allows 100. So the pool is made
 * explicit: `connection_limit` and `pool_timeout` are added to DATABASE_URL unless the URL
 * already sets them (the URL always wins, so Railway variables can tune it without a deploy).
 *
 * Behind PgBouncer (transaction pooling), add `pgbouncer=true` to DATABASE_URL (Prisma then
 * stops using prepared statements) and keep `connection_limit` small; migrations must then run
 * against the direct (non-PgBouncer) URL. Every query this app runs is a single statement or a
 * Prisma batch transaction — the job queue claims with one `UPDATE … FOR UPDATE SKIP LOCKED`
 * statement and the per-shop lock is a lease row, never a session-level advisory lock — so
 * transaction pooling is safe.
 */

/** Connections per process (web or worker). Compute caps its own parallel reads below this. */
export const DB_CONNECTION_LIMIT = 10;
/** Seconds a query waits for a free connection before failing (Prisma default 10). */
export const DB_POOL_TIMEOUT_S = 20;

/** DATABASE_URL with explicit pool settings; undefined / non-Postgres URLs come back unchanged. */
export function withPoolSettings(url: string | undefined): string | undefined {
  if (!url || !/^postgres(ql)?:\/\//i.test(url)) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const q = base.indexOf("?");
  const params = new URLSearchParams(q === -1 ? "" : base.slice(q + 1));
  const add: string[] = [];
  if (!params.has("connection_limit")) add.push(`connection_limit=${DB_CONNECTION_LIMIT}`);
  if (!params.has("pool_timeout")) add.push(`pool_timeout=${DB_POOL_TIMEOUT_S}`);
  if (!add.length) return url;
  const sep = q === -1 ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&";
  return `${base}${sep}${add.join("&")}${hash}`;
}
