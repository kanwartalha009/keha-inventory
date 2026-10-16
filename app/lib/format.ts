/**
 * Client-safe display formatters.
 *
 * Must NOT import any `*.server` module. Routes use these helpers inside their
 * components (render), and React Router only strips server code from the
 * `loader`/`action`/`headers`/`middleware` exports — anything a component
 * touches gets bundled for the client. Keeping pure formatters here lets both
 * server modules and route components import them without dragging server-only
 * code (Prisma, secrets, etc.) into the client bundle.
 */

/**
 * Format a minor-unit amount (cents) in the SHOP'S currency.
 *
 * Audit 2026-07-12 A6: every money string was hardcoded to en-US/USD, so a GBP or
 * EUR store saw "$" on its own revenue. Currency comes from the shop (Admin API,
 * see `models/shop.server.ts`) and the locale from the admin's language.
 * Defaults keep the old behaviour for any caller that hasn't threaded currency yet.
 */
export function formatMoney(
  minorUnits: number,
  currency = "USD",
  locale = "en",
  opts: { decimals?: boolean } = {},
): string {
  const digits = opts.decimals ? 2 : 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(minorUnits / 100);
  } catch {
    // Unknown currency/locale code → never throw on a dashboard render.
    return `${(minorUnits / 100).toFixed(digits)} ${currency}`;
  }
}

/** Whole-unit money string, e.g. 123456 -> "$1,235" (or "£1,235" for a GBP shop). */
export function formatGmv(cents: number, currency = "USD", locale = "en"): string {
  return formatMoney(cents, currency, locale);
}

/**
 * ONE status→badge-tone mapping for the whole admin (QA 2026-08-31: three
 * pages each had their own, so "Ended" was grey on the dashboard, red on the
 * detail page). Canonical choices: Live/On track = success, Paused/At risk =
 * warning, Scheduled = info, Draft/Ready to ship = attention, Ended = neutral
 * grey (a normal lifecycle end, not an error — mirrors Shopify's "Archived").
 */
export type BadgeTone =
  | "success"
  | "warning"
  | "info"
  | "attention"
  | "critical";

export function statusToTone(status: string): BadgeTone | undefined {
  switch (status) {
    case "Live":
    case "On track":
      return "success";
    case "Paused":
    case "At risk":
      return "warning";
    case "Scheduled":
      return "info";
    case "Draft":
    case "Ready to ship":
      return "attention";
    case "Ended":
    default:
      return undefined;
  }
}

/**
 * ONE localized relative-time helper (replaces two English-only copies).
 * Renders "3 hours ago" / "hace 3 horas" / "vor 3 Stunden" from the active
 * admin locale via Intl.RelativeTimeFormat. Accepts a Date or ISO string so
 * loaders can ship raw timestamps and components format in the user's locale.
 */
export function relativeTime(date: Date | string, locale = "en"): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.round((ms - Date.now()) / 1000); // negative = past
  const abs = Math.abs(seconds);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    for (const [unit, size] of units) {
      if (abs >= size) return rtf.format(Math.trunc(seconds / size), unit);
    }
    return rtf.format(0, "second"); // "now" / "ahora" / "jetzt"
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** "2026-09-30" → "Sep 30, 2026" in the admin locale (UTC, no off-by-one). */
export function prettyDate(iso: string, locale: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  try {
    return new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}
