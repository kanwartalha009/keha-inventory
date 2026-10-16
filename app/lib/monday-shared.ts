/**
 * The Monday email (spec §11, §4 J2, decision D5). Pure: when it is due in the
 * store's time zone, and what it says. The sending (once per store week,
 * unsubscribe, recipients) is app/services/monday.server.ts.
 *
 * Phase 1: the action list and the accuracy scorecard don't exist yet, so the
 * subject is "<money> at stake this week" and those sections are left out.
 * Passing `actions` (top 5 shown) adds "— N things to do" to the subject and
 * the actions section; passing `accuracy` adds its line.
 */
import { fill, translate, type Locale } from "./i18n";
import { change, MONEY_CARDS, type MoneyCardKey } from "./money-shared";

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

/** Sum of the cards that have a value; null when none has one. */
export function totalAtStake(values: Record<MoneyCardKey, number | null>): number | null {
  const known = MONEY_CARDS.map((k) => values[k]).filter((v): v is number => v != null);
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
  /** The ranked action list (top 5 shown). Not built yet in phase 1. */
  actions?: MondayAction[];
  /** The forecast accuracy line, already worded. Not built yet in phase 1. */
  accuracy?: string | null;
};

export type MondayEmailContent = { subject: string; text: string; html: string };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const DASH = "—";

export function composeMondayEmail(input: MondayEmailInput): MondayEmailContent {
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

  const total = totalAtStake(input.now);
  const atStake = fill(tr("{money} at stake this week"), { money: total == null ? DASH : money(total) });

  const actions = (input.actions ?? []).slice(0, MONDAY_TOP_ACTIONS);
  const todo =
    actions.length === 0
      ? null
      : actions.length === 1
        ? tr("1 thing to do")
        : fill(tr("{count} things to do"), { count: actions.length });
  const subject = todo ? `${atStake} — ${todo}` : atStake;

  const heading = fill(tr("Your Monday summary for {store}"), { store: storeName });
  const refreshNote = input.refresh === "monthly" ? tr("Refreshed monthly on Free") : null;
  const accuracy = input.accuracy?.trim() || null;
  const openLabel = tr("Open Keha");
  const footer = fill(tr("You get this email every Monday because Keha Inventory Intelligence is installed on {store}."), {
    store: storeName,
  });
  const unsubscribe = tr("Unsubscribe");
  const topHeading = tr("Top things to do this week");
  const openAction = tr("Open");

  // ---- plain text ----
  const lines: string[] = [heading, "", atStake, ""];
  for (const r of rows) lines.push(`${r.label}: ${r.value}${r.changeText ? ` (${r.changeText})` : ""}`);
  if (refreshNote) lines.push("", refreshNote);
  if (actions.length) {
    lines.push("", topHeading);
    actions.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.title}${a.amount != null ? ` (${money(a.amount)})` : ""}`);
      if (a.reason) lines.push(`   ${a.reason}`);
      lines.push(`   ${openAction}: ${a.link}`);
    });
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
          a.amount != null ? ` <span style="${muted}">${esc(money(a.amount))}</span>` : ""
        }${a.reason ? `<br><span style="${muted}">${esc(a.reason)}</span>` : ""}</td><td style="padding:10px 0 10px 12px;border-bottom:1px solid #ebebeb;text-align:right;">${button(
          a.link,
          openAction,
          true,
        )}</td></tr>`,
    )
    .join("");

  const html = [
    `<!doctype html><html lang="${esc(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f1f1f1;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f1f1;"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;${font}color:#1a1a1a;font-size:14px;line-height:1.5;">`,
    `<tr><td style="padding:24px 24px 0;"><p style="margin:0;${muted}">${esc(heading)}</p>`,
    `<h1 style="margin:6px 0 16px;font-size:22px;line-height:1.3;">${esc(atStake)}</h1></td></tr>`,
    `<tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cardRows}</table></td></tr>`,
    refreshNote ? `<tr><td style="padding:12px 24px 0;"><p style="margin:0;${muted}">${esc(refreshNote)}</p></td></tr>` : "",
    actions.length
      ? `<tr><td style="padding:20px 24px 0;"><h2 style="margin:0 0 4px;font-size:16px;">${esc(topHeading)}</h2><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${actionRows}</table></td></tr>`
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
