/**
 * Instant alerts (spec §11, §6.6 "alerts" hourly; task 2.6). Pure, client-safe:
 * the two rules, the 7-day cap, and the email wording. Sending is
 * app/services/alerts.server.ts.
 *
 * Rules (product level, the store's online stock pool):
 *  (a) low_best_seller — a best seller (ABC role A) has daysLeft < its lead time
 *      (VariantMetric; a sold-out A variant has daysLeft 0 and counts too).
 *  (b) sell_out — a sell-out STARTED on a product with ≥ 50 sessions in the last
 *      7 days (SessionsDaily landings on /products/<handle>). "Started" = every
 *      variant is out of stock now (StockNow on hand ≤ 0) and the product was not
 *      fully out on the previous stock day (StockDaily). Fully out, like the
 *      sold-out page visits card (spec §7.6): that is when shoppers land on a
 *      sold-out page. Unknown stock (no row) never counts as in or out.
 * Cap: at most 1 alert per product per 7 days on each channel (AlertLog).
 * When both rules hit, the sell-out wins (more urgent).
 */
import { fill, translate, type Locale } from "./i18n";

export const INSTANT_ALERT_KINDS = ["sell_out", "low_best_seller"] as const;
export type InstantAlertKind = (typeof INSTANT_ALERT_KINDS)[number];

/** Spec §11: at most 1 per product per 7 days. */
export const ALERT_COOLDOWN_DAYS = 7;
/** Spec §11: a sell-out matters on a product with ≥ 50 sessions a week. */
export const BUSY_SESSIONS_PER_WEEK = 50;
/** Alerts in one message; the rest go out on the next hourly tick. */
export const MAX_ALERTS_PER_MESSAGE = 10;
/** OwnerEmailLog kind of the alert email (period = the UTC hour). */
export const ALERT_EMAIL_KIND = "alert";

export type AlertChannel = "email" | "slack";

export type MetricLite = {
  variantId: string;
  productId: string;
  role: string;
  /** null = unknown / never runs out. */
  daysLeft: number | null;
  leadTimeDays: number;
};

export type LowBestSeller = { variantId: string; daysLeft: number; leadTimeDays: number };

/** Rule (a), per product: the A-role variant that runs out soonest, when it runs out within its lead time. */
export function lowBestSellers(metrics: MetricLite[]): Map<string, LowBestSeller> {
  const out = new Map<string, LowBestSeller>();
  for (const m of metrics) {
    if (m.role !== "A" || m.daysLeft == null || !Number.isFinite(m.daysLeft)) continue;
    if (!(m.daysLeft < m.leadTimeDays)) continue;
    const cur = out.get(m.productId);
    if (!cur || m.daysLeft < cur.daysLeft || (m.daysLeft === cur.daysLeft && m.variantId < cur.variantId))
      out.set(m.productId, { variantId: m.variantId, daysLeft: m.daysLeft, leadTimeDays: m.leadTimeDays });
  }
  return out;
}

/** Every variant known and out of stock. */
export function fullyOut(variantIds: string[], out: Map<string, boolean>): boolean {
  return variantIds.length > 0 && variantIds.every((v) => out.get(v) === true);
}

/** Every variant known and at least one in stock. */
export function knownNotFullyOut(variantIds: string[], out: Map<string, boolean>): boolean {
  return variantIds.length > 0 && variantIds.every((v) => out.has(v)) && variantIds.some((v) => out.get(v) === false);
}

/** Rule (b): products whose sell-out started, with their sessions in the last 7 days. */
export function sellOutsStarted(
  products: { productId: string; handle: string; variantIds: string[] }[],
  outNow: Map<string, boolean>,
  outPrev: Map<string, boolean>,
  sessions7d: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of products) {
    if (!fullyOut(p.variantIds, outNow) || !knownNotFullyOut(p.variantIds, outPrev)) continue;
    const sessions = sessions7d.get(p.handle.toLowerCase()) ?? 0;
    if (sessions >= BUSY_SESSIONS_PER_WEEK) out.set(p.productId, sessions);
  }
  return out;
}

export type InstantAlert =
  | { kind: "sell_out"; productId: string; variantId: string; title: string; sessions: number }
  | { kind: "low_best_seller"; productId: string; variantId: string; title: string; daysLeft: number; leadTimeDays: number };

/**
 * One alert per product (sell-out first), skipping products already alerted on
 * this channel in the last 7 days. Order: sell-outs by sessions, then best sellers
 * by days left; at most MAX_ALERTS_PER_MESSAGE.
 */
export function pickAlerts(
  products: Map<string, { title: string; variantIds: string[]; variantTitles?: Map<string, string> }>,
  low: Map<string, LowBestSeller>,
  sellOuts: Map<string, number>,
  alreadyAlerted: Set<string>,
): InstantAlert[] {
  type Sell = Extract<InstantAlert, { kind: "sell_out" }>;
  type Low = Extract<InstantAlert, { kind: "low_best_seller" }>;
  const byId = (a: { productId: string }, b: { productId: string }) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
  const sell: Sell[] = [];
  const lows: Low[] = [];
  for (const [productId, sessions] of sellOuts) {
    const p = products.get(productId);
    if (!p || alreadyAlerted.has(productId)) continue;
    sell.push({ kind: "sell_out", productId, variantId: p.variantIds[0], title: p.title, sessions });
  }
  for (const [productId, l] of low) {
    const p = products.get(productId);
    if (!p || alreadyAlerted.has(productId) || sellOuts.has(productId)) continue;
    const vt = p.variantTitles?.get(l.variantId);
    lows.push({
      kind: "low_best_seller",
      productId,
      variantId: l.variantId,
      title: vt ? `${p.title} (${vt})` : p.title,
      daysLeft: l.daysLeft,
      leadTimeDays: l.leadTimeDays,
    });
  }
  sell.sort((a, b) => b.sessions - a.sessions || byId(a, b));
  lows.sort((a, b) => a.daysLeft - b.daysLeft || byId(a, b));
  return [...sell, ...lows].slice(0, MAX_ALERTS_PER_MESSAGE);
}

/** "Blue / M" → shown; Shopify's single-variant "Default Title" → nothing. */
export function variantLabel(variantTitle: string | null | undefined): string | null {
  const t = (variantTitle ?? "").trim();
  return t && t !== "Default Title" ? t : null;
}

// ---------------------------------------------------------------- wording

export type AlertLine = { title: string; detail: string; link: string };

function daysText(days: number, locale: string): string {
  const d = Math.max(0, days);
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: d < 10 ? 1 : 0 }).format(d);
  } catch {
    return String(Math.round(d * 10) / 10);
  }
}

function countText(n: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(n);
  } catch {
    return String(n);
  }
}

/**
 * Title and detail for one alert, in the store's language. `showDays` = the plan
 * includes the forecast (Growth): without it the days-left figure is left out
 * (spec §3: per-variant days left is a Growth number), the alert itself stays.
 */
export function alertLine(
  locale: Locale,
  a: InstantAlert,
  link: string,
  numberLocale: string = locale,
  showDays = true,
): AlertLine {
  const tr = (key: string) => translate(locale, key);
  if (a.kind === "sell_out") {
    return {
      title: fill(tr("Out of stock: {product}"), { product: a.title }),
      detail: fill(tr("Visits to this product last week: {sessions}."), { sessions: countText(a.sessions, numberLocale) }),
      link,
    };
  }
  const leadOnly = fill(tr("New stock takes {lead} days."), { lead: a.leadTimeDays });
  if (a.daysLeft <= 0) return { title: fill(tr("Best seller out of stock: {product}"), { product: a.title }), detail: leadOnly, link };
  if (!showDays) return { title: fill(tr("Best seller low on stock: {product}"), { product: a.title }), detail: leadOnly, link };
  return {
    title: fill(tr("Best seller low on stock: {product}"), { product: a.title }),
    detail: fill(tr("Days of stock: {days}. New stock takes {lead} days."), {
      days: daysText(a.daysLeft, numberLocale),
      lead: a.leadTimeDays,
    }),
    link,
  };
}

export type AlertMessage = {
  subject: string;
  heading: string;
  lines: AlertLine[];
  openLabel: string;
  footer: string;
  settingsLabel: string;
  settingsLink: string;
};

export function alertMessage(locale: Locale, storeName: string, lines: AlertLine[], settingsLink: string): AlertMessage {
  const tr = (key: string) => translate(locale, key);
  return {
    subject: lines.length === 1 ? lines[0].title : fill(tr("{count} urgent stock alerts"), { count: lines.length }),
    heading: fill(tr("Urgent stock alerts for {store}"), { store: storeName }),
    lines,
    openLabel: tr("Open in Keha"),
    footer: fill(tr("You get these alerts because instant alerts are on for {store}."), { store: storeName }),
    settingsLabel: tr("Change alert settings"),
    settingsLink,
  };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The alert email (plain text + inline-styled HTML, like the Monday email).
 * `unsubscribeUrl`: the one-click link that turns instant alerts off
 * (app/routes/email.unsubscribe.tsx, kind "alerts"); left out when the app
 * URL isn't known.
 */
export function composeAlertEmail(
  locale: Locale,
  m: AlertMessage,
  unsubscribeUrl?: string | null,
): { subject: string; text: string; html: string } {
  const unsubscribe = translate(locale, "Unsubscribe");
  const text = [
    m.heading,
    "",
    ...m.lines.flatMap((l) => [l.title, `   ${l.detail}`, `   ${m.openLabel}: ${l.link}`, ""]),
    "—",
    m.footer,
    `${m.settingsLabel}: ${m.settingsLink}`,
    ...(unsubscribeUrl ? [`${unsubscribe}: ${unsubscribeUrl}`] : []),
  ].join("\n");
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  const muted = "color:#616161;font-size:13px;";
  const rows = m.lines
    .map(
      (l) =>
        `<tr><td style="padding:10px 0;border-bottom:1px solid #ebebeb;"><strong>${esc(l.title)}</strong><br><span style="${muted}">${esc(
          l.detail,
        )}</span></td><td style="padding:10px 0 10px 12px;border-bottom:1px solid #ebebeb;text-align:right;"><a href="${esc(
          l.link,
        )}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:8px;padding:6px 12px;font-size:13px;">${esc(
          m.openLabel,
        )}</a></td></tr>`,
    )
    .join("");
  const html = [
    `<!doctype html><html lang="${esc(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f1f1f1;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f1f1;"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;${font}color:#1a1a1a;font-size:14px;line-height:1.5;">`,
    `<tr><td style="padding:24px 24px 8px;"><h1 style="margin:0;font-size:20px;line-height:1.3;">${esc(m.heading)}</h1></td></tr>`,
    `<tr><td style="padding:0 24px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>`,
    `</table>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;${font}"><tr><td style="padding:16px 24px;${muted}">${esc(
      m.footer,
    )} <a href="${esc(m.settingsLink)}" style="color:#616161;">${esc(m.settingsLabel)}</a>${
      unsubscribeUrl ? ` · <a href="${esc(unsubscribeUrl)}" style="color:#616161;">${esc(unsubscribe)}</a>` : ""
    }</td></tr></table>`,
    `</td></tr></table></body></html>`,
  ].join("");
  return { subject: m.subject, text, html };
}
