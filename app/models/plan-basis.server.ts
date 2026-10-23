/**
 * "How we plan" (clarity pass 2026-10-23): the store's own planning rules, said once per page
 * instead of a method sentence repeated on every product (lib/plan-basis-shared). Database only.
 */
import prisma from "../db.server";
import { readSettings } from "../lib/settings-shared";
import type { PlanBasis } from "../lib/plan-basis-shared";

export async function planBasis(shop: string): Promise<PlanBasis> {
  const [row, suppliers, leftOut] = await Promise.all([
    prisma.shop.findUnique({ where: { domain: shop }, select: { settings: true } }),
    prisma.supplier.count({ where: { shop } }),
    prisma.location.count({ where: { shop, onlinePool: false } }),
  ]);
  const s = readSettings(row?.settings);
  return { leadTimeDays: s.leadTimeDays, cycleDays: s.cycleDays, safetyLevel: s.safetyLevel, suppliers, locationsLeftOut: leftOut };
}

/** planBasis that never blocks a page (a failed read leaves the line out). */
export async function planBasisOrNull(shop: string): Promise<PlanBasis | null> {
  try {
    return await planBasis(shop);
  } catch {
    return null;
  }
}
