/**
 * The store's primary language (shopLocales), read on its own and never fatal.
 *
 * `shopLocales` needs the `read_locales` scope (or `read_markets_home`). A store that installed
 * before the app asked for it, or hasn't approved the updated scopes yet, gets ACCESS_DENIED —
 * the Shopify library throws a GraphqlQueryError for it. That must not stop the shop read,
 * the backfill or an owner email, so every failure here returns null and the caller uses "en"
 * (or the language it already stored).
 */
import type { AdminGraphqlClient } from "../models/shop.server";
import { SHOP_LOCALE_QUERY, parsePrimaryLocale } from "../lib/sync/catalog-shared";

/** One warning per shop per process, so a missing scope doesn't flood the logs every tick. */
const warned = new Set<string>();

function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "unknown error";
  return msg.slice(0, 200);
}

/** Primary locale code of the store (e.g. "es", "pt-BR"); null when it can't be read. */
export async function readShopLocale(admin: AdminGraphqlClient, shop: string): Promise<string | null> {
  try {
    const res = await admin.graphql(SHOP_LOCALE_QUERY);
    const body = (await res.json()) as { data?: unknown; errors?: unknown } | null;
    const errors = Array.isArray(body?.errors) ? (body!.errors as Array<{ message?: unknown }>) : [];
    if (errors.length) throw new Error(errors.map((x) => (typeof x?.message === "string" ? x.message : "error")).join("; "));
    return parsePrimaryLocale(body?.data);
  } catch (e) {
    if (!warned.has(shop)) {
      warned.add(shop);
      console.warn(`[shop-locale] ${shop}: language not readable, falling back to the stored one or English (${reason(e)})`);
    }
    return null;
  }
}
