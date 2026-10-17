/**
 * "Your order plan is ready" — the one email after the first read of a store finishes (owner
 * 2026-10-17, sync experience for big stores). Large stores take hours to read, so the Dashboard
 * says "you can close this page; we'll email you when your order plan is ready" and this keeps
 * that promise: once per store ever (OwnerEmailLog kind PLAN_READY_KIND, periodKey "once"), to the
 * Monday-email recipients or the owner, only while the Monday email is on (its unsubscribe link
 * and List-Unsubscribe headers turn that off), never when email sending isn't configured.
 *
 * Pure: the composer. When to send lives in services/plan-ready.server.
 */
import { fill, translate, type Locale } from "./i18n";
import { salesSpanText, type SalesSpan } from "./sync-progress-shared";

export const PLAN_READY_KIND = "plan_ready";
/** One period for the whole life of the install: the email goes out at most once. */
export const PLAN_READY_PERIOD = "once";
/** Never send it for a read that finished longer ago than this (e.g. stores installed before the email existed). */
export const PLAN_READY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type PlanReadyEmailInput = {
  locale: Locale;
  storeName: string;
  /**
   * Sales history really read (lib/sync-progress-shared salesSpan): from the store's first sale to
   * the last day read, capped at the read window — never the window itself (listing audit
   * 2026-10-18: "14 months … reflects your seasons" was said to stores with 3 months of sales).
   */
  span: SalesSpan;
  /** Some months could not be read (the backfill skipped them). */
  gaps: boolean;
  links: { app: string; unsubscribe: string };
};

export type PlanReadyEmail = { subject: string; text: string; html: string };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function composePlanReadyEmail(input: PlanReadyEmailInput): PlanReadyEmail {
  const tr = (key: string) => translate(input.locale, key);
  const subject = tr("Your order plan is ready");
  const heading = fill(tr("Your order plan for {store} is ready"), { store: input.storeName });
  const count = (n: number) => new Intl.NumberFormat(input.locale).format(n);
  const body = `${tr("We've finished reading your sales, stock and store visits.")} ${salesSpanText(input.span, tr, count)}`;
  const next = tr("Open it to see what to order this week, from which supplier and by when.");
  const gaps = input.gaps ? tr("A few months couldn't be read; your plan uses the others.") : null;
  const cta = tr("Open your order plan");
  const footer = fill(tr("You get this one-time email because the Monday email is on for {store}."), { store: input.storeName });
  const unsubscribe = tr("Unsubscribe");

  const text = [heading, "", body, next, ...(gaps ? ["", gaps] : []), "", `${cta}: ${input.links.app}`, "", "—", footer, `${unsubscribe}: ${input.links.unsubscribe}`].join("\n");

  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  const muted = "color:#616161;font-size:13px;";
  const html = [
    `<!doctype html><html lang="${esc(input.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f1f1f1;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f1f1;"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;${font}color:#1a1a1a;font-size:14px;line-height:1.5;">`,
    `<tr><td style="padding:24px 24px 0;"><h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;">${esc(heading)}</h1></td></tr>`,
    `<tr><td style="padding:0 24px;"><p style="margin:0 0 8px;">${esc(body)}</p><p style="margin:0;">${esc(next)}</p>${
      gaps ? `<p style="margin:12px 0 0;${muted}">${esc(gaps)}</p>` : ""
    }</td></tr>`,
    `<tr><td style="padding:20px 24px 24px;"><a href="${esc(input.links.app)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:8px;padding:10px 18px;font-size:14px;font-weight:600;">${esc(cta)}</a></td></tr>`,
    `</table>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;${font}"><tr><td style="padding:16px 24px;${muted}">${esc(
      footer,
    )} <a href="${esc(input.links.unsubscribe)}" style="color:#616161;">${esc(unsubscribe)}</a></td></tr></table>`,
    `</td></tr></table></body></html>`,
  ].join("");
  return { subject, text, html };
}

/** Is the finished read recent enough for the email (and finished at all)? */
export function planReadyInWindow(finishedAt: string | null | undefined, now: Date): boolean {
  if (!finishedAt) return false;
  const f = new Date(finishedAt).getTime();
  return Number.isFinite(f) && now.getTime() >= f && now.getTime() - f <= PLAN_READY_WINDOW_MS;
}
