/**
 * Alerts settings writes that happen outside a form save (task 2.6): the Slack
 * error the sender records, and connecting / disconnecting the webhook. Each
 * patches only `settings.alerts` and keeps every other stored key.
 */
import prisma from "../db.server";
import { readSettings, type ShopSettings } from "../lib/settings-shared";

async function patchAlerts(shop: string, patch: Partial<ShopSettings["alerts"]>): Promise<ShopSettings | null> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { settings: true } });
  if (!row) return null;
  const stored = (row.settings && typeof row.settings === "object" ? row.settings : {}) as Record<string, unknown>;
  const current = readSettings(stored);
  const merged = { ...stored, alerts: { ...current.alerts, ...patch } };
  await prisma.shop.update({ where: { domain: shop }, data: { settings: merged } });
  return readSettings(merged);
}

/** Record (or clear, with null) the last permanent Slack failure. */
export function setSlackError(shop: string, error: { code: string; at: string } | null): Promise<ShopSettings | null> {
  return patchAlerts(shop, { slackError: error });
}

/** Store a new encrypted webhook (clears any old error), or disconnect with null. */
export function setSlackWebhook(shop: string, sealed: string | null): Promise<ShopSettings | null> {
  return patchAlerts(shop, { slackWebhook: sealed, slackError: null });
}
