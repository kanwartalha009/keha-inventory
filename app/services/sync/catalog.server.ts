/**
 * Catalog, locations, stock now and the Shop row (spec §6.3, task 1.3).
 *
 *  - syncCatalog:   one bulk operation (bulkOperationRunQuery, groupObjects: false), polled with
 *                   bulkOperation(id) (currentBulkOperation is deprecated since 2026-01), JSONL
 *                   downloaded and parsed by catalog-shared → Variant upserts. Variants of this
 *                   shop missing from a COMPLETED run are removed (with their StockNow /
 *                   VariantMetric rows): the bulk result is the full catalog.
 *  - syncLocations: locations(includeInactive) → Location upserts; `role` is never overwritten.
 *  - syncStockNow:  inventoryItems → inventoryLevels, paginated → StockNow upserts; rows not
 *                   seen in a complete run are removed.
 *  - refreshStockForInventoryItem: one item (inventory_levels/update webhook).
 *  - syncProduct / deleteProduct: products/update and products/delete webhooks.
 *  - ensureShop:    shop + shopLocales → Shop upsert (domain = the myshopify domain we hold).
 *
 * `sleep`, `fetch` and `now` are injectable so tests never wait or hit the network.
 */
import prisma from "../../db.server";
import type { AdminGraphqlClient } from "../../models/shop.server";
import {
  BULK_RUN_MUTATION,
  BULK_STATUS_QUERY,
  CATALOG_BULK_QUERY,
  LOCATIONS_QUERY,
  LOCATION_QUERY,
  PRODUCT_QUERY,
  SHOP_QUERY,
  STOCK_ITEM_QUERY,
  STOCK_PAGE_QUERY,
  itemVariantId,
  levelRows,
  parseCatalogJsonl,
  parseShopInfo,
  stockPageSizes,
  toGid,
  toLocationRow,
  toVariantRow,
  type GqlInventoryItem,
  type GqlProductNode,
  type GqlVariantNode,
  type LocationRow,
  type ShopInfo,
  type StockLevelRow,
  type VariantRow,
} from "../../lib/sync/catalog-shared";

export * from "../../lib/sync/catalog-shared";

export type SyncDeps = {
  sleep?: (ms: number) => Promise<void>;
  fetch?: (url: string) => Promise<Response>;
  now?: () => number;
  /** Poll interval for the bulk operation (default 3 s). */
  pollMs?: number;
  /** Give up on a bulk operation after this long (default 30 min). */
  timeoutMs?: number;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const WRITE_BATCH = 200;

export class AdminQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminQueryError";
  }
}

/** Runs one Admin GraphQL operation and returns `data`; throws on HTTP or GraphQL errors. */
export async function gql<T>(admin: AdminGraphqlClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  let body: { data?: T; errors?: unknown } | null = null;
  try {
    body = (await res.json()) as { data?: T; errors?: unknown };
  } catch {
    body = null;
  }
  if (!res.ok) throw new AdminQueryError(`Admin API HTTP ${res.status}`);
  const errors = Array.isArray(body?.errors) ? (body!.errors as Array<{ message?: unknown }>) : [];
  if (errors.length) {
    throw new AdminQueryError(errors.map((e) => (typeof e?.message === "string" ? e.message : "error")).join("; "));
  }
  if (!body?.data) throw new AdminQueryError("Admin API response has no data");
  return body.data;
}

async function inBatches<T>(items: T[], size: number, write: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await write(items.slice(i, i + size));
}

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

/** Reads shop + shopLocales and upserts the Shop row. A reinstall clears uninstalledAt. */
export async function ensureShop(admin: AdminGraphqlClient, shop: string): Promise<ShopInfo> {
  const info = parseShopInfo(await gql(admin, SHOP_QUERY));
  await prisma.shop.upsert({
    where: { domain: shop },
    create: { domain: shop, currency: info.currency, timezone: info.timezone, locale: info.locale },
    update: { currency: info.currency, timezone: info.timezone, locale: info.locale, uninstalledAt: null },
  });
  return info;
}

// ---------------------------------------------------------------------------
// Bulk operation
// ---------------------------------------------------------------------------

type BulkStatus = {
  id: string;
  status: string;
  errorCode?: string | null;
  objectCount?: string | number | null;
  url?: string | null;
  partialDataUrl?: string | null;
};

export class BulkOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkOperationError";
  }
}

/** Starts a bulk query, waits for it, downloads the JSONL. "" when the result is empty. */
export async function runBulkQuery(admin: AdminGraphqlClient, query: string, deps: SyncDeps = {}): Promise<string> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? ((url: string) => fetch(url));
  const pollMs = deps.pollMs ?? 3000;
  const timeoutMs = deps.timeoutMs ?? 30 * 60 * 1000;

  const started = await gql<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, BULK_RUN_MUTATION, { query });
  const run = started.bulkOperationRunQuery;
  if (run.userErrors.length || !run.bulkOperation) {
    throw new BulkOperationError(run.userErrors.map((e) => e.message).join("; ") || "bulk operation not created");
  }
  const id = run.bulkOperation.id;
  const deadline = now() + timeoutMs;
  for (;;) {
    const { bulkOperation: op } = await gql<{ bulkOperation: BulkStatus | null }>(admin, BULK_STATUS_QUERY, { id });
    if (!op) throw new BulkOperationError(`bulk operation ${id} not found`);
    if (op.status === "COMPLETED") {
      if (!op.url) return "";
      const res = await doFetch(op.url);
      if (!res.ok) throw new BulkOperationError(`bulk result download failed: HTTP ${res.status}`);
      return await res.text();
    }
    if (op.status === "FAILED" || op.status === "CANCELED" || op.status === "CANCELING" || op.status === "EXPIRED") {
      throw new BulkOperationError(`bulk operation ${op.status}${op.errorCode ? ` (${op.errorCode})` : ""}`);
    }
    if (now() >= deadline) throw new BulkOperationError(`bulk operation ${id} timed out`);
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

function variantData(shop: string, r: VariantRow) {
  return {
    shop,
    productId: r.productId,
    productTitle: r.productTitle,
    variantTitle: r.variantTitle,
    handle: r.handle,
    sku: r.sku,
    vendor: r.vendor,
    productType: r.productType,
    collections: r.collections,
    image: r.image,
    tracked: r.tracked,
    isBundle: r.isBundle,
    status: r.status,
    productCreatedAt: r.productCreatedAt,
    cost: r.cost,
    costCurrency: r.costCurrency,
    price: r.price,
  };
}

/** Upserts Variant rows. Supplier and case-pack fields are never touched. */
export async function upsertVariants(shop: string, rows: VariantRow[]): Promise<number> {
  await inBatches(rows, WRITE_BATCH, (batch) =>
    prisma.$transaction(
      batch.map((r) =>
        prisma.variant.upsert({
          where: { id: r.id },
          create: { id: r.id, ...variantData(shop, r) },
          update: variantData(shop, r),
        }),
      ),
    ),
  );
  return rows.length;
}

/** Removes variants (and their stock now / metrics) of this shop. */
async function deleteVariants(shop: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  let removed = 0;
  await inBatches(ids, 1000, async (batch) => {
    await prisma.stockNow.deleteMany({ where: { shop, variantId: { in: batch } } });
    await prisma.variantMetric.deleteMany({ where: { shop, variantId: { in: batch } } });
    removed += (await prisma.variant.deleteMany({ where: { shop, id: { in: batch } } })).count;
  });
  return removed;
}

export type CatalogResult = { variants: number; products: number; malformed: number; orphans: number; removed: number };

/** Full catalog via one bulk operation. */
export async function syncCatalog(admin: AdminGraphqlClient, shop: string, deps: SyncDeps = {}): Promise<CatalogResult> {
  const text = await runBulkQuery(admin, CATALOG_BULK_QUERY, deps);
  const parsed = parseCatalogJsonl(text);
  await upsertVariants(shop, parsed.variants);
  const seen = new Set(parsed.variants.map((v) => v.id));
  const existing = await prisma.variant.findMany({ where: { shop }, select: { id: true } });
  const removed = await deleteVariants(
    shop,
    existing.map((v) => v.id).filter((id) => !seen.has(id)),
  );
  if (parsed.malformed || parsed.orphans) {
    console.warn(`[sync/catalog] ${shop}: ${parsed.malformed} malformed line(s), ${parsed.orphans} orphan(s) skipped`);
  }
  return {
    variants: parsed.variants.length,
    products: parsed.products,
    malformed: parsed.malformed,
    orphans: parsed.orphans,
    removed,
  };
}

type ProductQueryData = {
  product:
    | (GqlProductNode & {
        collections?: { nodes?: Array<{ id?: unknown }> } | null;
        variants?: {
          nodes?: GqlVariantNode[] | null;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
        } | null;
      })
    | null;
};

/**
 * Re-reads one product's variants (products/update) and upserts them; variants the product
 * no longer has are removed. A product that no longer exists is deleted.
 */
export async function syncProduct(admin: AdminGraphqlClient, shop: string, productId: string): Promise<number> {
  const rows: VariantRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const data: ProductQueryData = await gql<ProductQueryData>(admin, PRODUCT_QUERY, { id: productId, after });
    const p = data.product;
    if (!p) {
      await deleteProduct(shop, productId);
      return 0;
    }
    const collections = (p.collections?.nodes ?? [])
      .map((c) => toGid("Collection", c?.id))
      .filter((c): c is string => !!c);
    for (const v of p.variants?.nodes ?? []) {
      const row = toVariantRow(p, v, collections);
      if (row) rows.push(row);
    }
    const info = p.variants?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  await upsertVariants(shop, rows);
  const keep = new Set(rows.map((r) => r.id));
  const existing = await prisma.variant.findMany({ where: { shop, productId }, select: { id: true } });
  await deleteVariants(
    shop,
    existing.map((v) => v.id).filter((id) => !keep.has(id)),
  );
  return rows.length;
}

/** products/delete: the product's Variant, StockNow and VariantMetric rows. */
export async function deleteProduct(shop: string, productId: string): Promise<number> {
  const existing = await prisma.variant.findMany({ where: { shop, productId }, select: { id: true } });
  return deleteVariants(
    shop,
    existing.map((v) => v.id),
  );
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export async function upsertLocation(shop: string, l: LocationRow): Promise<void> {
  await prisma.location.upsert({
    where: { id: l.id },
    create: { id: l.id, shop, name: l.name, active: l.active, online: l.online },
    update: { shop, name: l.name, active: l.active, online: l.online },
  });
}

/** All locations (active and deactivated). Locations no longer returned are left alone. */
export async function syncLocations(admin: AdminGraphqlClient, shop: string): Promise<LocationRow[]> {
  const out: LocationRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data: {
      locations: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } = await gql(admin, LOCATIONS_QUERY, { after });
    for (const n of data.locations.nodes) {
      const row = toLocationRow(n);
      if (row) out.push(row);
    }
    if (!data.locations.pageInfo.hasNextPage || !data.locations.pageInfo.endCursor) break;
    after = data.locations.pageInfo.endCursor;
  }
  for (const l of out) await upsertLocation(shop, l);
  return out;
}

/** locations/create|update: re-read the location through GraphQL. */
export async function refreshLocation(admin: AdminGraphqlClient, shop: string, locationId: string): Promise<boolean> {
  const data = await gql<{ location: unknown }>(admin, LOCATION_QUERY, { id: locationId });
  const row = toLocationRow(data.location);
  if (!row) return false;
  await upsertLocation(shop, row);
  return true;
}

/** locations/delete. Stock now at that location goes too; history stays (it is history). */
export async function deleteLocation(shop: string, locationId: string): Promise<void> {
  await prisma.stockNow.deleteMany({ where: { shop, locationId } });
  await prisma.location.deleteMany({ where: { shop, id: locationId } });
}

// ---------------------------------------------------------------------------
// Stock now
// ---------------------------------------------------------------------------

async function upsertStock(shop: string, rows: StockLevelRow[]): Promise<void> {
  await inBatches(rows, WRITE_BATCH, (batch) =>
    prisma.$transaction(
      batch.map((r) =>
        prisma.stockNow.upsert({
          where: { shop_variantId_locationId: { shop, variantId: r.variantId, locationId: r.locationId } },
          create: { shop, ...r },
          update: { available: r.available, incoming: r.incoming, committed: r.committed, onHand: r.onHand },
        }),
      ),
    ),
  );
}

type StockItemData = { inventoryItem: GqlInventoryItem | null };

/** All levels of one item, following the levels cursor. */
async function readItemLevels(
  admin: AdminGraphqlClient,
  inventoryItemId: string,
  after: string | null,
): Promise<{ variantId?: string; rows: StockLevelRow[]; found: boolean }> {
  const rows: StockLevelRow[] = [];
  let variantId: string | undefined;
  let cursor = after;
  for (let page = 0; page < 20; page++) {
    const data: StockItemData = await gql<StockItemData>(admin, STOCK_ITEM_QUERY, { id: inventoryItemId, after: cursor });
    const item = data.inventoryItem;
    if (!item) return { rows, found: false };
    variantId = variantId ?? itemVariantId(item);
    if (variantId) rows.push(...levelRows(variantId, item.inventoryLevels?.nodes));
    const info = item.inventoryLevels?.pageInfo;
    if (!info?.hasNextPage || typeof info.endCursor !== "string") break;
    cursor = info.endCursor;
  }
  return { variantId, rows, found: true };
}

/** Stock now for every inventory item. Rows not seen in this complete run are removed. */
export async function syncStockNow(admin: AdminGraphqlClient, shop: string, deps: SyncDeps = {}): Promise<number> {
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now() - 1000);
  const locationCount = await prisma.location.count({ where: { shop } });
  const { first, levels } = stockPageSizes(locationCount);
  let after: string | null = null;
  let written = 0;
  for (;;) {
    const data: {
      inventoryItems: {
        nodes: GqlInventoryItem[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await gql(admin, STOCK_PAGE_QUERY, { first, levels, after });
    const rows: StockLevelRow[] = [];
    for (const item of data.inventoryItems.nodes) {
      const variantId = itemVariantId(item);
      if (!variantId) continue;
      rows.push(...levelRows(variantId, item.inventoryLevels?.nodes));
      const info = item.inventoryLevels?.pageInfo;
      if (info?.hasNextPage && typeof info.endCursor === "string" && typeof item.id === "string") {
        rows.push(...(await readItemLevels(admin, item.id, info.endCursor)).rows);
      }
    }
    await upsertStock(shop, rows);
    written += rows.length;
    if (!data.inventoryItems.pageInfo.hasNextPage || !data.inventoryItems.pageInfo.endCursor) break;
    after = data.inventoryItems.pageInfo.endCursor;
  }
  await prisma.stockNow.deleteMany({ where: { shop, updatedAt: { lt: startedAt } } });
  return written;
}

/**
 * One inventory item (inventory_levels/update). Takes an explicit admin client; the webhook
 * route passes the one authenticate.webhook gives it.
 */
export async function refreshStockForInventoryItem(
  admin: AdminGraphqlClient,
  shop: string,
  inventoryItemId: string,
): Promise<number> {
  const { variantId, rows, found } = await readItemLevels(admin, inventoryItemId, null);
  if (!found || !variantId) return 0;
  await upsertStock(shop, rows);
  const keep = rows.map((r) => r.locationId);
  await prisma.stockNow.deleteMany({ where: { shop, variantId, locationId: { notIn: keep } } });
  return rows.length;
}
