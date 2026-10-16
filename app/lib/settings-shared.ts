/**
 * Shop settings — the shape stored in Shop.settings (spec §5.5) with safe
 * defaults, so the first numbers need zero setup (spec §2 principle 1).
 * Pure, client-safe.
 */

export type SafetyLevel = "lean" | "balanced" | "safe";

export type ShopSettings = {
  /** Default supplier lead time in days (spec §5.5: 14). */
  leadTimeDays: number;
  /** Set when the merchant confirms or changes the lead time (setup guide step 1). */
  leadTimeConfirmedAt: string | null;
  /** Order cycle in days (14). */
  cycleDays: number;
  safetyLevel: SafetyLevel;
  /** "Too much stock" threshold in days (180). */
  tooMuchDays: number;
  /** "Dead" threshold in days (90). */
  deadDays: number;
  mondayEmail: {
    /** Spec D5: on by default, to the store owner. */
    enabled: boolean;
    /** Extra / replacement recipients; empty = the store owner email. */
    recipients: string[];
  };
};

export const DEFAULT_SETTINGS: ShopSettings = {
  leadTimeDays: 14,
  leadTimeConfirmedAt: null,
  cycleDays: 14,
  safetyLevel: "balanced",
  tooMuchDays: 180,
  deadDays: 90,
  mondayEmail: { enabled: true, recipients: [] },
};

const int = (v: unknown, min: number, max: number, dflt: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : dflt;

/** Merge stored JSON over the defaults, ignoring anything malformed. */
export function readSettings(raw: unknown): ShopSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const me = (r.mondayEmail && typeof r.mondayEmail === "object" ? r.mondayEmail : {}) as Record<string, unknown>;
  const level = r.safetyLevel;
  return {
    leadTimeDays: int(r.leadTimeDays, 0, 365, DEFAULT_SETTINGS.leadTimeDays),
    leadTimeConfirmedAt: typeof r.leadTimeConfirmedAt === "string" ? r.leadTimeConfirmedAt : null,
    cycleDays: int(r.cycleDays, 1, 365, DEFAULT_SETTINGS.cycleDays),
    safetyLevel: level === "lean" || level === "safe" || level === "balanced" ? level : DEFAULT_SETTINGS.safetyLevel,
    tooMuchDays: int(r.tooMuchDays, 30, 730, DEFAULT_SETTINGS.tooMuchDays),
    deadDays: int(r.deadDays, 30, 730, DEFAULT_SETTINGS.deadDays),
    mondayEmail: {
      enabled: typeof me.enabled === "boolean" ? me.enabled : DEFAULT_SETTINGS.mondayEmail.enabled,
      recipients: Array.isArray(me.recipients) ? me.recipients.filter((x): x is string => typeof x === "string") : [],
    },
  };
}
