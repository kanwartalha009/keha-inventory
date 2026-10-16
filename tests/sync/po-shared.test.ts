/** Shopify purchase orders → PurchaseOrder rows (spec §6.3, §5.3 "From Shopify"). */
import { describe, expect, it } from "vitest";
import {
  PO_LINE_PAGE_SIZE,
  PO_PAGE_SIZE,
  PURCHASE_ORDERS_QUERY,
  mapShopifyPoStatus,
  parsePoLine,
  parseShopifyPo,
  withMoreLines,
  type GqlPurchaseOrder,
} from "../../app/lib/sync/po-shared";

const lineNode = (n: number, qty: number, over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/InventoryPurchaseOrderLineItem/${n}`,
  title: `Shirt ${n}`,
  variantTitle: "M",
  supplierSku: `SUP-${n}`,
  totalQuantity: qty,
  unitCost: { amount: "2.50", currencyCode: "EUR" },
  inventoryItem: { id: `gid://shopify/InventoryItem/${n}`, sku: `SKU-${n}`, variants: { nodes: [{ id: `gid://shopify/ProductVariant/${n}` }] } },
  ...over,
});

const po = (over: Partial<GqlPurchaseOrder> = {}): GqlPurchaseOrder => ({
  id: "gid://shopify/InventoryPurchaseOrder/7",
  name: "#PO7",
  status: "ORDERED",
  currency: "EUR",
  archivedAt: null,
  orderedAt: "2026-10-01T09:00:00Z",
  dateCreated: "2026-09-30T09:00:00Z",
  origin: { supplierName: "Acme Textiles" },
  lineItems: { nodes: [lineNode(1, 10), lineNode(2, 5)], pageInfo: { hasNextPage: false, endCursor: null } },
  transfers: { nodes: [{ status: "IN_PROGRESS", totalQuantity: 15, receivedQuantity: 4 }] },
  ...over,
});

describe("parseShopifyPo", () => {
  it("maps id, name, supplier, currency and lines to our variants", () => {
    const r = parseShopifyPo(po())!;
    expect(r).toMatchObject({
      shopifyPoId: "gid://shopify/InventoryPurchaseOrder/7",
      number: "#PO7",
      status: "sent",
      rawStatus: "ORDERED",
      currency: "EUR",
      supplierName: "Acme Textiles",
      orderedUnits: 15,
      receivedUnits: 4,
      archived: false,
      moreLines: null,
    });
    expect(r.orderedAt?.toISOString()).toBe("2026-10-01T09:00:00.000Z");
    expect(r.lines[0]).toEqual({
      variantId: "gid://shopify/ProductVariant/1",
      qty: 10,
      unitCost: 2.5,
      productTitle: "Shirt 1",
      variantTitle: "M",
      sku: "SKU-1",
    });
  });

  it("drops lines that no longer map to a variant, and costs in another currency", () => {
    const r = parseShopifyPo(
      po({
        lineItems: {
          nodes: [lineNode(1, 10, { inventoryItem: null }), lineNode(2, 5, { unitCost: { amount: "3", currencyCode: "USD" } })],
          pageInfo: { hasNextPage: true, endCursor: "c1" },
        },
      }),
    )!;
    expect(r.lines.map((l) => [l.variantId, l.unitCost])).toEqual([["gid://shopify/ProductVariant/2", null]]);
    expect(r.moreLines).toEqual({ after: "c1" });
    const more = withMoreLines(r, [parsePoLine(lineNode(3, 20), "EUR")!]);
    expect(more.lines).toHaveLength(2);
    expect(more.orderedUnits).toBe(25);
  });

  it("refuses nodes without an id or a name", () => {
    expect(parseShopifyPo(po({ id: "nope" }))).toBeNull();
    expect(parseShopifyPo(po({ name: "" }))).toBeNull();
    expect(parseShopifyPo(null)).toBeNull();
  });
});

describe("mapShopifyPoStatus", () => {
  it("maps Shopify's DRAFT / ORDERED / archived to ours", () => {
    expect(mapShopifyPoStatus({ status: "DRAFT", archived: false, ordered: 10, received: 0 })).toBe("draft");
    expect(mapShopifyPoStatus({ status: "ORDERED", archived: false, ordered: 10, received: 3 })).toBe("sent");
    expect(mapShopifyPoStatus({ status: "ORDERED", archived: false, ordered: 10, received: 10 })).toBe("received");
    expect(mapShopifyPoStatus({ status: "ORDERED", archived: true, ordered: 10, received: 2 })).toBe("received");
    expect(mapShopifyPoStatus({ status: "DRAFT", archived: true, ordered: 10, received: 0 })).toBe("cancelled");
    expect(mapShopifyPoStatus({ status: "ORDERED", archived: false, ordered: 0, received: 0 })).toBe("sent");
  });
});

describe("PURCHASE_ORDERS_QUERY", () => {
  it("uses the page sizes that keep the requested cost under 1000 points, and no private fields", () => {
    expect(PURCHASE_ORDERS_QUERY).toContain(`inventoryPurchaseOrders(first: ${PO_PAGE_SIZE}`);
    expect(PURCHASE_ORDERS_QUERY).toContain(`lineItems(first: ${PO_LINE_PAGE_SIZE})`);
    expect(PURCHASE_ORDERS_QUERY).not.toContain("referenceName");
    // 5 orders × (1 + origin 1 + lines (2 + 25 × 6) + transfers (2 + 3)) + 2 ≈ 797
    const lineCost = 1 + 1 + 1 + (2 + 1);
    expect(PO_PAGE_SIZE * (1 + 1 + (2 + PO_LINE_PAGE_SIZE * lineCost) + (2 + 3)) + 2).toBeLessThan(1000);
  });
});
