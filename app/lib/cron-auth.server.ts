/**
 * Bearer-token check for the /cron/* endpoints (INVENTORY_CRON_SECRET).
 * Header only — a token in the query string ends up in proxy and access logs —
 * and compared in constant time.
 */
import { timingSafeEqual } from "node:crypto";

export function cronAuthorized(request: Request, secret = process.env.INVENTORY_CRON_SECRET ?? ""): boolean {
  if (!secret) return false;
  const bearer = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const a = Buffer.from(bearer);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
