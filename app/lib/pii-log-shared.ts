/**
 * Personal-data access log — pure helpers (2026-10-11). Shopify's protected
 * customer data requirements (Level 2) ask apps to log access to shoppers'
 * personal data. The log records who, what, how many and when — never the
 * personal data itself.
 */

export const PII_LOG_RETENTION_DAYS = 90;

export type PiiAction = "view" | "export" | "import" | "share" | "gdpr_export" | "customer_view";

export type PiiLogEntry = {
  shop: string;
  actor: string;
  action: PiiAction;
  resource: string;
  records: number;
};

/** `staff:<Shopify user id>` from the admin session token (`sub`), else `staff:unknown`. */
export function staffActor(sessionToken?: { sub?: unknown } | null): string {
  const sub = sessionToken?.sub;
  const id = typeof sub === "string" || typeof sub === "number" ? String(sub).trim() : "";
  // Shopify sends the numeric user id; keep only safe id characters.
  const clean = id.replace(/[^A-Za-z0-9:/_.-]/g, "").slice(0, 120);
  return clean ? `staff:${clean}` : "staff:unknown";
}

/** Normalise an entry: whole, non-negative record count; bounded strings. */
export function normaliseEntry(e: PiiLogEntry): PiiLogEntry {
  const n = Number.isFinite(e.records) ? Math.max(0, Math.floor(e.records)) : 0;
  return {
    shop: e.shop.slice(0, 255),
    actor: e.actor.slice(0, 160),
    action: e.action,
    resource: e.resource.slice(0, 80),
    records: n,
  };
}

/** Rows older than this are purged. */
export function retentionCutoff(now: Date, days = PII_LOG_RETENTION_DAYS): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
