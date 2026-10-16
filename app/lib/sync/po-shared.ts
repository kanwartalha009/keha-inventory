/**
 * Shopify purchase orders (Admin API 2026-10, read-only; spec §6.3, §5.3
 * "Open orders … marked From Shopify"). The queries and a defensive parser
 * that maps a PO to our PurchaseOrder row. Pure.
 *
 * Scopes: read_inventory_purchase_orders; the linked transfers need
 * read_inventory_transfers (covered by write_inventory_transfers).
 *
 * Lines map to our variants the way Phase 1 maps inventory items
 * (`inventoryItem.variants(first: 1)`, see catalog-shared itemVariantId).
 *
 * Status mapping (Shopify has DRAFT / ORDERED plus archivedAt; received units
 * come from the linked transfers):
 *   DRAFT, not archived                → draft
 *   ORDERED, received ≥ ordered (> 0)  → received
 *   ORDERED                            → sent
 *   archived with units received       → received
 *   archived with nothing received     → cancelled
 */
import { itemVariantId, toGid, type GqlInventoryItem } from "./catalog-shared";
import type { PoLine } from "../supplier-shared";
import type { PoStatus } from "../purchase-order-shared";

/** POs per page and lines per PO keep the requested query cost under 1000 points. */
export const PO_PAGE_SIZE = 5;
export const PO_LINE_PAGE_SIZE = 25;
/** Safety cap on pages per run (500 purchase orders). */
export const PO_MAX_PAGES = 100;

export const PURCHASE_ORDERS_QUERY = `#graphql
  query KehaInvPurchaseOrders($after: String) {
    inventoryPurchaseOrders(first: 5, after: $after) {
      nodes {
        id
        name
        status
        currency
        archivedAt
        orderedAt
        dateCreated
        origin { supplierName }
        lineItems(first: 25) {
          nodes {
            id
            title
            variantTitle
            supplierSku
            totalQuantity
            unitCost { amount currencyCode }
            inventoryItem { id sku variants(first: 1) { nodes { id } } }
          }
          pageInfo { hasNextPage endCursor }
        }
        transfers(first: 3) {
          nodes { status totalQuantity receivedQuantity }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/** The rest of one PO's lines (when it has more than a page). */
export const PURCHASE_ORDER_LINES_QUERY = `#graphql
  query KehaInvPurchaseOrderLines($id: ID!, $after: String) {
    inventoryPurchaseOrder(id: $id) {
      id
      lineItems(first: 100, after: $after) {
        nodes {
          id
          title
          variantTitle
          supplierSku
          totalQuantity
          unitCost { amount currencyCode }
          inventoryItem { id sku variants(first: 1) { nodes { id } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

export type GqlPoLine = {
  id?: unknown;
  title?: unknown;
  variantTitle?: unknown;
  supplierSku?: unknown;
  totalQuantity?: unknown;
  unitCost?: { amount?: unknown; currencyCode?: unknown } | null;
  inventoryItem?: (GqlInventoryItem & { sku?: unknown }) | null;
};

export type GqlPurchaseOrder = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  currency?: unknown;
  archivedAt?: unknown;
  orderedAt?: unknown;
  dateCreated?: unknown;
  origin?: { supplierName?: unknown } | null;
  lineItems?: { nodes?: GqlPoLine[] | null; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null } | null;
  transfers?: { nodes?: Array<{ status?: unknown; totalQuantity?: unknown; receivedQuantity?: unknown }> | null } | null;
};

export type ParsedShopifyPo = {
  shopifyPoId: string;
  number: string;
  status: PoStatus;
  /** Shopify's own status (DRAFT / ORDERED). */
  rawStatus: string | null;
  currency: string | null;
  supplierName: string | null;
  lines: PoLine[];
  /** Units received across the linked transfers. */
  receivedUnits: number;
  orderedUnits: number;
  orderedAt: Date | null;
  archived: boolean;
  /** More lines to read with PURCHASE_ORDER_LINES_QUERY. */
  moreLines: { after: string } | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);
const date = (v: unknown): Date | null => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

/** One Shopify PO line → our line (null when it no longer maps to a variant). */
export function parsePoLine(node: GqlPoLine | null | undefined, currency: string | null): PoLine | null {
  if (!node || typeof node !== "object") return null;
  const variantId = node.inventoryItem ? itemVariantId(node.inventoryItem) : undefined;
  if (!variantId) return null;
  const amount = Number(node.unitCost?.amount);
  const costCurrency = str(node.unitCost?.currencyCode);
  const unitCost =
    node.unitCost && Number.isFinite(amount) && amount >= 0 && (!currency || !costCurrency || costCurrency === currency) ? amount : null;
  return {
    variantId,
    qty: int(node.totalQuantity),
    unitCost,
    productTitle: str(node.title) ?? "",
    variantTitle: str(node.variantTitle) ?? "",
    sku: str(node.inventoryItem?.sku) ?? str(node.supplierSku),
  };
}

export function mapShopifyPoStatus(input: { status: unknown; archived: boolean; ordered: number; received: number }): PoStatus {
  if (input.archived) return input.received > 0 ? "received" : "cancelled";
  if (input.status === "DRAFT") return "draft";
  if (input.ordered > 0 && input.received >= input.ordered) return "received";
  return "sent";
}

/** One Shopify PO → our row; null when it has no usable id or name. */
export function parseShopifyPo(node: GqlPurchaseOrder | null | undefined): ParsedShopifyPo | null {
  if (!node || typeof node !== "object") return null;
  const shopifyPoId = toGid("InventoryPurchaseOrder", node.id);
  const number = str(node.name);
  if (!shopifyPoId || !number) return null;
  const currency = str(node.currency);
  const lines = (node.lineItems?.nodes ?? []).map((l) => parsePoLine(l, currency)).filter((l): l is PoLine => !!l);
  const receivedUnits = (node.transfers?.nodes ?? []).reduce((a, t) => a + int(t?.receivedQuantity), 0);
  const orderedUnits = lines.reduce((a, l) => a + l.qty, 0);
  const archived = date(node.archivedAt) !== null;
  const info = node.lineItems?.pageInfo;
  const after = info?.hasNextPage === true ? str(info.endCursor) : null;
  return {
    shopifyPoId,
    number: number.slice(0, 120),
    status: mapShopifyPoStatus({ status: node.status, archived, ordered: orderedUnits, received: receivedUnits }),
    rawStatus: str(node.status),
    currency,
    supplierName: str(node.origin?.supplierName)?.slice(0, 200) ?? null,
    lines,
    receivedUnits,
    orderedUnits,
    orderedAt: date(node.orderedAt) ?? date(node.dateCreated),
    archived,
    moreLines: after ? { after } : null,
  };
}

/** Adds more lines (from PURCHASE_ORDER_LINES_QUERY) and re-derives the status. */
export function withMoreLines(po: ParsedShopifyPo, extra: readonly PoLine[]): ParsedShopifyPo {
  const lines = [...po.lines, ...extra];
  const orderedUnits = lines.reduce((a, l) => a + l.qty, 0);
  return {
    ...po,
    lines,
    orderedUnits,
    status: mapShopifyPoStatus({ status: po.rawStatus, archived: po.archived, ordered: orderedUnits, received: po.receivedUnits }),
  };
}
