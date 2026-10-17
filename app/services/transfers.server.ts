/**
 * Create a stock transfer in Shopify from one line of the transfer plan (spec §4 J7, §6.4;
 * Pro `transfers`, scope write_inventory_transfers). Called only from the confirm dialog's
 * POST (invariant I-1: nothing changes the store without an explicit confirm).
 *
 *  1. The plan is re-read on the server; only variants of that origin → destination group
 *     are accepted, with the merchant's quantities (whole units, lines at 0 dropped). A
 *     quantity above the line's spare at the origin (net of pending Keha transfers) is
 *     refused ("over_spare"); nothing is created.
 *  2. Idempotency key = hash of (shop, origin, destination, posted lines, store-local day),
 *     checked BEFORE the plan is re-read (a stored transfer's units are pending, so the plan
 *     no longer proposes them): a retry or double click of the same plan reuses it. A Transfer
 *     row with that key → that transfer is returned and Shopify is not called again; otherwise Shopify's own
 *     `@idempotent` directive (required on inventoryTransferCreate since 2026-04) dedupes a
 *     request that reached Shopify but whose answer we lost.
 *  3. Inventory item ids come from Shopify at this moment (Variant has no inventoryItemId):
 *     nodes(ids:) → ProductVariant.inventoryItem.id.
 *  4. inventoryTransferCreate creates a DRAFT transfer: nothing moves until the merchant
 *     marks it ready to ship in Shopify. Shopify's user errors are returned to the dialog.
 */
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AdminGraphqlClient } from "../models/shop.server";
import { loadTransfers, recordTransfer, shopDayContext, transferByKey } from "../models/transfers.server";
import { toSupportedLocale, translate } from "../lib/i18n";
import { todayIn } from "../lib/dashboard-shared";
import {
  linesOverSpare,
  transferAdminHref,
  transferGroupKey,
  transferKeyMaterial,
  transferUserErrors,
  uuidFromHex,
  type StoredTransferLine,
} from "../lib/transfers-shared";

const VARIANT_ITEMS_QUERY = `#graphql
  query KehaInvTransferItems($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        inventoryItem { id }
      }
    }
  }`;

const TRANSFER_CREATE = `#graphql
  mutation KehaInvTransferCreate($input: InventoryTransferCreateInput!, $idempotencyKey: String!) {
    inventoryTransferCreate(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryTransfer { id name status }
      userErrors { field message code }
    }
  }`;

const NODES_PAGE = 250;

export type CreateTransferResult =
  | { ok: true; id: string; name: string | null; href: string; existing: boolean }
  | { ok: false; error: "gone" | "empty" | "failed" }
  /** More than the plan's spare at the warehouse for these variants: nothing was created. */
  | { ok: false; error: "over_spare"; variantIds: string[] }
  | { ok: false; error: "shopify"; userErrors: string[] };

export function idempotencyKeyFor(material: string): string {
  return uuidFromHex(crypto.createHash("sha256").update(material).digest("hex"));
}

/** Variant gid → inventory item gid, read from Shopify now. Missing variants are left out. */
export async function inventoryItemIds(admin: AdminGraphqlClient, variantIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < variantIds.length; i += NODES_PAGE) {
    const res = await admin.graphql(VARIANT_ITEMS_QUERY, { variables: { ids: variantIds.slice(i, i + NODES_PAGE) } });
    const body = (await res.json()) as { data?: { nodes?: ({ id?: string; inventoryItem?: { id?: string } | null } | null)[] } };
    for (const n of body.data?.nodes ?? []) if (n?.id && n.inventoryItem?.id) out.set(n.id, n.inventoryItem.id);
  }
  return out;
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export async function createTransfer(
  admin: AdminGraphqlClient,
  shop: string,
  input: { originId: string; destinationId: string; quantities: Record<string, number> },
  now: Date = new Date(),
): Promise<CreateTransferResult> {
  // The retry check comes first: once a transfer is stored, its units are pending and the
  // re-read plan no longer proposes them, so a retry must be answered from the key alone.
  const posted = Object.entries(input.quantities)
    .filter(([, q]) => Number.isInteger(q) && q > 0)
    .map(([variantId, qty]) => ({ variantId, qty }));
  const ctx = await shopDayContext(shop);
  const key = idempotencyKeyFor(transferKeyMaterial(shop, input.originId, input.destinationId, posted, todayIn(ctx.timezone, now)));
  const done = await transferByKey(shop, key);
  if (done) return { ok: true, id: done.shopifyTransferId, name: null, href: transferAdminHref(done.shopifyTransferId), existing: true };

  const plan = await loadTransfers(shop, now);
  const group = plan.groups.find((g) => g.key === transferGroupKey(input.originId, input.destinationId));
  if (!group) return { ok: false, error: "gone" };
  const lines = group.lines
    .map((l) => ({ ...l, qty: input.quantities[l.variantId] ?? 0 }))
    .filter((l) => Number.isInteger(l.qty) && l.qty > 0);
  if (!lines.length) return { ok: false, error: "empty" };
  // Never more than the plan's spare (re-read now, net of pending Keha transfers): refuse, so
  // the store only ever gets what the merchant confirmed (I-1) and never more than can go.
  const over = linesOverSpare(lines);
  if (over.length) return { ok: false, error: "over_spare", variantIds: over };

  const items = await inventoryItemIds(
    admin,
    lines.map((l) => l.variantId),
  );
  if (lines.some((l) => !items.has(l.variantId))) return { ok: false, error: "gone" };

  const locale = toSupportedLocale(ctx.locale);
  const note = translate(locale, "Planned with Keha Inventory Planner.");
  const res = await admin.graphql(TRANSFER_CREATE, {
    variables: {
      idempotencyKey: key,
      input: {
        originLocationId: group.originId,
        destinationLocationId: group.destinationId,
        lineItems: lines.map((l) => ({ inventoryItemId: items.get(l.variantId)!, quantity: l.qty })),
        note,
      },
    },
  });
  const body = (await res.json()) as {
    data?: { inventoryTransferCreate?: { inventoryTransfer?: { id?: string; name?: string } | null; userErrors?: unknown } | null };
    errors?: { message?: string }[];
  };
  const payload = body.data?.inventoryTransferCreate;
  const userErrors = transferUserErrors(payload?.userErrors);
  if (userErrors.length) return { ok: false, error: "shopify", userErrors };
  const created = payload?.inventoryTransfer;
  if (!created?.id) {
    const top = (body.errors ?? []).map((e) => String(e?.message ?? "")).filter(Boolean);
    return top.length ? { ok: false, error: "shopify", userErrors: top } : { ok: false, error: "failed" };
  }

  const stored: StoredTransferLine[] = lines.map((l) => ({
    variantId: l.variantId,
    inventoryItemId: items.get(l.variantId)!,
    quantity: l.qty,
    productTitle: l.productTitle,
    variantTitle: l.variantTitle,
  }));
  try {
    await recordTransfer(shop, {
      shopifyTransferId: created.id,
      originLocationId: group.originId,
      destinationLocationId: group.destinationId,
      lines: stored,
      idempotencyKey: key,
    });
  } catch (e) {
    // A parallel request with the same key stored it first: same transfer (Shopify deduped it).
    if (!isUniqueViolation(e)) throw e;
  }
  return { ok: true, id: created.id, name: created.name ?? null, href: transferAdminHref(created.id), existing: false };
}
