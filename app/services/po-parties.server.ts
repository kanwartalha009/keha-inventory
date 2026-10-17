/**
 * The buyer and ship-to blocks of a purchase order (merchant audit 2026-10-18), read with the
 * shop's offline token: the store's legal name (Shopify's company name in Settings → Store details,
 * else the store name) and address, and the chosen location's name and address. Cached per shop /
 * location for an hour. Never throws — null when Shopify can't be read (the document is still made,
 * without the block).
 */
import { unauthenticated } from "../shopify.server";
import type { PoParty } from "../lib/po-document-shared";

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: PoParty | null }>();

const PO_BUYER = `#graphql
  query KehaInvPoBuyer { shop { name shopAddress { company formatted(withCompany: false) } } }`;

const PO_SHIP_TO = `#graphql
  query KehaInvPoShipTo($id: ID!) { location(id: $id) { name address { formatted } } }`;

type Gql = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

async function cached(key: string, read: () => Promise<PoParty | null>): Promise<PoParty | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: PoParty | null = null;
  try {
    value = await read();
  } catch (e) {
    console.error("[po-parties] read failed", key, e);
  }
  // Only successes are cached — a failed read is retried on the next document.
  if (value) cache.set(key, { at: Date.now(), value });
  return value;
}

async function admin(shop: string): Promise<Gql> {
  return (await unauthenticated.admin(shop)).admin as unknown as Gql;
}

/** The store as the buyer: legal (company) name, else the store name, and its address. */
export function poBuyer(shop: string): Promise<PoParty | null> {
  return cached(`buyer:${shop}`, async () => {
    const res = await (await admin(shop)).graphql(PO_BUYER);
    const body = (await res.json()) as { data?: { shop?: { name?: string; shopAddress?: { company?: string | null; formatted?: string[] } | null } } };
    const s = body.data?.shop;
    if (!s) return null;
    const name = (s.shopAddress?.company || s.name || "").trim();
    return name ? { name, lines: (s.shopAddress?.formatted ?? []).filter(Boolean) } : null;
  });
}

/** A location as the ship-to block (name and address); null when Shopify doesn't know it. */
export function poShipTo(shop: string, locationId: string): Promise<PoParty | null> {
  return cached(`loc:${shop}:${locationId}`, async () => {
    const res = await (await admin(shop)).graphql(PO_SHIP_TO, { variables: { id: locationId } });
    const body = (await res.json()) as { data?: { location?: { name?: string; address?: { formatted?: string[] } | null } | null } };
    const l = body.data?.location;
    if (!l?.name) return null;
    return { name: l.name, lines: (l.address?.formatted ?? []).filter(Boolean) };
  });
}
