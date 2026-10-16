/**
 * Sealed tokens: a small JSON payload encrypted + authenticated with
 * AES-256-GCM, safe to put in a URL. For data that must round-trip through
 * the browser or an email without being exposed or trusted (e.g. the Monday
 * email's unsubscribe link).
 *
 * Key: derived per purpose from SHOPIFY_API_SECRET, so a token for one purpose
 * can never be replayed as another. Tokens expire (`exp`, ms since epoch).
 */
import crypto from "node:crypto";

function keyFor(purpose: string): Buffer {
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  return crypto.createHash("sha256").update(`keha-seal:${purpose}:${secret}`).digest();
}

export function seal(purpose: string, data: Record<string, unknown>, ttlMs: number, now = Date.now()): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(purpose), iv);
  const plain = Buffer.from(JSON.stringify({ ...data, exp: now + ttlMs }), "utf8");
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64url");
}

/** The payload, or null when the token is malformed, tampered with, for another purpose, or expired. */
export function unseal<T extends Record<string, unknown>>(purpose: string, token: string, now = Date.now()): T | null {
  try {
    const buf = Buffer.from(String(token ?? ""), "base64url");
    if (buf.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFor(purpose), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
    const data = JSON.parse(plain) as T & { exp?: number };
    if (typeof data.exp !== "number" || data.exp < now) return null;
    return data;
  } catch {
    return null;
  }
}
