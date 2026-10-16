/**
 * Catalog, locations and stock now — pure part (spec §6.3, task 1.3).
 *
 * What lives here (no server imports, no I/O):
 *  - every Admin GraphQL document the catalog sync sends, validated against the Admin schema
 *    (see the task report: bulkOperationRunQuery, bulkOperation, locations, location,
 *    inventoryItems, inventoryItem, product, shop + shopLocales);
 *  - the bulk JSONL parser: with `groupObjects: false` (the 2026-01+ default) child lines
 *    carry `__parentId` and may appear anywhere in the file, so children are collected
 *    first and attached to their product at the end;
 *  - row mappers from GraphQL nodes to the Variant / Location / StockNow shapes.
 *
 * Rules (spec §6.3, §7):
 *  - bundles (variant.requiresComponents, or product.hasVariantsThatRequiresComponents when
 *    the variant flag is absent) are flagged isBundle and never summed by the engine;
 *  - untracked variants are kept with tracked = false;
 *  - a missing unit cost is null, never 0 (invariant I-5).
 */

// ---------------------------------------------------------------------------
// GraphQL documents (Admin API 2026-10)
// ---------------------------------------------------------------------------

/**
 * The bulk query itself (sent as a string inside bulkOperationRunQuery). Bulk operations
 * ignore `first`, so a product's collections are capped to MAX_COLLECTIONS by the parser.
 * Connections: products, collections, variants (3 of 5 allowed; depth 1 of 2).
 */
export const CATALOG_BULK_QUERY = `{
  products {
    edges {
      node {
        id
        title
        handle
        status
        vendor
        productType
        createdAt
        hasVariantsThatRequiresComponents
        featuredMedia { preview { image { url } } }
        collections { edges { node { id } } }
        variants {
          edges {
            node {
              id
              title
              sku
              price
              requiresComponents
              inventoryItem { id tracked unitCost { amount currencyCode } }
            }
          }
        }
      }
    }
  }
}`;

export const BULK_RUN_MUTATION = `#graphql
  mutation KehaInvCatalogBulk($query: String!) {
    bulkOperationRunQuery(query: $query, groupObjects: false) {
      bulkOperation { id status }
      userErrors { field message code }
    }
  }`;

export const BULK_STATUS_QUERY = `#graphql
  query KehaInvBulkStatus($id: ID!) {
    bulkOperation(id: $id) { id status errorCode objectCount url partialDataUrl }
  }`;

export const LOCATIONS_QUERY = `#graphql
  query KehaInvLocations($after: String) {
    locations(first: 250, after: $after, includeInactive: true) {
      nodes { id name isActive fulfillsOnlineOrders }
      pageInfo { hasNextPage endCursor }
    }
  }`;

export const LOCATION_QUERY = `#graphql
  query KehaInvLocation($id: ID!) {
    location(id: $id) { id name isActive fulfillsOnlineOrders }
  }`;

/** One page of stock now. Page sizes come from `stockPageSizes` (query cost ≤ 1000). */
export const STOCK_PAGE_QUERY = `#graphql
  query KehaInvStockPage($first: Int!, $levels: Int!, $after: String) {
    inventoryItems(first: $first, after: $after) {
      nodes {
        id
        tracked
        variants(first: 1) { nodes { id } }
        inventoryLevels(first: $levels) {
          nodes {
            location { id }
            quantities(names: ["available", "incoming", "committed", "on_hand"]) { name quantity }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/** One inventory item (webhook refresh, and items with more levels than a stock page holds). */
export const STOCK_ITEM_QUERY = `#graphql
  query KehaInvStockItem($id: ID!, $after: String) {
    inventoryItem(id: $id) {
      id
      tracked
      variants(first: 1) { nodes { id } }
      inventoryLevels(first: 250, after: $after) {
        nodes {
          location { id }
          quantities(names: ["available", "incoming", "committed", "on_hand"]) { name quantity }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

/** One product with its variants (products/update webhook). */
export const PRODUCT_QUERY = `#graphql
  query KehaInvProduct($id: ID!, $after: String) {
    product(id: $id) {
      id
      title
      handle
      status
      vendor
      productType
      createdAt
      hasVariantsThatRequiresComponents
      featuredMedia { preview { image { url } } }
      collections(first: 20) { nodes { id } }
      variants(first: 100, after: $after) {
        nodes {
          id
          title
          sku
          price
          requiresComponents
          inventoryItem { id tracked unitCost { amount currencyCode } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

export const SHOP_QUERY = `#graphql
  query KehaInvShopInfo {
    shop { name currencyCode ianaTimezone myshopifyDomain }
    shopLocales { locale primary }
  }`;

export const MAX_COLLECTIONS = 20;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Numeric id or gid → gid of the given type; undefined when unusable. */
export function toGid(type: string, v: unknown): string | undefined {
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return `gid://shopify/${type}/${v}`;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d+$/.test(s) && !/^0+$/.test(s)) return `gid://shopify/${type}/${s.replace(/^0+/, "")}`;
    const m = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)$/.exec(s);
    if (m && m[1] === type) return s;
  }
  return undefined;
}

function gidType(id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  return /^gid:\/\/shopify\/([A-Za-z]+)\//.exec(id)?.[1];
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type GqlMoney = { amount?: unknown; currencyCode?: unknown } | null | undefined;

export type GqlVariantNode = {
  id?: unknown;
  title?: unknown;
  sku?: unknown;
  price?: unknown;
  requiresComponents?: unknown;
  inventoryItem?: { id?: unknown; tracked?: unknown; unitCost?: GqlMoney } | null;
};

export type GqlProductNode = {
  id?: unknown;
  title?: unknown;
  handle?: unknown;
  status?: unknown;
  vendor?: unknown;
  productType?: unknown;
  createdAt?: unknown;
  hasVariantsThatRequiresComponents?: unknown;
  featuredMedia?: { preview?: { image?: { url?: unknown } | null } | null } | null;
};

/** One Variant row (Prisma `Variant` minus shop / supplier fields). Decimals as strings. */
export type VariantRow = {
  id: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  handle: string;
  sku: string | null;
  vendor: string | null;
  productType: string | null;
  collections: string[];
  image: string | null;
  tracked: boolean;
  isBundle: boolean;
  status: string;
  productCreatedAt: Date | null;
  cost: string | null;
  costCurrency: string | null;
  price: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** A decimal string (or number) that is finite; else null. Never turns "missing" into "0". */
export function decimalOrNull(v: unknown): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "" || !Number.isFinite(Number(s))) return null;
    return s;
  }
  return null;
}

function dateOrNull(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Product + one of its variants → a Variant row; null when either id is unusable. */
export function toVariantRow(
  product: GqlProductNode,
  variant: GqlVariantNode,
  collections: string[],
): VariantRow | null {
  const productId = toGid("Product", product.id);
  const id = toGid("ProductVariant", variant.id);
  if (!productId || !id) return null;
  const item = variant.inventoryItem ?? null;
  const cost = decimalOrNull(item?.unitCost?.amount);
  const variantBundle =
    typeof variant.requiresComponents === "boolean"
      ? variant.requiresComponents
      : product.hasVariantsThatRequiresComponents === true;
  return {
    id,
    productId,
    productTitle: str(product.title) ?? "",
    variantTitle: str(variant.title) ?? "",
    handle: str(product.handle) ?? "",
    sku: str(variant.sku),
    vendor: str(product.vendor),
    productType: str(product.productType),
    collections: collections.slice(0, MAX_COLLECTIONS),
    image: str(product.featuredMedia?.preview?.image?.url),
    tracked: item?.tracked === true,
    isBundle: variantBundle,
    status: str(product.status) ?? "ACTIVE",
    productCreatedAt: dateOrNull(product.createdAt),
    cost,
    costCurrency: cost === null ? null : str(item?.unitCost?.currencyCode),
    price: decimalOrNull(variant.price),
  };
}

// ---------------------------------------------------------------------------
// Bulk JSONL
// ---------------------------------------------------------------------------

export type CatalogParse = {
  variants: VariantRow[];
  products: number;
  /** Lines that were not JSON objects. */
  malformed: number;
  /** Child lines whose parent product never appeared, or rows with unusable ids. */
  orphans: number;
};

/**
 * Parses the bulk JSONL. Product lines have no `__parentId`; variant and collection lines
 * carry the product's id in `__parentId`. Order is not assumed (groupObjects: false).
 */
export function parseCatalogJsonl(text: string): CatalogParse {
  const products = new Map<string, GqlProductNode>();
  const variantsByProduct = new Map<string, GqlVariantNode[]>();
  const collectionsByProduct = new Map<string, string[]>();
  let malformed = 0;
  let orphans = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      malformed++;
      continue;
    }
    const o = obj as Record<string, unknown>;
    const parent = typeof o.__parentId === "string" ? o.__parentId : null;
    const type = gidType(o.id);
    if (!parent) {
      if (type === "Product") products.set(o.id as string, o as GqlProductNode);
      else orphans++;
      continue;
    }
    if (type === "ProductVariant") {
      const list = variantsByProduct.get(parent) ?? [];
      list.push(o as GqlVariantNode);
      variantsByProduct.set(parent, list);
    } else if (type === "Collection") {
      const list = collectionsByProduct.get(parent) ?? [];
      list.push(o.id as string);
      collectionsByProduct.set(parent, list);
    } else {
      orphans++;
    }
  }

  const rows: VariantRow[] = [];
  for (const [productId, list] of variantsByProduct) {
    const product = products.get(productId);
    if (!product) {
      orphans += list.length;
      continue;
    }
    const cols = collectionsByProduct.get(productId) ?? [];
    for (const v of list) {
      const row = toVariantRow(product, v, cols);
      if (row) rows.push(row);
      else orphans++;
    }
  }
  return { variants: rows, products: products.size, malformed, orphans };
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export type LocationRow = { id: string; name: string; active: boolean; online: boolean };

export function toLocationRow(node: unknown): LocationRow | null {
  if (!node || typeof node !== "object") return null;
  const n = node as { id?: unknown; name?: unknown; isActive?: unknown; fulfillsOnlineOrders?: unknown };
  const id = toGid("Location", n.id);
  if (!id) return null;
  return {
    id,
    name: str(n.name) ?? "",
    active: n.isActive !== false,
    online: n.fulfillsOnlineOrders === true,
  };
}

// ---------------------------------------------------------------------------
// Stock now
// ---------------------------------------------------------------------------

export type StockLevelRow = {
  variantId: string;
  locationId: string;
  available: number;
  incoming: number;
  committed: number;
  onHand: number;
};

type GqlLevel = { location?: { id?: unknown } | null; quantities?: unknown };

export type GqlInventoryItem = {
  id?: unknown;
  tracked?: unknown;
  variants?: { nodes?: Array<{ id?: unknown }> | null } | null;
  inventoryLevels?: {
    nodes?: GqlLevel[] | null;
    pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null;
  } | null;
};

function quantity(list: unknown, name: string): number {
  if (!Array.isArray(list)) return 0;
  const q = list.find((x) => x && typeof x === "object" && (x as { name?: unknown }).name === name) as
    | { quantity?: unknown }
    | undefined;
  const n = q?.quantity;
  return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** The variant an inventory item belongs to (first node of the 2026-01+ `variants` connection). */
export function itemVariantId(item: GqlInventoryItem): string | undefined {
  return toGid("ProductVariant", item.variants?.nodes?.[0]?.id);
}

/** Inventory levels of one item → StockNow rows (levels without a location are skipped). */
export function levelRows(variantId: string, levels: GqlLevel[] | null | undefined): StockLevelRow[] {
  const out: StockLevelRow[] = [];
  for (const l of levels ?? []) {
    const locationId = toGid("Location", l?.location?.id);
    if (!locationId) continue;
    out.push({
      variantId,
      locationId,
      available: quantity(l.quantities, "available"),
      incoming: quantity(l.quantities, "incoming"),
      committed: quantity(l.quantities, "committed"),
      onHand: quantity(l.quantities, "on_hand"),
    });
  }
  return out;
}

/**
 * Page sizes for STOCK_PAGE_QUERY so the requested cost stays under the 1000-point single
 * query limit: levels per item = the shop's location count (1–250); items per page from a
 * conservative estimate of ~3 points per level plus ~4 per item.
 */
export function stockPageSizes(locationCount: number): { first: number; levels: number } {
  const levels = Math.max(1, Math.min(250, Math.trunc(locationCount) || 1));
  const perItem = 4 + 3 * levels;
  const first = Math.max(1, Math.min(250, Math.floor(900 / perItem)));
  return { first, levels };
}

// ---------------------------------------------------------------------------
// Shop info
// ---------------------------------------------------------------------------

export type ShopInfo = {
  name: string | null;
  currency: string;
  timezone: string;
  locale: string;
  myshopifyDomain: string | null;
};

/** `shop` + `shopLocales` → Shop fields. Falls back to USD / UTC / en when a field is missing. */
export function parseShopInfo(data: unknown): ShopInfo {
  const d = (data && typeof data === "object" ? data : {}) as {
    shop?: { name?: unknown; currencyCode?: unknown; ianaTimezone?: unknown; myshopifyDomain?: unknown } | null;
    shopLocales?: Array<{ locale?: unknown; primary?: unknown }> | null;
  };
  const locales = Array.isArray(d.shopLocales) ? d.shopLocales : [];
  const primary = locales.find((l) => l?.primary === true) ?? locales[0];
  return {
    name: str(d.shop?.name),
    currency: str(d.shop?.currencyCode) ?? "USD",
    timezone: str(d.shop?.ianaTimezone) ?? "UTC",
    locale: str(primary?.locale) ?? "en",
    myshopifyDomain: str(d.shop?.myshopifyDomain),
  };
}
