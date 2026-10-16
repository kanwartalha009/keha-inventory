/**
 * Tiny secret-at-rest helper (AES-256-GCM) for secrets like the Slack
 * webhook URL and supplier emails (spec §14). Key = APP_ENCRYPTION_KEY
 * (32 bytes as exactly 64 hex characters; anything else counts as no key).
 *
 * Without a valid key:
 *  - production (NODE_ENV=production): nothing is stored — encryptSecret
 *    throws and the save paths check `secretsWritable()` first and show a
 *    translated error (review fix 2026-10-17: secrets were stored in the
 *    clear when the key was missing);
 *  - dev / test: values are stored reversibly base64-obfuscated with a
 *    `plain:` marker.
 * Reading always works for legacy `plain:` values.
 *
 * Key rotation is NOT supported: values are not tagged with a key id, so a
 * new key can't read values written with the old one (they read back as ""
 * and must be entered again).
 */
import crypto from "node:crypto";

const HEX_KEY = /^[0-9a-fA-F]{64}$/;

function key(): Buffer | null {
  const hex = (process.env.APP_ENCRYPTION_KEY ?? "").trim();
  return HEX_KEY.test(hex) ? Buffer.from(hex, "hex") : null;
}

const production = () => process.env.NODE_ENV === "production";

/** Can a secret be stored right now? (Production needs a valid APP_ENCRYPTION_KEY.) */
export function secretsWritable(): boolean {
  return key() !== null || !production();
}

export class SecretStorageUnavailableError extends Error {
  constructor() {
    super("APP_ENCRYPTION_KEY is missing or not 64 hex characters: refusing to store a secret unencrypted in production");
    this.name = "SecretStorageUnavailableError";
  }
}

export function encryptSecret(plain: string): string {
  const k = key();
  if (!k) {
    if (production()) throw new SecretStorageUnavailableError();
    return "plain:" + Buffer.from(plain, "utf8").toString("base64");
  }
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
