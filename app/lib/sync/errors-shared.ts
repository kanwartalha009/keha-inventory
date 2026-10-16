/**
 * Sync error → short public code (review M: /health never shows raw error text) and the
 * throttle test the jobs stop on. Pure; matches on error names so it needs no server imports.
 */

export const SYNC_ERROR_CODES = [
  "throttled",
  "too_large",
  "shopifyql_parse",
  "shopifyql_shape",
  "shopifyql_error",
  "admin_error",
  "session_missing",
  "unknown",
] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

const BY_NAME: Record<string, SyncErrorCode> = {
  ShopifyqlThrottledError: "throttled",
  ThrottleBudgetError: "throttled",
  AdminThrottledError: "throttled",
  ShopifyqlTooLargeError: "too_large",
  ShopifyqlParseError: "shopifyql_parse",
  ShopifyqlShapeError: "shopifyql_shape",
  ShopifyqlRequestError: "shopifyql_error",
  AdminQueryError: "admin_error",
  BulkOperationError: "admin_error",
  SessionNotFoundError: "session_missing",
};

export function syncErrorCode(err: unknown): SyncErrorCode {
  if (!(err instanceof Error)) return "unknown";
  const byName = BY_NAME[err.name];
  if (byName) return byName;
  if (/session/i.test(err.name) || /no (offline )?session|session not found/i.test(err.message)) return "session_missing";
  return "unknown";
}

/** Stop-and-resume-next-tick errors (they never count towards a step's retry cap). */
export function isThrottle(err: unknown): boolean {
  return syncErrorCode(err) === "throttled";
}

/** Coerces a stored code to a known one (old rows, typos). */
export function knownCode(code: unknown): SyncErrorCode | null {
  return typeof code === "string" && (SYNC_ERROR_CODES as readonly string[]).includes(code) ? (code as SyncErrorCode) : code == null ? null : "unknown";
}
