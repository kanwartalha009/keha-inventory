/**
 * First-session measurement (clarity pass 2026-10-23, Kanwar: "judge the redesign with numbers"):
 * the first time each shop installed, saw its plan on the Dashboard, saw order suggestions on Due
 * now, and created a purchase order. One row per (shop, step), written once; sample data never
 * counts. Never throws — measuring must not break a page.
 */
import prisma from "../db.server";
import { ACTIVATION_STEPS, activationSummary, type ActivationStep, type ActivationSummary } from "../lib/activation-shared";

/** Steps already written by this process — pages load often, the row is written once. */
const seen = new Set<string>();

export async function recordActivation(shop: string, kind: ActivationStep, at: Date = new Date()): Promise<void> {
  if (!shop || shop.includes("#")) return; // sample data (`<shop>#sample`) isn't a merchant's first session
  const key = `${shop}|${kind}`;
  if (seen.has(key)) return;
  try {
    await prisma.activationEvent.createMany({ data: [{ shop, kind, at }], skipDuplicates: true });
    seen.add(key);
  } catch (e) {
    console.error("[activation] record failed", shop, kind, e);
  }
}

/** Counts per step and the median minutes from install to each later step (/health). */
export async function readActivation(): Promise<ActivationSummary | null> {
  try {
    const rows = await prisma.activationEvent.findMany({ where: { kind: { in: [...ACTIVATION_STEPS] } }, select: { shop: true, kind: true, at: true } });
    return activationSummary(rows);
  } catch {
    return null;
  }
}
