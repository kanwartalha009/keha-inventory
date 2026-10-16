/**
 * Data-sync webhooks (spec §6.5, task 1.2a): payload readers, the 60 s per-item debounce,
 * and the route handlers calling the catalog service (authenticate.webhook mocked).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Debouncer,
  STOCK_DEBOUNCE_MS,
  debounceKey,
  inventoryItemFromPayload,
  locationIdFromPayload,
  productIdFromPayload,
} from "../../app/lib/sync/webhook-shared";

const m = vi.hoisted(() => ({
  webhook: vi.fn(),
  refreshStock: vi.fn(async () => 2),
  syncProduct: vi.fn(async () => 3),
  deleteProduct: vi.fn(async () => 1),
  refreshLocation: vi.fn(async () => true),
  deleteLocation: vi.fn(async () => {}),
}));
vi.mock("../../app/shopify.server", () => ({ authenticate: { webhook: m.webhook } }));
vi.mock("../../app/services/sync/catalog.server", () => ({
  refreshStockForInventoryItem: m.refreshStock,
  syncProduct: m.syncProduct,
  deleteProduct: m.deleteProduct,
  refreshLocation: m.refreshLocation,
  deleteLocation: m.deleteLocation,
}));

import { action as inventoryAction } from "../../app/routes/webhooks.inventory_levels.update";
import { action as productUpdate } from "../../app/routes/webhooks.products.update";
import { action as productDelete } from "../../app/routes/webhooks.products.delete";
import { action as locationCreate } from "../../app/routes/webhooks.locations.create";
import { action as locationUpdate } from "../../app/routes/webhooks.locations.update";
import { action as locationDelete } from "../../app/routes/webhooks.locations.delete";

const S = "acme.myshopify.com";
const admin = { graphql: vi.fn() };
const req = () => ({ request: new Request("https://app/webhooks", { method: "POST" }), params: {}, context: {} }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("payload readers", () => {
  it("read REST-shaped ids into gids", () => {
    expect(inventoryItemFromPayload({ inventory_item_id: 271878346596884, location_id: 1 })).toBe("gid://shopify/InventoryItem/271878346596884");
    expect(inventoryItemFromPayload({})).toBeUndefined();
    expect(productIdFromPayload({ id: 788032119674292900 })).toBeUndefined(); // unsafe integer: refused, never rounded
    expect(productIdFromPayload({ id: 7880321196 })).toBe("gid://shopify/Product/7880321196");
    expect(productIdFromPayload({ admin_graphql_api_id: "gid://shopify/Product/9", id: 1 })).toBe("gid://shopify/Product/9");
    expect(locationIdFromPayload({ id: "55" })).toBe("gid://shopify/Location/55");
    expect(locationIdFromPayload(null)).toBeUndefined();
  });
});

describe("Debouncer", () => {
  it("runs once per key per 60 s window", () => {
    const d = new Debouncer();
    const k = debounceKey(S, "gid://shopify/InventoryItem/1");
    expect(d.shouldRun(k, 0)).toBe(true);
    expect(d.shouldRun(k, STOCK_DEBOUNCE_MS - 1)).toBe(false);
    expect(d.shouldRun(debounceKey(S, "gid://shopify/InventoryItem/2"), 10)).toBe(true);
    expect(d.shouldRun(debounceKey("b.myshopify.com", "gid://shopify/InventoryItem/1"), 10)).toBe(true);
    expect(d.shouldRun(k, STOCK_DEBOUNCE_MS)).toBe(true);
  });

  it("prunes stale entries when it grows past its cap", () => {
    const d = new Debouncer(1000, 3);
    for (let i = 0; i < 3; i++) d.shouldRun(`k${i}`, 0);
    d.shouldRun("k3", 5000);
    expect(d.size).toBe(1);
  });
});

describe("webhook routes", () => {
  it("inventory_levels/update refreshes one item, then debounces repeats", async () => {
    m.webhook.mockResolvedValue({ shop: S, topic: "INVENTORY_LEVELS_UPDATE", admin, payload: { inventory_item_id: 4242, location_id: 1 } });
    expect((await inventoryAction(req())).status).toBe(200);
    expect((await inventoryAction(req())).status).toBe(200);
    expect(m.refreshStock).toHaveBeenCalledTimes(1);
    expect(m.refreshStock).toHaveBeenCalledWith(admin, S, "gid://shopify/InventoryItem/4242");
    expect(vi.mocked(console.log).mock.calls.map((c) => String(c[0])).some((l) => /debounced, acked in \d+ms/.test(l))).toBe(true);
  });

  it("inventory_levels/update still acks 200 when the refresh fails or there is no session", async () => {
    m.refreshStock.mockRejectedValueOnce(new Error("boom"));
    m.webhook.mockResolvedValue({ shop: S, topic: "INVENTORY_LEVELS_UPDATE", admin, payload: { inventory_item_id: 99 } });
    expect((await inventoryAction(req())).status).toBe(200);
    m.webhook.mockResolvedValue({ shop: S, topic: "INVENTORY_LEVELS_UPDATE", admin: undefined, payload: { inventory_item_id: 98 } });
    expect((await inventoryAction(req())).status).toBe(200);
    expect(m.refreshStock).toHaveBeenCalledTimes(1);
  });

  it("products/update re-reads the product", async () => {
    m.webhook.mockResolvedValue({ shop: S, topic: "PRODUCTS_UPDATE", admin, payload: { id: 7, admin_graphql_api_id: "gid://shopify/Product/7" } });
    expect((await productUpdate(req())).status).toBe(200);
    expect(m.syncProduct).toHaveBeenCalledWith(admin, S, "gid://shopify/Product/7");
  });

  it("products/delete removes the product's rows; a DB failure asks Shopify to retry", async () => {
    m.webhook.mockResolvedValue({ shop: S, topic: "PRODUCTS_DELETE", payload: { id: 7 } });
    expect((await productDelete(req())).status).toBe(200);
    expect(m.deleteProduct).toHaveBeenCalledWith(S, "gid://shopify/Product/7");
    m.deleteProduct.mockRejectedValueOnce(new Error("db down"));
    expect((await productDelete(req())).status).toBe(500);
  });

  it("locations/create and update re-read the location; delete removes it", async () => {
    m.webhook.mockResolvedValue({ shop: S, topic: "LOCATIONS_CREATE", admin, payload: { id: 5, name: "Pop-up" } });
    await locationCreate(req());
    await locationUpdate(req());
    expect(m.refreshLocation).toHaveBeenCalledTimes(2);
    expect(m.refreshLocation).toHaveBeenCalledWith(admin, S, "gid://shopify/Location/5");
    m.webhook.mockResolvedValue({ shop: S, topic: "LOCATIONS_DELETE", payload: { id: 5 } });
    expect((await locationDelete(req())).status).toBe(200);
    expect(m.deleteLocation).toHaveBeenCalledWith(S, "gid://shopify/Location/5");
  });
});
