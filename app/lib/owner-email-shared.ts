/**
 * Emails Keha Inventory sends the STORE OWNER (never shoppers). Pure helpers:
 * period keys, so each email goes out at most once per (shop, kind, period)
 * through OwnerEmailLog. The Monday email (spec §11, task 1.8) builds on this.
 */

export const monthKey = (d: Date) => d.toISOString().slice(0, 7);
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** ISO-8601 week, e.g. 2026-W41. */
export function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

export type OwnerEmail = {
  kind: string;
  periodKey: string;
  subject: string;
  text: string;
  /** Optional HTML version, sent alongside `text`. */
  html?: string;
};
