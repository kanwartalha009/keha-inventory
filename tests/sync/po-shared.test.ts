/** Shopify purchase orders → PurchaseOrder rows (spec §6.3, §5.3 "Shopify PO"). */
import { describe, expect, it } from "vitest";
import {
  PO_LINE_PAGE_SIZE,
  PO_PAGE_SIZE,
  PO_QUERY_COST_ESTIMATE,
  PO_TRANSFER_PAGE_SIZE,
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
    expect(PURCHASE_ORDERS_QUERY).toContain(`transfers(first: ${PO_TRANSFER_PAGE_SIZE})`);
    // 2 + 5 orders × (1 + origin 1 + lines (2 + 25 × 6 + pageInfo 1) + transfers (2 + 25 + pageInfo 1)) + pageInfo 1 = 918
    const lineCost = 1 + 1 + 1 + (2 + 1);
    const estimate = 2 + PO_PAGE_SIZE * (1 + 1 + (2 + PO_LINE_PAGE_SIZE * lineCost + 1) + (2 + PO_TRANSFER_PAGE_SIZE + 1)) + 1;
    expect(estimate).toBe(PO_QUERY_COST_ESTIMATE);
    expect(PO_QUERY_COST_ESTIMATE).toBe(918);
    expect(PO_QUERY_COST_ESTIMATE).toBeLessThan(1000);
    expect(PO_TRANSFER_PAGE_SIZE).toBeGreaterThan(3);
  });
});

describe("linked transfers beyond one read (review fix 2026-10-17)", () => {
  const many = { nodes: [{ status: "RECEIVED", totalQuantity: 15, receivedQuantity: 15 }], pageInfo: { hasNextPage: true } };
  it("an open PO whose transfers didn't fit is flagged partially read and stays open, never received", () => {
    const r = parseShopifyPo(po({ transfers: many }))!;
    expect(r.transfersCapped).toBe(true);
    expect(r.receivedUnits).toBe(15);
    expect(r.status).toBe("sent"); // 15 of 15 received in what was read, but more transfers exist
    expect(withMoreLines(r, []).status).toBe("sent");
    expect(mapShopifyPoStatus({ status: "ORDERED", archived: false, ordered: 10, received: 10, partial: true })).toBe("sent");
  });
  it("a complete read still closes it; an archived PO keeps its own mapping", () => {
    const full = parseShopifyPo(po({ transfers: { ...many, pageInfo: { hasNextPage: false } } }))!;
    expect(full.transfersCapped).toBe(false);
    expect(full.status).toBe("received");
    expect(parseShopifyPo(po({ transfers: many, archivedAt: "2026-10-10T00:00:00Z" }))!.status).toBe("received");
  });
});
