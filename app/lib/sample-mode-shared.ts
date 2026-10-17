/**
 * Sample data mode (owner 2026-10-17): "Explore Keha with sample data" loads a simulated store
 * (lib/sim) under its own data key, `<shop>#sample`, so it never mixes with the store's own rows —
 * every table is keyed by `shop`, and the sample's rows carry the sample key instead. Pure.
 *
 *  - The real Shop row's settings hold the switch (`sampleData`), so turning it on or off is one
 *    write and every screen reads the same answer (services/data-scope.server).
 *  - Sample ids are numeric Shopify-style gids in a reserved range (17 digits starting with 99):
 *    the screens' id handling keeps working, and they can never be a real store's ids.
 *  - Plans: sample data shows at least the Growth plan's features, so the merchant sees the whole
 *    product (a note says so); a Pro store keeps Pro.
 */
import { hash32 } from "./sim/rng-shared";
import type { PlanCode } from "./plan-shared";

export const SAMPLE_SUFFIX = "#sample";

/** The data key of a store's sample data. */
export function sampleKey(shop: string): string {
  return isSampleKey(shop) ? shop : `${shop}${SAMPLE_SUFFIX}`;
}

export function isSampleKey(shop: string | null | undefined): boolean {
  return typeof shop === "string" && shop.endsWith(SAMPLE_SUFFIX);
}

/** The store a data key belongs to (the key itself when it isn't a sample key). */
export function realShopOf(key: string): string {
  return isSampleKey(key) ? key.slice(0, -SAMPLE_SUFFIX.length) : key;
}

/** What sample data shows: at least Growth (Pro stays Pro). */
export function samplePlan(real: PlanCode | "none"): PlanCode {
  return real === "pro" ? "pro" : "growth";
}

export type SampleState = {
  on: boolean;
  /** When the sample store was generated (ISO). */
  loadedAt: string | null;
  /** The digits every sample id starts with. */
  idPrefix: string | null;
};

export const SAMPLE_OFF: SampleState = { on: false, loadedAt: null, idPrefix: null };

/** Shop.settings.sampleData, read defensively (anything malformed = off). */
export function readSampleState(settings: unknown): SampleState {
  const s = settings && typeof settings === "object" ? (settings as Record<string, unknown>).sampleData : null;
  if (!s || typeof s !== "object") return SAMPLE_OFF;
  const x = s as Record<string, unknown>;
  return {
    on: x.on === true,
    loadedAt: typeof x.loadedAt === "string" ? x.loadedAt : null,
    idPrefix: typeof x.idPrefix === "string" && /^\d{1,12}$/.test(x.idPrefix) ? x.idPrefix : null,
  };
}

/**
 * The id prefix of a store's sample data: "99" + 8 digits from the store (and a salt, bumped when
 * another store's sample already uses the prefix). With 7-digit counters every id has 17 digits;
 * Shopify's own ids have 14 today.
 */
export function sampleIdPrefix(shop: string, salt = 0): string {
  return `99${String(hash32(`${realShopOf(shop)}:${salt}`) % 100_000_000).padStart(8, "0")}`;
}

/** Sample data older than this offers a refresh (its dates drift from today). */
export const SAMPLE_STALE_MS = 3 * 24 * 60 * 60 * 1000;

export function sampleIsStale(state: SampleState, now: Date): boolean {
  if (!state.on || !state.loadedAt) return false;
  const t = Date.parse(state.loadedAt);
  return Number.isFinite(t) && now.getTime() - t > SAMPLE_STALE_MS;
}

/** Store states in which the Dashboard offers sample data (the order plan can't be shown yet). */
export function offerSample(state: string): boolean {
  return state === "syncing" || state === "noSales" || state === "noTracked";
}
