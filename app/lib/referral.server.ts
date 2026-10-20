import prisma from "../db.server";

/**
 * Agency referral capture (NovaReferral), keyed by shop so it survives the OAuth round-trip.
 * `storeReferral` is called by the /install landing BEFORE OAuth; `consumeReferral` is called once
 * in afterAuth to attribute the install, then the row is cleared.
 */

/** A stored code older than this can be replaced by a newer partner link (the first one lapsed). */
export const REFERRAL_KEEP_DAYS = 30;

/**
 * The FIRST partner's code wins (post-approval backlog C7): anyone opening another partner's link
 * for the same shop used to overwrite it. A code older than REFERRAL_KEEP_DAYS has lapsed and can
 * be replaced. Never throws: a referral must not block the install.
 */
export async function storeReferral(shop: string, ref: string, now: Date = new Date()): Promise<void> {
  try {
    const existing = await prisma.novaReferral.findUnique({ where: { shop } });
    if (!existing) {
      await prisma.novaReferral.create({ data: { shop, ref } });
      return;
    }
    if (existing.ref === ref) return;
    const ageDays = (now.getTime() - new Date(existing.createdAt).getTime()) / 86_400_000;
    if (ageDays <= REFERRAL_KEEP_DAYS) return;
    await prisma.novaReferral.update({ where: { shop }, data: { ref, createdAt: now } });
  } catch (err) {
    console.error("[inventory/referral] storeReferral failed", err);
  }
}

export async function consumeReferral(shop: string): Promise<string | null> {
  try {
    const row = await prisma.novaReferral.findUnique({ where: { shop } });
    if (!row) return null;
    await prisma.novaReferral.delete({ where: { shop } }).catch(() => {});
    return row.ref;
  } catch (err) {
    console.error("[inventory/referral] consumeReferral failed", err);
    return null;
  }
}
