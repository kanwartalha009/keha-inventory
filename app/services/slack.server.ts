/**
 * Slack sender (spec §11, §14). Posts JSON to the store's incoming webhook with
 * a timeout. The webhook link is stored encrypted (lib/crypto.server,
 * APP_ENCRYPTION_KEY) and is NEVER logged or sent back to the browser.
 *
 * A permanent failure (4xx: invalid_token, channel_not_found, no_service, …)
 * keeps the link but stores the error in Shop.settings.alerts.slackError, which
 * the Alerts tab shows; the next successful send clears it. Temporary failures
 * (408, 429, 5xx, network, timeout) are only logged.
 *
 * Plan: `slack` is Growth (checked by the callers before sending).
 */
import prisma from "../db.server";
import { decryptSecret } from "../lib/crypto.server";
import { normalizeSlackWebhook, slackFailure, type SlackMessage } from "../lib/slack-shared";
import { canRetryOwnerEmail, emailAttempts, failedAttemptError, OWNER_EMAIL_MAX_ATTEMPTS } from "../lib/owner-email-shared";
import type { ShopSettings } from "../lib/settings-shared";
import { setSlackError } from "../models/alerts.server";

export const SLACK_TIMEOUT_MS = 8000;

export type SlackResult = { ok: true } | { ok: false; code: string; permanent: boolean };

/** POST one message to a webhook link (already decrypted). Never logs the link. */
export async function postSlack(webhook: string, message: SlackMessage, timeoutMs = SLACK_TIMEOUT_MS): Promise<SlackResult> {
  const url = normalizeSlackWebhook(webhook);
  if (!url) return { ok: false, code: "not_readable", permanent: true };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => "");
    return { ok: false, ...slackFailure(res.status, body) };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    return { ok: false, code: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error", permanent: false };
  }
}

/**
 * Send to the store's connected Slack, keeping `alerts.slackError` in step:
 * set on a permanent failure, cleared on success. "skipped" = not connected.
 */
export async function deliverSlack(
  shop: string,
  settings: ShopSettings,
  message: SlackMessage,
  now: Date = new Date(),
): Promise<SlackResult | "skipped"> {
  const sealed = settings.alerts.slackWebhook;
  if (!sealed) return "skipped";
  const webhook = decryptSecret(sealed);
  const r = await postSlack(webhook, message);
  if (r.ok) {
    if (settings.alerts.slackError) await setSlackError(shop, null);
    return r;
  }
  console.warn(`[slack] ${shop}: send failed (${r.code}${r.permanent ? ", kept the link and showed the error in Settings" : ""})`);
  if (r.permanent) await setSlackError(shop, { code: r.code, at: now.toISOString() });
  return r;
}

/**
 * Send at most once per (shop, kind, period) — the Monday summary — using the
 * OwnerEmailLog row as the claim (inserted BEFORE sending, so two ticks can't
 * both send). One retry an hour later after a temporary failure, like the email;
 * a permanent failure is final for the period.
 */
export async function deliverSlackOnce(
  shop: string,
  key: { kind: string; periodKey: string },
  settings: ShopSettings,
  message: SlackMessage,
  now: Date = new Date(),
): Promise<"sent" | "failed" | "skipped"> {
  if (!settings.alerts.slackWebhook) return "skipped";
  const id = { shop, kind: key.kind, periodKey: key.periodKey };
  let attempt = 1;
  try {
    await prisma.ownerEmailLog.create({ data: { ...id, sentAt: now } });
  } catch {
    const row = await prisma.ownerEmailLog.findUnique({ where: { shop_kind_periodKey: id } });
    if (!row || !canRetryOwnerEmail(row, now)) return "skipped";
    const claimed = await prisma.ownerEmailLog.updateMany({
      where: { ...id, status: "FAILED", error: row.error, sentAt: row.sentAt },
      data: { status: "SENT", sentAt: now },
    });
    if (claimed.count !== 1) return "skipped";
    attempt = emailAttempts(row.error) + 1;
  }
  const r = await deliverSlack(shop, settings, message, now);
  if (r === "skipped") return "skipped";
  if (!r.ok) {
    // A permanent failure uses up the retry (the link is broken until the merchant fixes it).
    const recorded = r.permanent ? Math.max(attempt, OWNER_EMAIL_MAX_ATTEMPTS) : attempt;
    await prisma.ownerEmailLog.update({
      where: { shop_kind_periodKey: id },
      data: { status: "FAILED", error: failedAttemptError(recorded, `slack ${r.code}`) },
    });
    return "failed";
  }
  if (attempt > 1) await prisma.ownerEmailLog.update({ where: { shop_kind_periodKey: id }, data: { error: null } });
  return "sent";
}
