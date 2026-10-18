/**
 * "Your order plan is ready" email (lib/plan-ready-email-shared): checked after every compute job
 * (services/jobs/handlers), sent at most once per store (OwnerEmailLog kind "plan_ready", period
 * "once", inserted before sending — sendOwnerEmailOnce). Sent only when:
 *  - the store is installed and its first read finished within the last 7 days (stores whose read
 *    finished before this email existed never get it);
 *  - the plan is ready (the Dashboard's own state: history read, 14 days of sales, stock tracked)
 *    and a plan was computed after the read finished;
 *  - the Monday email is on (the owner's choice to get Keha emails; its unsubscribe link turns it
 *    off), email sending is configured, the app URL is set (no unsubscribe link → no email), and
 *    there is a recipient (the Monday recipients, else the owner's email).
 * Shopify Flow "First order plan ready" (owner decision 2026-10-18: no email provider by default)
 * fires under the same plan conditions (installed, read finished in the last 7 days, plan ready and
 * built), once per store (OwnerEmailLog kind "plan_ready_flow"), on every plan, independent of the
 * email: with no provider the merchant's Flow workflow emails it. The result returned is the email's.
 * Never throws: the compute job only logs the outcome.
 */
import prisma from "../db.server";
import { adminAppUrl } from "../lib/admin-url.server";
import { readSettings } from "../lib/settings-shared";
import { isDegraded, readBackfillState } from "../lib/sync/backfill-shared";
import { salesSpan } from "../lib/sync-progress-shared";
import { readMoneyBasis } from "../lib/dashboard-shared";
import { listUnsubscribeHeaders } from "../lib/owner-email-shared";
import { toSupportedLocale } from "../lib/i18n";
import {
  PLAN_READY_KIND,
  PLAN_READY_PERIOD,
  composePlanReadyEmail,
  planReadyFlowText,
  planReadyInWindow,
} from "../lib/plan-ready-email-shared";
import { FLOW_FIRST_PLAN, firstPlanPayload } from "../lib/flow-shared";
import { fireNotifyFlowOnce, notifyFlowPending, type NotifyFlowDeps } from "./notify-flow.server";
import { emailTransportConfigured } from "./email.server";
import { emailUnsubscribeUrl, ownerContact, sendOwnerEmailOnce } from "./owner-email.server";
import { firstSaleDay, getPlanReadiness } from "../models/dashboard.server";

export type PlanReadyResult =
  | "sent"
  | "failed"
  | "skipped:no_transport"
  | "skipped:not_installed"
  | "skipped:not_finished"
  | "skipped:too_old"
  | "skipped:not_ready"
  | "skipped:not_built"
  | "skipped:unsubscribed"
  | "skipped:already_sent"
  | "skipped:no_app_url"
  | "skipped:no_recipient"
  | "skipped";

/** Has the plan-ready email already gone out (or is it being sent)? */
export async function planReadyEmailSent(shop: string): Promise<boolean> {
  const row = await prisma.ownerEmailLog.findUnique({
    where: { shop_kind_periodKey: { shop, kind: PLAN_READY_KIND, periodKey: PLAN_READY_PERIOD } },
    select: { status: true },
  });
  return row?.status === "SENT";
}

export async function maybeSendPlanReadyEmail(shop: string, now: Date = new Date(), deps: NotifyFlowDeps = {}): Promise<PlanReadyResult> {
  try {
    const transport = emailTransportConfigured();
    const row = await prisma.shop.findUnique({
      where: { domain: shop },
      select: { domain: true, locale: true, settings: true, backfillState: true, uninstalledAt: true },
    });
    if (!row || row.uninstalledAt) return transport ? "skipped:not_installed" : "skipped:no_transport";
    const state = readBackfillState(row.backfillState);
    if (!state.finishedAt) return transport ? "skipped:not_finished" : "skipped:no_transport";
    if (!planReadyInWindow(state.finishedAt, now)) return transport ? "skipped:too_old" : "skipped:no_transport";
    const settings = readSettings(row.settings);
    // Shopify Flow "First order plan ready" (owner decision 2026-10-18): every plan, once, whether
    // or not an email provider is set and the Monday email is on — the merchant's workflow opts in.
    const flowDue = await notifyFlowPending(shop, FLOW_FIRST_PLAN, PLAN_READY_PERIOD, now);
    const emailState: PlanReadyResult | null = !transport
      ? "skipped:no_transport"
      : !settings.mondayEmail.enabled
        ? "skipped:unsubscribed"
        : (await planReadyEmailSent(shop))
          ? "skipped:already_sent"
          : null;
    if (emailState && !flowDue) return emailState;

    const ready = await getPlanReadiness(shop, now);
    if (!ready.ready) return emailState ?? "skipped:not_ready";
    const money = await prisma.moneyAtStake.findFirst({ where: { shop }, orderBy: { day: "desc" }, select: { basis: true } });
    const builtAt = readMoneyBasis(money?.basis)?.computedAt ?? null;
    if (!builtAt || new Date(builtAt).getTime() < new Date(state.finishedAt).getTime()) return emailState ?? "skipped:not_built";

    const contact = await ownerContact(shop, null);
    const locale = contact?.locale ?? toSupportedLocale(row.locale);
    // Months of sales really read (first sale → last day read), not the fixed read window.
    const span = salesSpan(await firstSaleDay(shop), state.syncedThrough ?? state.range?.until ?? state.finishedAt.slice(0, 10));
    const gaps = isDegraded(state);
    const appLink = adminAppUrl(shop, "/app");
    const storeName = contact?.name || shop;

    if (flowDue) {
      const f = planReadyFlowText({ locale, storeName, span, gaps, appLink });
      const r = await fireNotifyFlowOnce(shop, FLOW_FIRST_PLAN, PLAN_READY_PERIOD, firstPlanPayload({ ...f, link: appLink }), now, deps);
      if (r !== "skipped") console.log(`[plan-ready] ${shop}: Flow trigger ${r}`);
    }
    if (emailState) return emailState;

    const unsubscribe = emailUnsubscribeUrl(shop, "monday", now.getTime());
    if (!unsubscribe) return "skipped:no_app_url";
    const recipients = settings.mondayEmail.recipients.map((r) => r.trim()).filter((r) => r.includes("@"));
    const to = recipients.length ? recipients : (contact?.to ?? null);
    if (!to || (Array.isArray(to) && !to.length)) return "skipped:no_recipient";

    const content = composePlanReadyEmail({ locale, storeName, span, gaps, links: { app: appLink, unsubscribe } });
    return await sendOwnerEmailOnce(
      shop,
      { kind: PLAN_READY_KIND, periodKey: PLAN_READY_PERIOD, ...content, headers: listUnsubscribeHeaders(unsubscribe) },
      { name: storeName, to, locale },
      now,
    );
  } catch (e) {
    console.error(`[plan-ready] ${shop}: not sent`, e);
    return "skipped";
  }
}
