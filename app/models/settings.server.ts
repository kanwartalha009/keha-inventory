/**
 * Shop settings (Shop.settings JSON, spec §5.5) — read with defaults, save by
 * merging validated fields. The Shop row is created at install (ensureShop);
 * before that there is nothing to save to and the caller gets `null`.
 */
import prisma from "../db.server";
import { readSettings, type ShopSettings } from "../lib/settings-shared";

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
  return readSettings(merged);
}
