/**
 * The Monday email (spec §11, §4 J2, decision D5). Pure: when it is due in the
 * store's time zone, and what it says. The sending (once per store week,
 * unsubscribe, recipients) is app/services/monday.server.ts.
 *
 * Task 2.6 (full email): subject "<money> at stake this week — N things to do",
 * the 4 numbers with week-on-week change, the top 5 actions (each with a button
 * into the app), on Free the Fix rows only as a count, the accuracy line, and
 * the unsubscribe link. `mondaySummary` builds the content once; the email
 * (composeMondayEmail) and Slack (lib/slack-shared buildSlackMonday) render it.
 */
import { fill, translate, type Locale } from "./i18n";
import { change, MONEY_CARDS, type MoneyCardKey } from "./money-shared";
import { ACTION_REASONS, isVisible, rankActions, tabOf, type ActionKind, type ActionState, type ReasonParams } from "./actions-shared";
import { hasFeature, visibleRows, type PlanCode } from "./plan-shared";
import { reasonSentence } from "./action-facts-shared";

// ---------------------------------------------------------------- send time

/** Local hour (store time) from which the email is due on Monday. */
export const MONDAY_SEND_HOUR = 8;

/** Sealed-token purpose of the unsubscribe link (app/routes/email.unsubscribe.tsx). */
export const MONDAY_UNSUB_PURPOSE = "monday-unsub";

/** How many actions the email lists. */
export const MONDAY_TOP_ACTIONS = 5;

function localParts(now: Date, timeZone: string) {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt(timeZone || "UTC");
  } catch {
    parts = fmt("UTC"); // unknown time zone → UTC, never throw in the scheduler
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    hour: Number(get("hour")) % 24,
    localDate: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/**
 * Is the Monday email due at `now` for a store in `timeZone` (IANA)? Due from
 * 08:00 store time for the rest of the store's Monday. `localDate` is the
 * store-local date (YYYY-MM-DD) — its ISO week is the send-once period.
 * Intl does the time-zone maths, so daylight-saving changes are handled.
 */
export function isMondaySendTime(now: Date, timeZone: string): { due: boolean; localDate: string } {
  const p = localParts(now, timeZone);
  return { due: p.weekday === "Mon" && p.hour >= MONDAY_SEND_HOUR, localDate: p.localDate };
}

// ---------------------------------------------------------------- numbers

function numberFormat(locales: string[], opts: Intl.NumberFormatOptions): Intl.NumberFormat | null {
  for (const l of locales) {
    try {
      return new Intl.NumberFormat(l, opts);
    } catch {
      /* unknown locale or currency — try the next */
    }
  }
  return null;
}

/** Whole-unit money in the store currency, e.g. "€1,234" (en) or "1234 €" (es). */
export function formatMoneyWhole(amount: number, currency: string, locale: string, fallbackLocale = "en"): string {
  const nf = numberFormat([locale, fallbackLocale, "en"], {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return nf ? nf.format(amount) : `${Math.round(amount)} ${currency}`;
}

/** Signed whole-unit money for a change, e.g. "+€120" / "-€50". */
export function formatMoneyChange(amount: number, currency: string, locale: string, fallbackLocale = "en"): string {
  const nf = numberFormat([locale, fallbackLocale, "en"], {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    signDisplay: "exceptZero",
  });
  if (nf) return nf.format(amount);
  const r = Math.round(amount);
  return `${r > 0 ? "+" : ""}${r} ${currency}`;
}

/**
 * The headline money: forward-looking only — Sales at risk (next 28 days) +
 * Cash stuck. "Lost to sell-outs" and "sold-out page visits" cover past
 * periods and overlap each other, so they stay in the body but are not
 * added up. Null when neither is known.
 */
export const HEADLINE_CARDS = ["atRisk", "cashStuck"] as const satisfies readonly MoneyCardKey[];

export function headlineAtStake(values: Record<MoneyCardKey, number | null>): number | null {
  const known = HEADLINE_CARDS.map((k) => values[k]).filter((v): v is number => v != null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

// ---------------------------------------------------------------- composer

export type MondayValues = Record<MoneyCardKey, number | null>;

export type MondayAction = { title: string; reason: string; amount: number | null; link: string };

export type MondayEmailInput = {
  /** The store's language (Shop.locale → toSupportedLocale). */
  locale: Locale;
  /** Raw store locale for number formatting (e.g. "pt-BR"); defaults to `locale`. */
  numberLocale?: string;
  currency: string;
  storeName: string;
  now: MondayValues;
  /** The row closest to 7 days earlier; null when there is none. */
  before: MondayValues | null;
  /** "monthly" on Free (adds the "Refreshed monthly on Free" line). */
  refresh: "monthly" | "daily";
  links: { app: string; unsubscribe: string };
  /** The ranked action list (top 5 shown). */
  actions?: MondayAction[];
  /** Free: Fix rows in the top 5, shown only as a count with a link to the plans (spec §3 fixDetails). */
  lockedFixes?: { count: number; link: string } | null;
  /** Last month's absolute % error on the store total (AccuracyMonth.storeErrorPct); null/undefined = no line. */
  accuracyPct?: number | null;
};

export type MondayEmailContent = { subject: string; text: string; html: string };

/** Everything the email and the Slack message show, worded and translated. */
export type MondaySummary = {
  locale: Locale;
  subject: string;
  heading: string;
  atStake: string;
  rows: { label: string; value: string; changeText: string | null }[];
  refreshNote: string | null;
  topHeading: string;
  actions: { title: string; reason: string; amountText: string | null; link: string }[];
  lockedFixes: { text: string; link: string; label: string } | null;
  accuracy: string | null;
  openLabel: string;
  openAction: string;
  footer: string;
  unsubscribe: string;
  links: { app: string; unsubscribe: string };
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const DASH = "—";

export function mondaySummary(input: MondayEmailInput): MondaySummary {
  const { locale, currency, storeName } = input;
  const tr = (key: string) => translate(locale, key);
  const numLocale = input.numberLocale || locale;
  const money = (v: number) => formatMoneyWhole(v, currency, numLocale, locale);

  const labels: Record<MoneyCardKey, string> = {
    atRisk: tr("Sales at risk (next 28 days)"),
    lost90: tr("Sales lost to sell-outs (last 90 days)"),
    cashStuck: tr("Cash stuck"),
    soldOutTraffic: tr("Sold-out page visits (last 30 days)"),
  };

  const rows = MONEY_CARDS.map((k) => {
    const now = input.now[k];
    const delta = input.before ? change(now, input.before[k]) : null;
    const rounded = delta == null ? null : Math.round(delta);
    const changeText =
      rounded == null
        ? null
        : rounded === 0
          ? tr("Same as last week")
          : fill(tr("{change} vs last week"), { change: formatMoneyChange(rounded, currency, numLocale, locale) });
    return { label: labels[k], value: now == null ? DASH : money(now), changeText };
  });

  const total = headlineAtStake(input.now);
  const atStake = total == null ? tr("Your stock this week") : fill(tr("{money} at stake this week"), { money: money(total) });

  const actions = (input.actions ?? []).slice(0, MONDAY_TOP_ACTIONS).map((a) => ({
    title: a.title,
    reason: a.reason,
    amountText: a.amount != null ? money(a.amount) : null,
    link: a.link,
  }));
  const locked = input.lockedFixes && input.lockedFixes.count > 0 ? input.lockedFixes : null;
  const count = actions.length + (locked?.count ?? 0);
  const todo = count === 0 ? null : count === 1 ? tr("1 thing to do") : fill(tr("{count} things to do"), { count });
  const subject = todo ? `${atStake} — ${todo}` : atStake;

  const pct = input.accuracyPct;
  const accuracy =
    pct != null && Number.isFinite(pct) && pct >= 0
      ? fill(tr("Last month we were within {pct}% on your store total."), { pct: Math.round(pct) })
      : null;

  return {
    locale,
    subject,
    heading: fill(tr("Your Monday summary for {store}"), { store: storeName }),
    atStake,
    rows,
    refreshNote: input.refresh === "monthly" ? tr("Refreshed monthly on Free") : null,
    topHeading: tr("Top things to do this week"),
    actions,
    lockedFixes: locked
      ? {
          text: fill(tr("Products holding sales back: {count}. See which ones on the Growth plan."), { count: locked.count }),
          link: locked.link,
          label: tr("See plans"),
        }
      : null,
    accuracy,
    openLabel: tr("Open Keha"),
    openAction: tr("Open"),
    footer: fill(tr("You get this email every Monday because Keha Inventory Intelligence is installed on {store}."), {
      store: storeName,
    }),
    unsubscribe: tr("Unsubscribe"),
    links: input.links,
  };
}

export function composeMondayEmail(input: MondayEmailInput): MondayEmailContent {
  const m = mondaySummary(input);
  const { subject, heading, atStake, rows, refreshNote, actions, accuracy, openLabel, footer, unsubscribe, topHeading, openAction } = m;
  const locale = m.locale;
  // ---- plain text ----
  const lines: string[] = [heading, "", atStake, ""];
  for (const r of rows) lines.push(`${r.label}: ${r.value}${r.changeText ? ` (${r.changeText})` : ""}`);
  if (refreshNote) lines.push("", refreshNote);
  if (actions.length || m.lockedFixes) {
    lines.push("", topHeading);
    actions.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.title}${a.amountText ? ` (${a.amountText})` : ""}`);
      if (a.reason) lines.push(`   ${a.reason}`);
      lines.push(`   ${openAction}: ${a.link}`);
    });
    if (m.lockedFixes) lines.push(`${actions.length + 1}. ${m.lockedFixes.text}`, `   ${m.lockedFixes.label}: ${m.lockedFixes.link}`);
  }
  if (accuracy) lines.push("", accuracy);
  lines.push("", `${openLabel}: ${input.links.app}`, "", "—", footer, `${unsubscribe}: ${input.links.unsubscribe}`);
  const text = lines.join("\n");

  // ---- HTML (inline styles only; email clients drop <style>) ----
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  const muted = "color:#616161;font-size:13px;";
  const button = (href: string, label: string, small = false) =>
    `<a href="${esc(href)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:8px;${
      small ? "padding:6px 12px;font-size:13px;" : "padding:10px 18px;font-size:14px;font-weight:600;"
    }">${esc(label)}</a>`;

  const cardRows = rows
    .map(
      (r) =>
        `<tr><td style="padding:10px 0;border-bottom:1px solid #ebebeb;">${esc(r.label)}${
          r.changeText ? `<br><span style="${muted}">${esc(r.changeText)}</span>` : ""
        }</td><td style="padding:10px 0;border-bottom:1px solid #ebebeb;text-align:right;font-weight:600;white-space:nowrap;">${esc(
          r.value,
        )}</td></tr>`,
    )
    .join("");

  const actionRows = actions
    .map(
      (a, i) =>
        `<tr><td style="padding:10px 0;border-bottom:1px solid #ebebeb;"><strong>${i + 1}. ${esc(a.title)}</strong>${
          a.amountText ? ` <span style="${muted}">${esc(a.amountText)}</span>` : ""
        }${a.reason ? `<br><span style="${muted}">${esc(a.reason)}</span>` : ""}</td><td style="padding:10px 0 10px 12px;border-bottom:1px solid #ebebeb;text-align:right;">${button(
          a.link,
          openAction,
          true,
        )}</td></tr>`,
    )
    .join("");
  const lockedRow = m.lockedFixes
    ? `<tr><td style="padding:10px 0;border-bottom:1px solid #ebebeb;">${esc(m.lockedFixes.text)}</td><td style="padding:10px 0 10px 12px;border-bottom:1px solid #ebebeb;text-align:right;">${button(
        m.lockedFixes.link,
        m.lockedFixes.label,
        true,
      )}</td></tr>`
    : "";

  const html = [
    `<!doctype html><html lang="${esc(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f1f1f1;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f1f1;"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;${font}color:#1a1a1a;font-size:14px;line-height:1.5;">`,
    `<tr><td style="padding:24px 24px 0;"><p style="margin:0;${muted}">${esc(heading)}</p>`,
    `<h1 style="margin:6px 0 16px;font-size:22px;line-height:1.3;">${esc(atStake)}</h1></td></tr>`,
    `<tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cardRows}</table></td></tr>`,
    refreshNote ? `<tr><td style="padding:12px 24px 0;"><p style="margin:0;${muted}">${esc(refreshNote)}</p></td></tr>` : "",
    actions.length || lockedRow
      ? `<tr><td style="padding:20px 24px 0;"><h2 style="margin:0 0 4px;font-size:16px;">${esc(topHeading)}</h2><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${actionRows}${lockedRow}</table></td></tr>`
      : "",
    accuracy ? `<tr><td style="padding:16px 24px 0;"><p style="margin:0;">${esc(accuracy)}</p></td></tr>` : "",
    `<tr><td style="padding:20px 24px 24px;">${button(input.links.app, openLabel)}</td></tr>`,
    `</table>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;${font}"><tr><td style="padding:16px 24px;${muted}">${esc(
      footer,
    )} <a href="${esc(input.links.unsubscribe)}" style="color:#616161;">${esc(unsubscribe)}</a></td></tr></table>`,
    `</td></tr></table></body></html>`,
  ].join("");

  return { subject, text, html };
}

// ---------------------------------------------------------------- actions & accuracy

/** An Action row as the email reads it (amounts as numbers). */
export type MondayActionRow = {
  kind: ActionKind;
  productId: string;
  amount: number;
  state: ActionState;
  stateAmount: number | null;
  snoozeUntil: Date | null;
  reason: unknown;
};

/**
 * The email's actions (spec §7.7, §3): rows visible now (`isVisible`), ranked by €
 * (`rankActions`), only those the plan may see (Free: the top 10), then the top 5.
 * Without `fixDetails` (Free) the Fix rows among them are not listed, only counted.
 */
export function selectMondayActions<T extends MondayActionRow>(
  rows: T[],
  plan: PlanCode,
  now: Date,
): { listed: T[]; lockedFixes: number } {
  const visible = rows.filter((r) => isVisible(r, now));
  const top = visibleRows(plan, rankActions(visible)).slice(0, MONDAY_TOP_ACTIONS);
  if (hasFeature(plan, "fixDetails")) return { listed: top, lockedFixes: 0 };
  const listed = top.filter((r) => tabOf(r.kind) !== "fix");
  return { listed, lockedFixes: top.length - listed.length };
}

/**
 * The action's sentence in the store's language: ACTION_REASONS[key] (an English
 * template, translated) filled with its params, formatted for that language like Home
 * (formatReasonParams: "12 Nov", "1,5"); an unknown key is shown as is. Slack reuses it.
 */
export function actionReasonText(locale: Locale, reason: unknown): string {
  const r = (reason && typeof reason === "object" ? reason : {}) as { key?: unknown; params?: unknown };
  const key = typeof r.key === "string" ? r.key : "";
  if (!key) return "";
  const params: ReasonParams = {};
  if (r.params && typeof r.params === "object") {
    for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) {
      if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) params[k] = v;
    }
  }
  return reasonSentence(translate(locale, ACTION_REASONS[key] ?? key), params, locale);
}

/**
 * The accuracy line's number: last month's store-total error, only when the
 * latest AccuracyMonth row IS last month (store-local) — an older row would
 * make "Last month" untrue. `localDate` is the store-local YYYY-MM-DD.
 */
export function lastMonthAccuracy(row: { month: Date; storeErrorPct: number | null } | null, localDate: string): number | null {
  if (!row || row.storeErrorPct == null || !Number.isFinite(row.storeErrorPct)) return null;
  const [y, m] = localDate.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  return row.month.toISOString().slice(0, 7) === prev ? row.storeErrorPct : null;
}
