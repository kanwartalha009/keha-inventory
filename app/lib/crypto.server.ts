/**
 * Tiny secret-at-rest helper (AES-256-GCM) for secrets like the Slack
 * webhook URL and supplier emails (spec §14). Key = APP_ENCRYPTION_KEY (32 bytes as 64 hex chars). If the key is
 * unset (dev), values are stored reversibly base64-obfuscated with a `plain:`
 * marker so decrypt still works — set the key in any real environment.
 */
import crypto from "node:crypto";

function key(): Buffer | null {
  const hex = process.env.APP_ENCRYPTION_KEY ?? "";
  if (hex.length === 64) {
    try {
      return Buffer.from(hex, "hex");
    } catch {
      return null;
    }
  }
  return null;
}

export function encryptSecret(plain: string): string {
  const k = key();
  if (!k) return "plain:" + Buffer.from(plain, "utf8").toString("base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "gcm",
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(":");
}

export function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (stored.startsWith("plain:")) {
    return Buffer.from(stored.slice(6), "base64").toString("utf8");
  }
  if (stored.startsWith("gcm:")) {
    const k = key();
    if (!k) return "";
    const [, ivB, tagB, encB] = stored.split(":");
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(ivB, "base64"));
      decipher.setAuthTag(Buffer.from(tagB, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(encB, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      return "";
    }
  }
  return stored;
}
