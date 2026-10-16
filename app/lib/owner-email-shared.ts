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
  /** Extra headers (List-Unsubscribe). */
  headers?: Record<string, string>;
};

/**
 * What an email's unsubscribe link turns off (app/routes/email.unsubscribe.tsx):
 * "monday" = the Monday email, "alerts" = instant alerts. The kind travels
 * inside the sealed token, so it can't be changed; a token without one (links
 * sent before alerts had their own) means the Monday email.
 */
export const UNSUB_KINDS = ["monday", "alerts"] as const;
export type UnsubKind = (typeof UNSUB_KINDS)[number];

export function unsubKindOf(v: unknown): UnsubKind {
  return v === "alerts" ? "alerts" : "monday";
}

/**
 * RFC 2369 / RFC 8058 headers so mail clients show their own "Unsubscribe"
 * button. One-click POST works: the unsubscribe route's action accepts the
 * token from the URL (a GET only shows the confirm page, so link scanners
 * change nothing). No URL → no headers.
 */
export function listUnsubscribeHeaders(url: string | null | undefined): Record<string, string> | undefined {
  if (!url || !/^https:\/\//.test(url)) return undefined;
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

/**
 * One retry within the period (review fix 2026-10-16): a FAILED log row may be
 * sent again once, at least an hour after the failed attempt. The attempt
 * count lives in `error` ("attempt 1: …"), so the schema stays as it is.
 */
export const OWNER_EMAIL_RETRY_AFTER_MS = 60 * 60 * 1000;
export const OWNER_EMAIL_MAX_ATTEMPTS = 2;

/** Attempts recorded in a log row's `error` (a FAILED row without the prefix counts as 1). */
export function emailAttempts(error: string | null | undefined): number {
  const m = /^attempt (\d+):/.exec(error ?? "");
  return m ? Number(m[1]) : 1;
}

export function failedAttemptError(attempt: number, reason: string): string {
  return `attempt ${attempt}: ${reason}`.slice(0, 300);
}

/** May this period's email be tried again now? Never for a SENT row. */
export function canRetryOwnerEmail(row: { status: string; sentAt: Date; error: string | null }, now: Date): boolean {
  return (
    row.status === "FAILED" &&
    emailAttempts(row.error) < OWNER_EMAIL_MAX_ATTEMPTS &&
    now.getTime() - row.sentAt.getTime() >= OWNER_EMAIL_RETRY_AFTER_MS
  );
}
