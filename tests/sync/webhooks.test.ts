/**
 * Data-sync webhooks (spec §6.5, task 1.2a): payload readers, the 60 s per-item debounce,
 * and the route handlers calling the catalog service (authenticate.webhook mocked).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STOCK_DEBOUNCE_MS,
  TrailingDebouncer,
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

describe("TrailingDebouncer (review M)", () => {
  it("first event schedules at the window end; later events coalesce; the LAST job runs", async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const d = new TrailingDebouncer(STOCK_DEBOUNCE_MS, (fn, ms) => timers.push({ fn, ms }));
    const ran: string[] = [];
    const k = debounceKey(S, "gid://shopify/InventoryItem/1");
    expect(d.schedule(k, async () => void ran.push("first"))).toBe("scheduled");
    expect(d.schedule(k, async () => void ran.push("second"))).toBe("coalesced");
    expect(d.schedule(k, async () => void ran.push("third"))).toBe("coalesced");
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(STOCK_DEBOUNCE_MS);
    expect(ran).toEqual([]); // nothing runs before the window ends
    timers[0].fn();
    await Promise.resolve();
    expect(ran).toEqual(["third"]);
    // An event after the refresh opens a new window, so a later change is never lost.
    expect(d.schedule(k, async () => void ran.push("fourth"))).toBe("scheduled");
    expect(timers).toHaveLength(2);
  });

  it("keys are independent per shop and item; a failing job never throws out of the timer", async () => {
    const timers: (() => void)[] = [];
    const d = new TrailingDebouncer(1000, (fn) => timers.push(fn));
    d.schedule("a|1", async () => {
      throw new Error("boom");
    });
    d.schedule("a|2", async () => {});
    d.schedule("b|1", async () => {});
    expect(d.size).toBe(3);
    expect(() => timers.forEach((t) => t())).not.toThrow();
    expect(d.size).toBe(0);
  });

  it("uses unref'd timers by default (never keeps the process alive)", () => {
    vi.useFakeTimers();
    try {
      const ran = vi.fn(async () => {});
      const d = new TrailingDebouncer(60_000);
      d.schedule("k", ran);
      vi.advanceTimersByTime(59_999);
      expect(ran).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(ran).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("webhook routes", () => {
  it("inventory_levels/update acks at once and refreshes once, after the window, with the latest state", async () => {
    vi.useFakeTimers();
    try {
      m.webhook.mockResolvedValue({ shop: S, topic: "INVENTORY_LEVELS_UPDATE", admin, payload: { inventory_item_id: 4242, location_id: 1 } });
      expect((await inventoryAction(req())).status).toBe(200);
      expect((await inventoryAction(req())).status).toBe(200);
      expect(m.refreshStock).not.toHaveBeenCalled(); // trailing: nothing yet
      await vi.advanceTimersByTimeAsync(STOCK_DEBOUNCE_MS);
      expect(m.refreshStock).toHaveBeenCalledTimes(1);
      expect(m.refreshStock).toHaveBeenCalledWith(admin, S, "gid://shopify/InventoryItem/4242");
      const logs = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
      expect(logs.some((l) => /scheduled, acked in \d+ms/.test(l))).toBe(true);
      expect(logs.some((l) => /coalesced, acked in \d+ms/.test(l))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("inventory_levels/update still acks 200 when the refresh fails or there is no session", async () => {
    vi.useFakeTimers();
    try {
      m.refreshStock.mockRejectedValueOnce(new Error("boom"));
      m.webhook.mockResolvedValue({ shop: S, topic: "INVENTORY_LEVELS_UPDATE", admin, payload: { inventory_item_id: 99 } });
      expect((await inventoryAction(req())).status).toBe(200);
      m.webhook.mockResolvedValue({ shop: S, topic: "INVENTORY_LEVELS_UPDATE", admin: undefined, payload: { inventory_item_id: 98 } });
      expect((await inventoryAction(req())).status).toBe(200);
      await vi.advanceTimersByTimeAsync(STOCK_DEBOUNCE_MS);
      expect(m.refreshStock).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
