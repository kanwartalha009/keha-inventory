/**
 * The Monday email (spec §11, §4 J2, decision D5). Pure: when it is due in the
 * store's time zone, and what it says. The sending (once per store week,
 * unsubscribe, recipients) is app/services/monday.server.ts.
 *
 * Task 2.6 (full email): the 4 numbers with week-on-week change, the top 5
 * actions (each with a button into the app), on Free the Fix rows only as a
 * count, the accuracy line, and the unsubscribe link.
 *
 * Audit 2026-10-17: the email leads with the job. An "Order this week" block
 * comes first (one line per supplier: units, cash, order-by date, overdue
 * flagged, "Review order" → Order now for that supplier; Free: its top-10
 * preview, read-only), and the subject says what to order:
 *   "{n} orders due this week · first by {day}", "{supplier} order is overdue ·
 *   {units} units", "Nothing to order this week · next: {supplier} by {date}",
 *   Free "{n} products to order by {date}".
 * "{money} at stake · {count} things to do" moves to the preheader. Without
 * order data (`orders` absent) the subject stays "{money} at stake this week —
 * N things to do". `mondaySummary` builds the content once; the email
 * (composeMondayEmail) and Slack (lib/slack-shared buildSlackMonday) render it.
 */
import { fill, translate, type Locale } from "./i18n";
import { change, MONEY_CARDS, type MoneyCardKey } from "./money-shared";
import { ACTION_REASONS, isVisible, rankActions, tabOf, type ActionKind, type ActionState, type ReasonParams } from "./actions-shared";
import { hasFeature, visibleRows, type MoneyRefresh, type PlanCode } from "./plan-shared";
import { reasonSentence } from "./action-facts-shared";
import type { DayKey } from "./engine/dates-shared";
import { notReadyText, type PlanNotReady } from "./dashboard-shared";

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

/** One supplier's order this week (from the forward order plan, order-plan-shared thisWeek). */
export type MondayOrderLine = {
  name: string;
  units: number;
  /** Known costs only; null = no line has a cost (left out, never 0). */
  cash: number | null;
  /** forward-plan ordersDue: the earliest order-by date (overdue: the one that passed; null = overdue, no date). */
  orderBy: DayKey | null;
  overdue: boolean;
  /** "Review order": Order now for this supplier. */
  link: string;
};

/** Free: one row of its top-10 preview (read-only). */
export type MondayPreviewRow = { title: string; variant: string; qty: number; orderBy: DayKey; overdue: boolean };

export type MondayOrders =
  | {
      kind: "plan";
      /** Store-local today. */
      today: DayKey;
      lines: MondayOrderLine[];
      /** The first order after this week, for the "nothing to order" line. */
      next: { name: string; orderBy: DayKey } | null;
      /** Products the plan can't plan (too little history; dead): the caveat on "nothing to order". */
      cantPlan?: { noData: number; dead: number } | null;
    }
  | {
      /** The store isn't ready (still reading it, fewer than 14 days of sales): say why (2026-10-17). */
      kind: "notReady";
      today: DayKey;
      readiness: PlanNotReady;
    }
  | {
      kind: "preview";
      today: DayKey;
      rows: MondayPreviewRow[];
      /** Distinct products in `rows`. */
      products: number;
      /** The app (Free's preview lives on the Dashboard) and the plans page. */
      link: string;
      plansLink: string;
    };

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
  /** The plan's refresh (MONEY_REFRESH): "weekly" on Free adds the "Refreshed weekly on Free" line; paid plans are daily. */
  refresh: MoneyRefresh;
  links: { app: string; unsubscribe: string };
  /** The ranked action list (top 5 shown). */
  actions?: MondayAction[];
  /** Free: Fix rows in the top 5, shown only as a count with a link to the plans (spec §3 fixDetails). */
  lockedFixes?: { count: number; link: string } | null;
  /** Last month's absolute % error on the store total (AccuracyMonth.storeErrorPct); null/undefined = no line. */
  accuracyPct?: number | null;
  /** "Order this week" (paid) or the top-10 preview (Free); absent/null = no order data (old subject, no block). */
  orders?: MondayOrders | null;
};

export type MondayEmailContent = { subject: string; text: string; html: string };

/** The "Order this week" block, worded. */
export type MondayOrderBlock = {
  heading: string;
  lines: { text: string; overdue: boolean; flag: string | null; link: string | null; label: string | null }[];
  /** Shown when there are no lines ("Nothing to order this week. Next order: …"). */
  empty: string | null;
  /** Free: the way to the full plan. */
  footer: { text: string; link: string; label: string } | null;
};

/** Everything the email and the Slack message show, worded and translated. */
export type MondaySummary = {
  locale: Locale;
  subject: string;
  /** Inbox preview line ("{money} at stake · {count} things to do"); null = none. */
  preheader: string | null;
  orders: MondayOrderBlock | null;
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

/** "Wed 21 Oct" in the store's language (a DayKey is a calendar day: formatted in UTC). */
export function formatEmailDay(day: DayKey, locale: string, weekday = true): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC", ...(weekday ? { weekday: "short" } : {}) };
  const d = new Date(`${day}T12:00:00Z`);
  for (const l of [locale, "en"]) {
    try {
      return d.toLocaleDateString(l, opts);
    } catch {
      /* unknown locale — next */
    }
  }
  return day;
}

/** The job-first subject from the order data (null = nothing to say about orders yet → the money subject). */
export function mondayOrderSubject(orders: MondayOrders, tr: (k: string) => string, numLocale: string): string | null {
  const count = (n: number) => formatCountIn(n, numLocale);
  // Not ready: no order subject at all — never "Nothing to order this week".
  if (orders.kind === "notReady") return null;
  if (orders.kind === "preview") {
    if (!orders.rows.length) return tr("Nothing to order this week");
    const last = orders.rows.reduce((m, r) => (r.orderBy > m ? r.orderBy : m), orders.rows[0]!.orderBy);
    const n = orders.products;
    if (orders.rows.every((r) => r.overdue || r.orderBy < orders.today)) return n === 1 ? tr("1 product to order now") : fill(tr("{n} products to order now"), { n: count(n) });
    const date = formatEmailDay(last, numLocale, false);
    return n === 1 ? fill(tr("1 product to order by {date}"), { date }) : fill(tr("{n} products to order by {date}"), { n: count(n), date });
  }
  const overdue = orders.lines.find((l) => l.overdue);
  if (overdue) return fill(tr("{supplier} order is overdue · {units} units"), { supplier: overdue.name, units: count(overdue.units) });
  if (orders.lines.length) {
    // No line is overdue here, so every line has a date.
    const first = orders.lines.map((l) => l.orderBy ?? orders.today).sort()[0]!;
    const day = formatEmailDay(first, numLocale);
    return orders.lines.length === 1
      ? fill(tr("1 order due this week · by {day}"), { day })
      : fill(tr("{n} orders due this week · first by {day}"), { n: count(orders.lines.length), day });
  }
  if (orders.next)
    return fill(tr("Nothing to order this week · next: {supplier} by {date}"), {
      supplier: orders.next.name,
      date: formatEmailDay(orders.next.orderBy, numLocale, false),
    });
  return tr("Nothing to order this week");
}

function formatCountIn(n: number, locale: string): string {
  const nf = numberFormat([locale, "en"], {});
  return nf ? nf.format(n) : String(n);
}

/** "1 product can't be planned yet — …" lines (Order plan's CantPlan wording), or null when none. */
function cantPlanText(c: { noData: number; dead: number } | null | undefined, tr: (k: string) => string, numLocale: string): string | null {
  if (!c) return null;
  const n = (v: number) => formatCountIn(v, numLocale);
  const parts: string[] = [];
  if (c.noData > 0)
    parts.push(fill(c.noData === 1 ? tr("1 product can't be planned yet — not enough sales history.") : tr("{n} products can't be planned yet — not enough sales history."), { n: n(c.noData) }));
  if (c.dead > 0)
    parts.push(fill(c.dead === 1 ? tr("1 product isn't selling (dead stock), so it isn't reordered.") : tr("{n} products aren't selling (dead stock), so they aren't reordered."), { n: n(c.dead) }));
  return parts.length ? parts.join(" ") : null;
}

function orderBlock(orders: MondayOrders, tr: (k: string) => string, numLocale: string, money: (v: number) => string): MondayOrderBlock {
  const units = (n: number) => fill(tr("{n} units"), { n: formatCountIn(n, numLocale) });
  if (orders.kind === "notReady") {
    const pct = numberFormat([numLocale, "en"], { style: "percent", maximumFractionDigits: 0 });
    return {
      heading: tr("Order this week"),
      lines: [],
      empty: `${tr("Your order plan isn't ready yet")}. ${notReadyText(orders.readiness, tr, {
        day: (d) => formatEmailDay(d, numLocale, false),
        percent: (x) => (pct ? pct.format(x) : `${Math.round(x * 100)} %`),
      })}`,
      footer: null,
    };
  }
  if (orders.kind === "preview") {
    return {
      heading: tr("Your most urgent products"),
      lines: orders.rows.map((r) => ({
        text: [
          r.variant ? `${r.title} · ${r.variant}` : r.title,
          units(r.qty),
          r.overdue ? tr("order now") : fill(tr("order by {date}"), { date: formatEmailDay(r.orderBy, numLocale, false) }),
        ].join(" · "),
        overdue: r.overdue,
        flag: r.overdue ? tr("Overdue") : null,
        link: null,
        label: null,
      })),
      empty: orders.rows.length ? null : tr("Nothing to order in the next 13 weeks."),
      footer: {
        text: tr("Plan every order by supplier and send purchase orders on the Growth plan."),
        link: orders.plansLink,
        label: tr("See plans"),
      },
    };
  }
  return {
    heading: tr("Order this week"),
    lines: orders.lines.map((l) => ({
      text: [
        l.name,
        units(l.units),
        ...(l.cash != null ? [money(l.cash)] : []),
        l.overdue ? tr("order today") : fill(tr("order by {date}"), { date: formatEmailDay(l.orderBy ?? orders.today, numLocale) }),
      ].join(" · "),
      overdue: l.overdue,
      flag: l.overdue ? tr("Overdue") : null,
      link: l.link,
      label: tr("Review order"),
    })),
    empty: orders.lines.length
      ? null
      : [
          orders.next
            ? fill(tr("Nothing to order this week. Next order: {supplier} by {date}."), {
                supplier: orders.next.name,
                date: formatEmailDay(orders.next.orderBy, numLocale, false),
              })
            : tr("Nothing to order this week"),
          // Never "nothing to order" without the products that couldn't be planned.
          cantPlanText(orders.cantPlan, tr, numLocale),
        ]
          .filter((x): x is string => !!x)
          .map((x, i, all) => (i < all.length - 1 && !/[.!?。]$/.test(x) ? `${x}.` : x))
          .join(" "),
    footer: null,
  };
}

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
  const orders = input.orders ?? null;
  // With order data the subject leads with the job and the money moves to the preheader.
  const orderSubject = orders ? mondayOrderSubject(orders, tr, numLocale) : null;
  const subject = orderSubject ?? (todo ? `${atStake} — ${todo}` : atStake);
  const preheader = orderSubject
    ? [total == null ? null : fill(tr("{money} at stake"), { money: money(total) }), todo].filter(Boolean).join(" · ") || null
    : null;

  const pct = input.accuracyPct;
  const accuracy =
    pct != null && Number.isFinite(pct) && pct >= 0
      ? fill(tr("Last month we were within {pct}% on your store total."), { pct: Math.round(pct) })
      : null;

  return {
    locale,
    subject,
    preheader,
    orders: orders ? orderBlock(orders, tr, numLocale, money) : null,
    heading: fill(tr("Your Monday summary for {store}"), { store: storeName }),
    atStake,
    rows,
    refreshNote: input.refresh === "weekly" ? tr("Refreshed weekly on Free") : null,
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
    footer: fill(tr("You get this email every Monday because Keha Inventory Planner is installed on {store}."), {
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
  const ob = m.orders;
  // ---- plain text ----
  const lines: string[] = [heading, ""];
  if (ob) {
    lines.push(ob.heading);
    for (const l of ob.lines) {
      lines.push(`- ${l.flag ? `${l.flag}: ` : ""}${l.text}`);
      if (l.link && l.label) lines.push(`  ${l.label}: ${l.link}`);
    }
    if (ob.empty) lines.push(ob.empty);
    if (ob.footer) lines.push(ob.footer.text, `${ob.footer.label}: ${ob.footer.link}`);
    lines.push("");
  }
  lines.push(atStake, "");
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
  const flagStyle = "display:inline-block;background:#fee9e8;color:#8e1f0b;border-radius:6px;padding:1px 6px;font-size:12px;font-weight:600;margin-right:6px;";
  const orderRows = ob
    ? ob.lines
        .map(
          (l) =>
            `<tr><td style="padding:10px 0;border-bottom:1px solid #ebebeb;">${l.flag ? `<span style="${flagStyle}">${esc(l.flag)}</span>` : ""}${esc(
              l.text,
            )}</td><td style="padding:10px 0 10px 12px;border-bottom:1px solid #ebebeb;text-align:right;white-space:nowrap;">${
              l.link && l.label ? button(l.link, l.label, true) : ""
            }</td></tr>`,
        )
        .join("")
    : "";
  const orderSection = ob
    ? `<tr><td style="padding:16px 24px 0;"><h2 style="margin:0 0 4px;font-size:18px;">${esc(ob.heading)}</h2>${
        orderRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${orderRows}</table>` : ""
      }${ob.empty ? `<p style="margin:4px 0 0;">${esc(ob.empty)}</p>` : ""}${
        ob.footer ? `<p style="margin:12px 0 0;${muted}">${esc(ob.footer.text)}</p><p style="margin:8px 0 0;">${button(ob.footer.link, ob.footer.label, true)}</p>` : ""
      }</td></tr>`
    : "";
  // Inbox preview text: hidden in the body, shown by mail clients after the subject.
  const preheaderHtml = m.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(m.preheader)}</div>`
    : "";
  const lockedRow = m.lockedFixes
    ? `<tr><td style="padding:10px 0;border-bottom:1px solid #ebebeb;">${esc(m.lockedFixes.text)}</td><td style="padding:10px 0 10px 12px;border-bottom:1px solid #ebebeb;text-align:right;">${button(
        m.lockedFixes.link,
        m.lockedFixes.label,
        true,
      )}</td></tr>`
    : "";

  const html = [
    `<!doctype html><html lang="${esc(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f1f1f1;">${preheaderHtml}`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f1f1;"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;${font}color:#1a1a1a;font-size:14px;line-height:1.5;">`,
    `<tr><td style="padding:24px 24px 0;"><p style="margin:0;${muted}">${esc(heading)}</p></td></tr>`,
    orderSection,
    `<tr><td style="padding:${ob ? "20px" : "6px"} 24px 0;"><h1 style="margin:0 0 16px;font-size:${ob ? "18px" : "22px"};line-height:1.3;">${esc(atStake)}</h1></td></tr>`,
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
