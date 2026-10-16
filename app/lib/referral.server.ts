import prisma from "../db.server";

/**
 * Agency referral capture (NovaReferral), keyed by shop so it survives the OAuth round-trip.
 * `storeReferral` is called by the /install landing BEFORE OAuth; `consumeReferral` is called once
 * in afterAuth to attribute the install, then the row is cleared.
 */

export async function storeReferral(shop: string, ref: string): Promise<void> {
  try {
    await prisma.novaReferral.upsert({
      where: { shop },
      update: { ref },
      create: { shop, ref },
    });
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
