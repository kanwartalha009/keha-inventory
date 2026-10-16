/**
 * Personal-data access log (2026-10-11) — see app/lib/pii-log-shared.ts.
 * Logging must never break the page or webhook that triggered it: failures
 * are reported to the server log and swallowed.
 */
import prisma from "../db.server";
import { normaliseEntry, retentionCutoff, type PiiLogEntry } from "../lib/pii-log-shared";

export { staffActor } from "../lib/pii-log-shared";

const db = prisma;

export async function logPersonalDataAccess(entry: PiiLogEntry): Promise<void> {
  if (!entry.shop || entry.records <= 0) return;
  try {
    await db.personalDataAccessLog.create({ data: normaliseEntry(entry) });
  } catch (e) {
    console.error("[pii-log] write failed", entry.shop, entry.action, entry.resource, e);
  }
}

/** Retention: drop rows older than 90 days. Returns how many were removed. */
export async function purgeOldPersonalDataLogs(now = new Date()): Promise<number> {
  const r = await db.personalDataAccessLog.deleteMany({ where: { createdAt: { lt: retentionCutoff(now) } } });
  return r.count;
}

/** shop/redact: remove the shop's log with the rest of its data. */
export async function deleteShopPersonalDataLogs(shop: string): Promise<number> {
  const r = await db.personalDataAccessLog.deleteMany({ where: { shop } });
  return r.count;
}
