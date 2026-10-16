/**
 * Is Keha Preorder installed on this store? (spec §4 J4 — the bridge links to
 * its new-preorder form only when it is; Shopify rule 2.2.6 forbids promoting
 * it otherwise.)
 *
 * Admin GraphQL `appByHandle(handle) { installation { id } }`: `installation`
 * is the app's installation on the current shop, null when not installed.
 * Cached per shop in memory for an hour (errors for 10 minutes) and never
 * blocks Home: a slow answer counts as "not installed" for this page view and
 * fills the cache for the next one. Any error → not installed.
 */
import type { AdminGraphqlClient } from "../models/shop.server";
import { KEHA_PREORDER_HANDLE } from "../lib/action-list-shared";

const TTL_MS = 60 * 60 * 1000;
const ERROR_TTL_MS = 10 * 60 * 1000;
/** Longest Home waits for the answer. */
export const PREORDER_CHECK_WAIT_MS = 1500;

const cache = new Map<string, { installed: boolean; until: number }>();
const inflight = new Map<string, Promise<boolean>>();

const APP_BY_HANDLE = `#graphql
  query KehaInvPreorderInstalled($handle: String!) {
    appByHandle(handle: $handle) { id installation { id } }
  }`;

async function ask(admin: AdminGraphqlClient, shop: string): Promise<boolean> {
  let installed = false;
  let ttl = ERROR_TTL_MS;
  try {
    const res = await admin.graphql(APP_BY_HANDLE, { variables: { handle: KEHA_PREORDER_HANDLE } });
    const body = (await res.json()) as {
      data?: { appByHandle?: { id: string; installation?: { id: string } | null } | null };
      errors?: unknown;
    };
    if (body.data && !body.errors) {
      installed = !!body.data.appByHandle?.installation?.id;
      ttl = TTL_MS;
    }
  } catch (e) {
    console.error("[keha-preorder] install check failed", shop, e);
  }
  cache.set(shop, { installed, until: Date.now() + ttl });
  return installed;
}

export async function kehaPreorderInstalled(
  admin: AdminGraphqlClient,
  shop: string,
  waitMs: number = PREORDER_CHECK_WAIT_MS,
): Promise<boolean> {
  const hit = cache.get(shop);
  if (hit && hit.until > Date.now()) return hit.installed;
  let p = inflight.get(shop);
  if (!p) {
    p = ask(admin, shop).finally(() => inflight.delete(shop));
    inflight.set(shop, p);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Tests only. */
export function _resetPreorderCache(): void {
  cache.clear();
  inflight.clear();
}
