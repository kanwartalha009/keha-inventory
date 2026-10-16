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
  ADMIN_MAX_ATTEMPTS,
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
  adminThrottleWaitMs,
  hasThrottledError,
  paceWaitMs,
  parseCatalogJsonl,
  readAdminCost,
  parseShopInfo,
  stockPageSizes,
  toGid,
  toLocationRow,
  toVariantRow,
  type AdminCost,
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
  /** Sleep for bulk-operation polling (and throttle waits when throttleSleep is not set). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Sleep used for THROTTLE waits only (Admin API restore, ShopifyQL window reset). The
   * scheduler passes a per-tick budget that throws ThrottleBudgetError past 30 s.
   */
  throttleSleep?: (ms: number) => Promise<void>;
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

/** Still THROTTLED after ADMIN_MAX_ATTEMPTS: stop the job, resume on the next tick. */
export class AdminThrottledError extends Error {
  constructor(attempts: number) {
    super(`Admin API still throttled after ${attempts} attempts`);
    this.name = "AdminThrottledError";
  }
}

type GqlBody<T> = { data?: T; errors?: unknown; extensions?: unknown };

/** A throttle the Shopify library THREW (it throws on HTTP 429 and on GraphQL errors). */
async function thrownThrottle(err: unknown): Promise<{ cost: AdminCost | null; retryAfterMs: number | null } | null> {
  if (typeof Response !== "undefined" && err instanceof Response) {
    if (err.status !== 429) return null;
    let body: unknown = null;
    try {
      body = await err.clone().json();
    } catch {
      body = null;
    }
    return { cost: readAdminCost(body), retryAfterMs: null };
  }
  if (!err || typeof err !== "object") return null;
  const e = err as { response?: { code?: unknown; retryAfter?: unknown }; body?: { errors?: unknown; extensions?: unknown } };
  if (e.response?.code === 429) {
    const secs = typeof e.response.retryAfter === "number" ? e.response.retryAfter : Number(e.response.retryAfter);
    return { cost: null, retryAfterMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : null };
  }
  if (e.body && hasThrottledError(e.body.errors)) return { cost: readAdminCost(e.body), retryAfterMs: null };
  return null;
}

/**
 * Runs one Admin GraphQL operation and returns `data` plus the cost extension. A THROTTLED
 * response (returned or thrown) is retried after the bucket's refill time (or 2^n s),
 * at most ADMIN_MAX_ATTEMPTS times, then AdminThrottledError. Other errors throw AdminQueryError.
 */
export async function gqlWithCost<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
  deps: SyncDeps = {},
): Promise<{ data: T; cost: AdminCost | null }> {
  const sleep = deps.throttleSleep ?? deps.sleep ?? realSleep;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await admin.graphql(query, variables ? { variables } : undefined);
    } catch (err) {
      const t = await thrownThrottle(err);
      if (!t) throw err;
      if (attempt >= ADMIN_MAX_ATTEMPTS) throw new AdminThrottledError(attempt);
      await sleep(t.retryAfterMs ?? adminThrottleWaitMs(t.cost, attempt));
      continue;
    }
    let body: GqlBody<T> | null = null;
    try {
      body = (await res.json()) as GqlBody<T>;
    } catch {
      body = null;
    }
    const cost = readAdminCost(body);
    if (res.status === 429 || hasThrottledError(body?.errors)) {
      if (attempt >= ADMIN_MAX_ATTEMPTS) throw new AdminThrottledError(attempt);
      await sleep(adminThrottleWaitMs(cost, attempt));
      continue;
    }
    if (!res.ok) throw new AdminQueryError(`Admin API HTTP ${res.status}`);
    const errors = Array.isArray(body?.errors) ? (body!.errors as Array<{ message?: unknown }>) : [];
    if (errors.length) {
      throw new AdminQueryError(errors.map((e) => (typeof e?.message === "string" ? e.message : "error")).join("; "));
    }
    if (!body?.data) throw new AdminQueryError("Admin API response has no data");
    return { data: body.data, cost };
  }
}

/** Runs one Admin GraphQL operation and returns `data` (throttle-retrying, see gqlWithCost). */
export async function gql<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
  deps: SyncDeps = {},
): Promise<T> {
  return (await gqlWithCost<T>(admin, query, variables, deps)).data;
}

async function inBatches<T>(items: T[], size: number, write: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await write(items.slice(i, i + size));
}

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

/** Reads shop + shopLocales and upserts the Shop row. A reinstall clears uninstalledAt. */
export async function ensureShop(admin: AdminGraphqlClient, shop: string, deps: SyncDeps = {}): Promise<ShopInfo> {
  const info = parseShopInfo(await gql(admin, SHOP_QUERY, undefined, deps));
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
  }>(admin, BULK_RUN_MUTATION, { query }, deps);
  const run = started.bulkOperationRunQuery;
  if (run.userErrors.length || !run.bulkOperation) {
    throw new BulkOperationError(run.userErrors.map((e) => e.message).join("; ") || "bulk operation not created");
  }
  const id = run.bulkOperation.id;
  const deadline = now() + timeoutMs;
  for (;;) {
    const { bulkOperation: op } = await gql<{ bulkOperation: BulkStatus | null }>(admin, BULK_STATUS_QUERY, { id }, deps);
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
export async function syncProduct(admin: AdminGraphqlClient, shop: string, productId: string, deps: SyncDeps = {}): Promise<number> {
  const rows: VariantRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const data: ProductQueryData = await gql<ProductQueryData>(admin, PRODUCT_QUERY, { id: productId, after }, deps);
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
export async function syncLocations(admin: AdminGraphqlClient, shop: string, deps: SyncDeps = {}): Promise<LocationRow[]> {
  const out: LocationRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data: {
      locations: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } = await gql(admin, LOCATIONS_QUERY, { after }, deps);
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
export async function refreshLocation(admin: AdminGraphqlClient, shop: string, locationId: string, deps: SyncDeps = {}): Promise<boolean> {
  const data = await gql<{ location: unknown }>(admin, LOCATION_QUERY, { id: locationId }, deps);
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
  deps: SyncDeps = {},
): Promise<{ variantId?: string; rows: StockLevelRow[]; found: boolean }> {
  const rows: StockLevelRow[] = [];
  let variantId: string | undefined;
  let cursor = after;
  for (let page = 0; page < 20; page++) {
    const data: StockItemData = await gql<StockItemData>(admin, STOCK_ITEM_QUERY, { id: inventoryItemId, after: cursor }, deps);
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

/** Where a stock-now pass is (persisted between runs so a throttle resumes, not restarts). */
export type StockResume = {
  /** inventoryItems cursor AFTER the last page written; null = from the start. */
  cursor: string | null;
  /** When the pass began (ISO): rows not refreshed since then are removed at the end. */
  startedAt: string;
};

/**
 * Stock now for every inventory item, page by page. Pages are paced: when the Admin API
 * bucket holds less than the next page's cost, it waits (through throttleSleep) for the
 * refill. `resume` continues a pass from its cursor; `onPage` is told the cursor after each
 * written page so the caller can persist it. Rows not seen since the pass began are removed
 * once the pass completes.
 */
export async function syncStockNow(
  admin: AdminGraphqlClient,
  shop: string,
  deps: SyncDeps = {},
  resume?: StockResume | null,
  onPage?: (r: StockResume) => Promise<void>,
): Promise<number> {
  const now = deps.now ?? Date.now;
  const pass: StockResume = resume?.startedAt ? { ...resume } : { cursor: null, startedAt: new Date(now() - 1000).toISOString() };
  const locationCount = await prisma.location.count({ where: { shop } });
  const { first, levels } = stockPageSizes(locationCount);
  const estimate = first * (4 + 3 * levels);
  const throttleSleep = deps.throttleSleep ?? deps.sleep ?? realSleep;
  let written = 0;
  for (;;) {
    const { data, cost }: {
      data: {
        inventoryItems: {
          nodes: GqlInventoryItem[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
      cost: AdminCost | null;
    } = await gqlWithCost(admin, STOCK_PAGE_QUERY, { first, levels, after: pass.cursor }, deps);
    const rows: StockLevelRow[] = [];
    for (const item of data.inventoryItems.nodes) {
      const variantId = itemVariantId(item);
      if (!variantId) continue;
      rows.push(...levelRows(variantId, item.inventoryLevels?.nodes));
      const info = item.inventoryLevels?.pageInfo;
      if (info?.hasNextPage && typeof info.endCursor === "string" && typeof item.id === "string") {
        rows.push(...(await readItemLevels(admin, item.id, info.endCursor, deps)).rows);
      }
    }
    await upsertStock(shop, rows);
    written += rows.length;
    const info = data.inventoryItems.pageInfo;
    if (!info.hasNextPage || !info.endCursor) break;
    pass.cursor = info.endCursor;
    if (onPage) await onPage({ ...pass });
    const wait = paceWaitMs(cost, cost?.requestedQueryCost ?? estimate);
    if (wait > 0) await throttleSleep(wait);
  }
  await prisma.stockNow.deleteMany({ where: { shop, updatedAt: { lt: new Date(pass.startedAt) } } });
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
  deps: SyncDeps = {},
): Promise<number> {
  const { variantId, rows, found } = await readItemLevels(admin, inventoryItemId, null, deps);
  if (!found || !variantId) return 0;
  await upsertStock(shop, rows);
  const keep = rows.map((r) => r.locationId);
  await prisma.stockNow.deleteMany({ where: { shop, variantId, locationId: { notIn: keep } } });
  return rows.length;
}
