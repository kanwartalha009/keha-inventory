/**
 * Shop settings (Shop.settings JSON, spec §5.5) — read with defaults, save by
 * merging validated fields. The Shop row is created at install (ensureShop);
 * before that there is nothing to save to and the caller gets `null`.
 */
import prisma from "../db.server";
import { facts } from "../services/facts-store.server";
import { forgetOrderPlan } from "./plan-cache.server";
import { readSettings, type ShopSettings } from "../lib/settings-shared";
import { ALL } from "../lib/sync/facts-shared";

export async function getShopSettings(shop: string): Promise<ShopSettings> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { settings: true } });
  return readSettings(row?.settings);
}

/** Merge a validated patch into the stored JSON (other keys are kept). */
export async function saveShopSettings(shop: string, next: ShopSettings): Promise<ShopSettings | null> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { settings: true } });
  if (!row) return null;
  const stored = (row.settings && typeof row.settings === "object" ? row.settings : {}) as Record<string, unknown>;
  const merged = { ...stored, ...next };
  await prisma.shop.update({ where: { domain: shop }, data: { settings: merged } });
  forgetOrderPlan(shop);
  return readSettings(merged);
}

/**
 * Remembers that we asked for a review (lib/review-ask-shared): Shop.settings.reviewAsk, a key
 * outside ShopSettings, merged so every other setting is kept. Only the first answer is kept.
 */
export async function recordReviewAsk(shop: string, code: string, now: Date): Promise<boolean> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { settings: true } });
  if (!row) return false;
  const stored = (row.settings && typeof row.settings === "object" ? row.settings : {}) as Record<string, unknown>;
  if (stored.reviewAsk) return false;
  await prisma.shop.update({ where: { domain: shop }, data: { settings: { ...stored, reviewAsk: { askedAt: now.toISOString(), code } } } });
  return true;
}

export type SalesChannelRow = { name: string; units: number };

/**
 * The sales channels in the store's history (SalesDaily channel view, last 365 days) with their
 * units, most units first — the "Sales channels in the forecast" choices (R4). Channels left out
 * earlier but not seen in the year are kept (0 units) so they can be put back.
 */
export async function salesChannels(shop: string, excluded: readonly string[], today = new Date()): Promise<SalesChannelRow[]> {
  const from = new Date(today.getTime() - 365 * 86_400_000);
  const rows = await facts.salesDaily.groupBy({
    by: ["channel"],
    where: { shop, locationKey: ALL, day: { gte: from } },
    _sum: { sold: true },
  });
  const out = rows
    .filter((r) => typeof r.channel === "string" && r.channel !== "" && r.channel !== ALL)
    .map((r) => ({ name: r.channel, units: Number(r._sum.sold ?? 0) }));
  for (const name of excluded) if (!out.some((c) => c.name === name)) out.push({ name, units: 0 });
  return out.sort((a, b) => b.units - a.units || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A location is left out of supplier orders (Settings → Locations): demand uses the location view. */
export async function hasLocationLeftOut(shop: string): Promise<boolean> {
  return (await prisma.location.count({ where: { shop, onlinePool: false } })) > 0;
}
