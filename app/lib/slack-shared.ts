/**
 * Slack (spec §5.5, §11, §14; plan feature `slack` = Growth). Pure, client-safe:
 * the incoming-webhook link check, how a Slack answer is classified, and the
 * message builders (test message, Monday summary, instant alerts). Sending is
 * app/services/slack.server.ts; the link is stored encrypted and never shown back.
 */
import { fill, translate, type Locale } from "./i18n";
import type { MondaySummary } from "./monday-shared";
import type { AlertMessage } from "./alerts-shared";

/**
 * A Slack incoming-webhook link: https://hooks.slack.com/services/T…/B…/<secret>.
 * Strict on purpose: the server only ever POSTs to this host and path, so a
 * pasted link can never point the app at another address.
 */
const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,20}\/B[A-Z0-9]{6,20}\/[A-Za-z0-9]{16,64}$/;

/** The trimmed link when it is a Slack incoming webhook, else null. */
export function normalizeSlackWebhook(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  return SLACK_WEBHOOK_RE.test(s) ? s : null;
}

/** Slack's mrkdwn needs &, < and > escaped in plain text. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** <url|label> link; `|` and `>` in the URL are percent-encoded so they can't break out. */
export function slackLink(url: string, label: string): string {
  const safe = url.replace(/\|/g, "%7C").replace(/>/g, "%3E").replace(/</g, "%3C");
  return `<${safe}|${slackEscape(label).replace(/\|/g, "/")}>`;
}

/** What an incoming webhook accepts (text is mrkdwn). */
export type SlackMessage = { text: string };

/**
 * Classify a failed POST. Slack answers 4xx with a plain-text code
 * (invalid_token, channel_not_found, no_service, channel_is_archived, …).
 * Permanent = the link or channel is broken: keep the link, store the error
 * and show it on the Alerts tab. 408/429/5xx/network are temporary.
 */
export function slackFailure(status: number, body: string): { code: string; permanent: boolean } {
  const text = String(body ?? "").trim();
  const code = /^[a-z_]{2,60}$/.test(text) ? text : `http_${status}`;
  const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return { code, permanent };
}

/** Codes grouped for the message shown on the Alerts tab. */
export type SlackErrorGroup = "link" | "channel" | "unreadable" | "other";

export function slackErrorGroup(code: string): SlackErrorGroup {
  if (["invalid_token", "no_service", "no_service_id", "no_team", "team_disabled", "http_403", "http_404", "http_410"].includes(code))
    return "link";
  if (["channel_not_found", "channel_is_archived", "posting_to_general_channel_denied", "action_prohibited"].includes(code))
    return "channel";
  if (code === "not_readable") return "unreadable";
  return "other";
}

// ---------------------------------------------------------------- messages

/** "Send a test message" on the Alerts tab. */
export function buildSlackTest(locale: Locale, storeName: string): SlackMessage {
  const tr = (key: string) => translate(locale, key);
  return {
    text: slackEscape(
      fill(tr("Keha Inventory Intelligence is connected for {store}. The Monday summary and urgent stock alerts will appear here."), {
        store: storeName,
      }),
    ),
  };
}

/**
 * The Monday summary for Slack (spec §11: "same content, shorter"): headline,
 * the 4 numbers with their change, the top actions as links, the accuracy line.
 * No unsubscribe line — the Slack summary is switched off on the Alerts tab.
 */
export function buildSlackMonday(m: MondaySummary): SlackMessage {
  const e = slackEscape;
  // With order data the message leads with the job, like the email subject (audit 2026-10-17).
  const lines: string[] = [`*${e(m.orders ? m.subject : m.atStake)}*`, e(m.heading), ""];
  if (m.orders) {
    const o = m.orders;
    lines.push(`*${e(o.heading)}*`);
    for (const l of o.lines)
      lines.push(`• ${l.flag ? `*${e(l.flag)}* ` : ""}${e(l.text)}${l.link && l.label ? ` ${slackLink(l.link, l.label)}` : ""}`);
    if (o.empty) lines.push(e(o.empty));
    if (o.footer) lines.push(`${e(o.footer.text)} ${slackLink(o.footer.link, o.footer.label)}`);
    lines.push("", `*${e(m.atStake)}*`);
  }
  for (const r of m.rows) lines.push(`• ${e(r.label)}: *${e(r.value)}*${r.changeText ? ` (${e(r.changeText)})` : ""}`);
  if (m.refreshNote) lines.push(`_${e(m.refreshNote)}_`);
  if (m.actions.length || m.lockedFixes) {
    lines.push("", `*${e(m.topHeading)}*`);
    m.actions.forEach((a, i) => {
      lines.push(`${i + 1}. ${slackLink(a.link, a.title)}${a.amountText ? ` · ${e(a.amountText)}` : ""}`);
      if (a.reason) lines.push(`    ${e(a.reason)}`);
    });
    if (m.lockedFixes) lines.push(`${m.actions.length + 1}. ${e(m.lockedFixes.text)} ${slackLink(m.lockedFixes.link, m.lockedFixes.label)}`);
  }
  if (m.accuracy) lines.push("", e(m.accuracy));
  lines.push("", slackLink(m.links.app, m.openLabel));
  return { text: lines.join("\n") };
}

/** Instant alerts for Slack: the heading and one linked line per product. */
export function buildSlackAlerts(m: AlertMessage): SlackMessage {
  const e = slackEscape;
  const lines: string[] = [`*${e(m.heading)}*`];
  for (const l of m.lines) lines.push(`• ${slackLink(l.link, l.title)}`, `    ${e(l.detail)}`);
  lines.push("", slackLink(m.settingsLink, m.settingsLabel));
  return { text: lines.join("\n") };
}
