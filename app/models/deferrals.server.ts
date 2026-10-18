/**
 * Fit to budget → Apply / Undo (merchant audit 2026-10-18; lib/deferral-shared). Database only:
 * nothing reaches Shopify or a supplier. Apply re-reads the plan and its suggestion on the server
 * (the browser only names the month), stores the holds as one batch and forgets the cached plan;
 * Undo deletes the batch.
 */
import crypto from "node:crypto";
import prisma from "../db.server";
import { planFit } from "../lib/order-plan-shared";
import { holdsFromFit } from "../lib/deferral-shared";
import { forgetOrderPlan } from "./plan-cache.server";
import { loadOrderPlan } from "./order-plan.server";

const dayDate = (d: string) => new Date(`${d}T00:00:00Z`);

export type ApplyFitResult = { ok: true; batch: string; lines: number; amount: number } | { ok: false; error: "nothing" };

/** "Apply": the month's suggestion as it stands now, stored as one batch of holds. */
export async function applyFitToBudget(shop: string, month: unknown, now: Date = new Date()): Promise<ApplyFitResult> {
  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: "nothing" };
  const plan = await loadOrderPlan(shop, now);
  const fit = planFit(plan).find((f) => f.month === month);
  if (!fit || !fit.deferrals.length) return { ok: false, error: "nothing" };
  const batch = `${now.toISOString()}#${crypto.randomBytes(4).toString("hex")}`;
  const holds = holdsFromFit(fit, batch);
  await prisma.planDeferral.createMany({
    data: holds.map((h) => ({ id: crypto.randomUUID(), shop, batch: h.batch, month: h.month, variantId: h.variantId, supplierKey: h.supplierKey, fromDay: dayDate(h.fromDay), until: dayDate(h.until), qty: h.qty, amount: h.amount })),
  });
  forgetOrderPlan(shop);
  return { ok: true, batch, lines: holds.length, amount: Math.round(holds.reduce((a, h) => a + h.amount, 0) * 100) / 100 };
}

/** "Undo": the batch's orders are back on their own dates. */
export async function undoFitToBudget(shop: string, batch: unknown): Promise<{ ok: boolean }> {
  if (typeof batch !== "string" || batch.length > 100) return { ok: false };
  const r = await prisma.planDeferral.deleteMany({ where: { shop, batch } });
  if (r.count) forgetOrderPlan(shop);
  return { ok: r.count > 0 };
}
