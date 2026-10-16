/**
 * Uninstall → 48h purge bookkeeping that auth code can use without importing
 * the GDPR service (which depends on shopify.server — keeps imports acyclic).
 */
import prisma from "../db.server";

const uninstalledShop = (
  prisma as unknown as {
    uninstalledShop: {
      deleteMany(a: { where: Record<string, unknown> }): Promise<{ count: number }>;
    };
  }
).uninstalledShop;

/**
 * Cancel a pending purge — the shop reinstalled. Without this, reinstalling
 * within 48h of an uninstall still had the shop's data (sessions included)
 * wiped by the purge job (2026-09-28). Already-purged rows are left as the
 * audit trail.
 */
export async function cancelPendingPurge(shop: string): Promise<number> {
  try {
    const r = await uninstalledShop.deleteMany({ where: { shop, purgedAt: null } });
    if (r.count) console.log(`[gdpr] pending purge cancelled for ${shop} (reinstalled)`);
    return r.count;
  } catch (e) {
    console.error("[gdpr] cancel purge failed", shop, e);
    return 0;
  }
}
