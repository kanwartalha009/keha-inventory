/**
 * Notification triggers in Shopify Flow (owner decision 2026-10-18: no paid email provider).
 * "Weekly order plan ready" (the Monday summary) and "First order plan ready" (the one-time
 * "your plan is ready" notice) go to the store's own Shopify Flow, where the merchant's workflow
 * (our template: Flow's "Send internal email" action) emails them — from Shopify, to the
 * addresses the merchant typed in Flow. Keha needs no email provider for this.
 *
 * At most once per (shop, kind, period), claimed in OwnerEmailLog BEFORE firing (the same rule as
 * the Monday email and Slack summary: two ticks can't both fire). A network / throttle error gets
 * one retry an hour later; Shopify refusing the trigger (userErrors, e.g. the extension isn't
 * released yet) is final for the period — the next week fires again. Never throws.
 */
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { FLOW_NOTIFY_KIND, type NotifyHandle } from "../lib/flow-shared";
import { SAMPLE_SUFFIX } from "../lib/sample-mode-shared";
import { OWNER_EMAIL_MAX_ATTEMPTS, canRetryOwnerEmail, emailAttempts, failedAttemptError } from "../lib/owner-email-shared";
import { fireFlowTrigger, type AdminGraphql } from "./flow.server";

export type NotifyFlowDeps = { getAdmin?: (shop: string) => Promise<AdminGraphql> };

const defaultAdmin = async (shop: string): Promise<AdminGraphql> => (await unauthenticated.admin(shop)).admin as unknown as AdminGraphql;

export type NotifyFlowResult = "fired" | "failed" | "skipped";

/** Has this trigger already fired (or is it being fired) for this period? Cheap pre-check. */
export async function notifyFlowPending(shop: string, handle: NotifyHandle, periodKey: string, now: Date): Promise<boolean> {
  if (shop.includes(SAMPLE_SUFFIX)) return false; // sample data never triggers Flow
  try {
    const row = await prisma.ownerEmailLog.findUnique({ where: { shop_kind_periodKey: { shop, kind: FLOW_NOTIFY_KIND[handle], periodKey } } });
    return !row || canRetryOwnerEmail(row, now);
  } catch {
    return false;
  }
}

export async function fireNotifyFlowOnce(
  shop: string,
  handle: NotifyHandle,
  periodKey: string,
  payload: Record<string, unknown>,
  now: Date = new Date(),
  deps: NotifyFlowDeps = {},
): Promise<NotifyFlowResult> {
  if (shop.includes(SAMPLE_SUFFIX)) return "skipped"; // sample data never triggers Flow
  const id = { shop, kind: FLOW_NOTIFY_KIND[handle], periodKey };
  try {
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
    let r: Awaited<ReturnType<typeof fireFlowTrigger>>;
    try {
      r = await fireFlowTrigger(await (deps.getAdmin ?? defaultAdmin)(shop), handle, payload);
    } catch (e) {
      // No offline session (e.g. uninstalled meanwhile): a temporary failure.
      r = { status: "error", error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
    if (r.status !== "ok") {
      // Refused by Shopify: final for this period (retrying an unreleased extension changes nothing).
      const recorded = r.status === "rejected" ? Math.max(attempt, OWNER_EMAIL_MAX_ATTEMPTS) : attempt;
      await prisma.ownerEmailLog.update({ where: { shop_kind_periodKey: id }, data: { status: "FAILED", error: failedAttemptError(recorded, `flow ${r.status}: ${r.error}`) } });
      console.log(`[flow] ${shop} ${handle}: ${r.status} (${r.error})`);
      return "failed";
    }
    if (attempt > 1) await prisma.ownerEmailLog.update({ where: { shop_kind_periodKey: id }, data: { error: null } });
    return "fired";
  } catch (e) {
    console.error(`[flow] ${shop} ${handle}: not fired`, e);
    return "failed";
  }
}
