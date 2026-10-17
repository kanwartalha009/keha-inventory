/**
 * Shop settings — the shape stored in Shop.settings (spec §5.5) with safe
 * defaults, so the first numbers need zero setup (spec §2 principle 1).
 * Pure, client-safe.
 */

export type SafetyLevel = "lean" | "balanced" | "safe";
export type TrendMode = "off" | "store";

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
  /**
   * Growth assumption in the demand forecast. "off" (default): today's sales pace
   * (× season) is the forecast. "store": also multiply by the store's year-on-year
   * trend (spec §7.4 as written). Audit 2026-10-17 on a real store: "store" was
   * ~3× less accurate (WAPE 90% vs 36%), because today's pace already contains the
   * growth — so it's an opt-in.
   */
  trendMode: TrendMode;
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
    /** Slack incoming-webhook URL, encrypted with APP_ENCRYPTION_KEY (lib/crypto.server, AES-256-GCM). null = not connected. */
    slackWebhook: string | null;
    /** Send the Monday summary to Slack too (when connected). */
    slackMonday: boolean;
    /**
     * Last permanent Slack failure (4xx such as invalid_token, channel_not_found,
     * no_service). The webhook is kept; the Alerts tab shows the error. Cleared on
     * the next successful send, a new webhook or a disconnect.
     */
    slackError: { code: string; at: string } | null;
  };
};

export const DEFAULT_SETTINGS: ShopSettings = {
  leadTimeDays: 14,
  leadTimeConfirmedAt: null,
  cycleDays: 14,
  safetyLevel: "balanced",
  tooMuchDays: 180,
  deadDays: 90,
  trendMode: "off",
  mondayEmail: { enabled: true, recipients: [] },
  alerts: { instant: true, slackWebhook: null, slackMonday: true, slackError: null },
};

const int = (v: unknown, min: number, max: number, dflt: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : dflt;

/** Merge stored JSON over the defaults, ignoring anything malformed. */
export function readSettings(raw: unknown): ShopSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const me = (r.mondayEmail && typeof r.mondayEmail === "object" ? r.mondayEmail : {}) as Record<string, unknown>;
  const level = r.safetyLevel;
  const al = (r.alerts && typeof r.alerts === "object" ? r.alerts : {}) as Record<string, unknown>;
  const se = (al.slackError && typeof al.slackError === "object" ? al.slackError : null) as Record<string, unknown> | null;
  return {
    leadTimeDays: int(r.leadTimeDays, 0, 365, DEFAULT_SETTINGS.leadTimeDays),
    leadTimeConfirmedAt: typeof r.leadTimeConfirmedAt === "string" ? r.leadTimeConfirmedAt : null,
    cycleDays: int(r.cycleDays, 1, 365, DEFAULT_SETTINGS.cycleDays),
    safetyLevel: level === "lean" || level === "safe" || level === "balanced" ? level : DEFAULT_SETTINGS.safetyLevel,
    tooMuchDays: int(r.tooMuchDays, 30, 730, DEFAULT_SETTINGS.tooMuchDays),
    deadDays: int(r.deadDays, 30, 730, DEFAULT_SETTINGS.deadDays),
    trendMode: r.trendMode === "store" ? "store" : "off",
    mondayEmail: {
      enabled: typeof me.enabled === "boolean" ? me.enabled : DEFAULT_SETTINGS.mondayEmail.enabled,
      recipients: Array.isArray(me.recipients) ? me.recipients.filter((x): x is string => typeof x === "string") : [],
    },
    alerts: {
      instant: typeof al.instant === "boolean" ? al.instant : DEFAULT_SETTINGS.alerts.instant,
      slackWebhook: typeof al.slackWebhook === "string" && al.slackWebhook ? al.slackWebhook : null,
      slackMonday: typeof al.slackMonday === "boolean" ? al.slackMonday : DEFAULT_SETTINGS.alerts.slackMonday,
      slackError:
        se && typeof se.code === "string" && se.code && typeof se.at === "string" ? { code: se.code, at: se.at } : null,
    },
  };
}

/** The Defaults tab (/app/settings). The Monday email moved to the Alerts tab (task 2.6). */
export type SettingsForm = {
  leadTimeDays: string;
  cycleDays: string;
  tooMuchDays: string;
  deadDays: string;
  /** "lean" | "balanced" | "safe"; anything else keeps the current level. */
  safetyLevel: string;
  /** Growth assumption: "off" | "store"; anything else keeps the current mode. */
  trendMode: string;
};

export type SettingsErrors = Partial<Record<keyof SettingsForm, string>>;

const isLevel = (v: unknown): v is SafetyLevel => v === "lean" || v === "balanced" || v === "safe";

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
  slackUrl: "Paste a Slack incoming webhook link. It starts with https://hooks.slack.com/services/",
  /** No valid APP_ENCRYPTION_KEY in production: secrets are never stored unencrypted (lib/crypto.server). */
  secretStorage: "Secure storage isn't set up for this app yet, so this can't be saved. Contact Keha support.",
} as const;

/**
 * Validate the Defaults form against the current settings. Error values are
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
      safetyLevel: isLevel(form.safetyLevel) ? form.safetyLevel : current.safetyLevel,
      trendMode: form.trendMode === "off" || form.trendMode === "store" ? form.trendMode : current.trendMode,
    },
  };
}

export function settingsToForm(s: ShopSettings): SettingsForm {
  return {
    leadTimeDays: String(s.leadTimeDays),
    cycleDays: String(s.cycleDays),
    tooMuchDays: String(s.tooMuchDays),
    deadDays: String(s.deadDays),
    safetyLevel: s.safetyLevel,
    trendMode: s.trendMode,
  };
}

// ---------------------------------------------------------------- Alerts tab

/** The Alerts tab (/app/settings/alerts, spec §5.5): Monday email, instant alerts, Slack. */
export type AlertsForm = {
  mondayEnabled: boolean;
  /** Comma or newline separated; empty = the store owner. */
  recipients: string;
  instant: boolean;
  slackMonday: boolean;
  /** A new Slack incoming-webhook link to connect; empty = keep the current one. Never sent back to the page. */
  slackWebhook: string;
};

export type AlertsErrors = Partial<Record<keyof AlertsForm, string>>;

/** Parse the recipients field: split, trim, lowercase, de-duplicate. */
export function parseRecipients(raw: string): { ok: true; recipients: string[] } | { ok: false; error: string } {
  const list = String(raw ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.some((r) => !EMAIL.test(r))) return { ok: false, error: SETTINGS_ERRORS.emails };
  const unique = Array.from(new Set(list.map((r) => r.toLowerCase())));
  if (unique.length > 10) return { ok: false, error: SETTINGS_ERRORS.tooMany };
  return { ok: true, recipients: unique };
}

/**
 * Validate the Alerts form. `isWebhook` checks a pasted Slack link (lib/slack-shared).
 * The returned `webhook` is the validated new link (or null to keep the stored one);
 * the caller encrypts it before storing (lib/crypto.server), so this stays pure.
 */
export function applyAlertsForm(
  current: ShopSettings,
  form: AlertsForm,
  isWebhook: (raw: string) => string | null,
): { ok: true; settings: ShopSettings; webhook: string | null } | { ok: false; errors: AlertsErrors } {
  const errors: AlertsErrors = {};
  const parsed = parseRecipients(form.recipients);
  if (!parsed.ok) errors.recipients = parsed.error;
  const raw = String(form.slackWebhook ?? "").trim();
  const webhook = raw ? isWebhook(raw) : null;
  if (raw && !webhook) errors.slackWebhook = SETTINGS_ERRORS.slackUrl;
  if (!parsed.ok || Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    webhook,
    settings: {
      ...current,
      mondayEmail: { enabled: form.mondayEnabled === true, recipients: parsed.recipients },
      alerts: { ...current.alerts, instant: form.instant === true, slackMonday: form.slackMonday === true },
    },
  };
}

export function alertsToForm(s: ShopSettings): AlertsForm {
  return {
    mondayEnabled: s.mondayEmail.enabled,
    recipients: s.mondayEmail.recipients.join(", "),
    instant: s.alerts.instant,
    slackMonday: s.alerts.slackMonday,
    slackWebhook: "",
  };
}
