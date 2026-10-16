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
  /** Spec §5.5 Alerts tab / §11. Saved by the Alerts settings tab (task 2.6). */
  alerts: {
    /** Instant alerts (a best seller will run out within its lead time; a busy product sold out). */
    instant: boolean;
    /** Slack incoming-webhook URL, sealed with APP_ENCRYPTION_KEY (lib/seal.server). null = not connected. */
    slackWebhook: string | null;
    /** Send the Monday summary to Slack too (when connected). */
    slackMonday: boolean;
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
  alerts: { instant: true, slackWebhook: null, slackMonday: true },
};

const int = (v: unknown, min: number, max: number, dflt: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : dflt;

/** Merge stored JSON over the defaults, ignoring anything malformed. */
export function readSettings(raw: unknown): ShopSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const me = (r.mondayEmail && typeof r.mondayEmail === "object" ? r.mondayEmail : {}) as Record<string, unknown>;
  const level = r.safetyLevel;
  const al = (r.alerts && typeof r.alerts === "object" ? r.alerts : {}) as Record<string, unknown>;
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
    alerts: {
      instant: typeof al.instant === "boolean" ? al.instant : DEFAULT_SETTINGS.alerts.instant,
      slackWebhook: typeof al.slackWebhook === "string" && al.slackWebhook ? al.slackWebhook : null,
      slackMonday: typeof al.slackMonday === "boolean" ? al.slackMonday : DEFAULT_SETTINGS.alerts.slackMonday,
    },
  };
}

export type SettingsForm = {
  leadTimeDays: string;
  cycleDays: string;
  tooMuchDays: string;
  deadDays: string;
  mondayEnabled: boolean;
  /** Comma or newline separated; empty = the store owner. */
  recipients: string;
};

export type SettingsErrors = Partial<Record<keyof SettingsForm, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Allowed ranges for the number fields (also shown in error messages). */
export const SETTINGS_BOUNDS = {
  leadTimeDays: { min: 0, max: 365 },
  cycleDays: { min: 1, max: 365 },
  tooMuchDays: { min: 30, max: 730 },
  deadDays: { min: 30, max: 730 },
} as const;

/** Error message keys (English text, translated in the UI; {min}/{max} filled from SETTINGS_BOUNDS). */
export const SETTINGS_ERRORS = {
  range: "Enter a whole number from {min} to {max}.",
  emails: "Check the email addresses.",
  tooMany: "Up to 10 addresses.",
} as const;

/**
 * Validate the Settings form against the current settings. Error values are
 * English message keys (translated in the UI). The lead time counts as
 * confirmed on the first save (setup guide step 1).
 */
export function applySettingsForm(
  current: ShopSettings,
  form: SettingsForm,
  now: Date,
): { ok: true; settings: ShopSettings } | { ok: false; errors: SettingsErrors } {
  const errors: SettingsErrors = {};
  const num = (key: keyof typeof SETTINGS_BOUNDS): number => {
    const raw = String(form[key]).trim();
    const n = raw === "" ? NaN : Number(raw);
    const { min, max } = SETTINGS_BOUNDS[key];
    if (!Number.isInteger(n) || n < min || n > max) {
      errors[key] = SETTINGS_ERRORS.range;
      return NaN;
    }
    return n;
  };
  const leadTimeDays = num("leadTimeDays");
  const cycleDays = num("cycleDays");
  const tooMuchDays = num("tooMuchDays");
  const deadDays = num("deadDays");
  const recipients = form.recipients
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (recipients.some((r) => !EMAIL.test(r))) errors.recipients = SETTINGS_ERRORS.emails;
  else if (recipients.length > 10) errors.recipients = SETTINGS_ERRORS.tooMany;
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      ...current,
      leadTimeDays,
      leadTimeConfirmedAt: current.leadTimeConfirmedAt ?? now.toISOString(),
      cycleDays,
      tooMuchDays,
      deadDays,
      mondayEmail: { enabled: form.mondayEnabled, recipients: Array.from(new Set(recipients.map((r) => r.toLowerCase()))) },
    },
  };
}

export function settingsToForm(s: ShopSettings): SettingsForm {
  return {
    leadTimeDays: String(s.leadTimeDays),
    cycleDays: String(s.cycleDays),
    tooMuchDays: String(s.tooMuchDays),
    deadDays: String(s.deadDays),
    mondayEnabled: s.mondayEmail.enabled,
    recipients: s.mondayEmail.recipients.join(", "),
  };
}
