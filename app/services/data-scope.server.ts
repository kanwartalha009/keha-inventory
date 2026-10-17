/**
 * Which data an admin request reads (sample data mode, lib/sample-mode-shared): the store's own
 * rows, or — while "Explore with sample data" is on — the simulated store under `<shop>#sample`.
 * Every admin screen's loader and action reads `shop` from here instead of `session.shop`, so the
 * two never mix. Shopify calls, billing and Sidekick always use the real store (`realShop`).
 *
 * Reads one Shop row; any failure means the real store (sample data is never shown by mistake).
 */
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { SAMPLE_OFF, readSampleState, sampleKey, type SampleState } from "../lib/sample-mode-shared";

export type DataScope = {
  /** The data key every database read and write uses. */
  shop: string;
  /** The installed store (session.shop). */
  realShop: string;
  sample: boolean;
  state: SampleState;
};

export async function dataScope(realShop: string): Promise<DataScope> {
  try {
    const row = await prisma.shop.findUnique({ where: { domain: realShop }, select: { settings: true } });
    const state = readSampleState(row?.settings);
    return { shop: state.on ? sampleKey(realShop) : realShop, realShop, sample: state.on, state };
  } catch {
    return { shop: realShop, realShop, sample: false, state: SAMPLE_OFF };
  }
}

/** authenticate.admin plus the data scope: `shop` is the data key, `realShop` the store. */
export async function authenticateApp(request: Request) {
  const ctx = await authenticate.admin(request);
  const scope = await dataScope(ctx.session.shop);
  return { ...ctx, ...scope };
}

/** The JSON an action returns when it would change the store while sample data is shown (I-1). */
export function sampleBlocked<T extends Record<string, unknown>>(extra: T = {} as T) {
  return { ok: false as const, error: "sample" as const, ...extra };
}
