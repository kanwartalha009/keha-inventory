/**
 * Hand-kept access-scope map for the Admin GraphQL API 2026-10 (tests/admin-scopes.test.ts).
 *
 * The schema fixture carries no scope data, so every field the app selects that is gated by a
 * scope is listed here with the scopes shopify.dev accepts for it (ANY one of them is enough;
 * `write_x` also grants `read_x`). `[]` means shopify.dev states no scope for it.
 *
 * Rules for keys:
 *  - every top-level field the app uses: `QueryRoot.<field>` / `Mutation.<field>`;
 *  - `QueryRoot.nodes on <Type>`: one entry per type the app reads through `nodes(ids:)`;
 *  - nested fields that need a DIFFERENT scope than the root they hang from (e.g. stock levels
 *    under an inventory item, linked transfers under a purchase order).
 *
 * Where a query page states no scope, the scope comes from the object it returns (the object
 * page's "Requires `read_x` access scope" line). Each entry names its source. All pages were
 * read on 2026-10-17 at https://shopify.dev/docs/api/admin-graphql/2026-10/...
 *
 * When the test asks you to add a field: open its query/mutation page and the page of the
 * object it returns, copy the "Requires ..." line here with the URL, then add the scope to both
 * tomls and .env.example only if the field is really needed.
 */

const DOCS = "https://shopify.dev/docs/api/admin-graphql/2026-10";

export type ScopeEntry = { scopes: string[]; source: string; note?: string };

export const FIELD_SCOPES: Record<string, ScopeEntry> = {
  // ---- QueryRoot -----------------------------------------------------------------------------
  "QueryRoot.shop": {
    scopes: [],
    source: `${DOCS}/queries/shop + ${DOCS}/objects/Shop`,
    note: "No scope stated for the query or for name, email, contactEmail, currencyCode, ianaTimezone, myshopifyDomain.",
  },
  "QueryRoot.shopLocales": {
    scopes: ["read_locales", "read_markets_home"],
    source: `${DOCS}/queries/shopLocales ("Requires read_locales access scope or read_markets_home access scope.")`,
    note: "Production backfill broke on this field before read_locales was requested (2026-10-17).",
  },
  "QueryRoot.shopifyqlQuery": {
    scopes: ["read_reports"],
    source: `${DOCS}/queries/shopifyqlQuery ("Requires read_reports access scope.")`,
    note: "Also needs Level 2 protected customer data access (name, address, phone, email) on the Partner app.",
  },
  "QueryRoot.products": {
    scopes: ["read_products"],
    source: `${DOCS}/objects/Product ("Requires read_products access scope."); the query page states none`,
  },
  "QueryRoot.product": {
    scopes: ["read_products"],
    source: `${DOCS}/objects/Product ("Requires read_products access scope."); the query page states none`,
  },
  "QueryRoot.inventoryItems": {
    scopes: ["read_inventory", "read_products"],
    source: `${DOCS}/objects/InventoryItem ("Requires read_inventory access scope or read_products access scope."); the query page states none`,
    note: "unitCost also needs the staff 'View product costs' permission (not an app scope).",
  },
  "QueryRoot.inventoryItem": {
    scopes: ["read_inventory", "read_products"],
    source: `${DOCS}/objects/InventoryItem ("Requires read_inventory access scope or read_products access scope."); the query page states none`,
  },
  "QueryRoot.locations": {
    scopes: ["read_locations", "read_inventory", "read_markets_home"],
    source: `${DOCS}/objects/Location ("Requires read_locations access scope, read_inventory access scope or read_markets_home access scope."); the query page states none`,
  },
  "QueryRoot.location": {
    scopes: ["read_locations", "read_inventory", "read_markets_home"],
    source: `${DOCS}/objects/Location ("Requires read_locations access scope, read_inventory access scope or read_markets_home access scope."); the query page states none`,
  },
  "QueryRoot.inventoryPurchaseOrders": {
    scopes: ["read_inventory_purchase_orders", "write_inventory_purchase_orders"],
    source: `${DOCS}/queries/inventoryPurchaseOrders ("Requires read_inventory_purchase_orders access scope.") + https://shopify.dev/changelog/posts/purchase-order-read-api (write includes read)`,
  },
  "QueryRoot.inventoryPurchaseOrder": {
    scopes: ["read_inventory_purchase_orders", "write_inventory_purchase_orders"],
    source: `${DOCS}/queries/inventoryPurchaseOrder ("Requires read_inventory_purchase_orders access scope.")`,
  },
  "QueryRoot.bulkOperation": {
    scopes: [],
    source: `${DOCS}/objects/BulkOperation (no scope; "Only accessible by supported access tokens")`,
  },
  "QueryRoot.appByHandle": {
    scopes: [],
    source: `${DOCS}/queries/appByHandle + ${DOCS}/objects/App (no scope stated for id, installation)`,
  },
  "QueryRoot.currentAppInstallation": {
    scopes: [],
    source: `${DOCS}/queries/currentAppInstallation + ${DOCS}/objects/AppInstallation (no scope stated for id, app, activeSubscriptions)`,
  },
  "QueryRoot.nodes": {
    scopes: [],
    source: `${DOCS}/queries/nodes (no scope stated; each node needs its own type's scope, see the "on <Type>" entries)`,
  },
  "QueryRoot.nodes on ProductVariant": {
    scopes: ["read_products"],
    source: `${DOCS}/objects/ProductVariant ("Requires read_products access scope.")`,
  },

  // ---- Mutation ------------------------------------------------------------------------------
  "Mutation.bulkOperationRunQuery": {
    scopes: [],
    source: `${DOCS}/mutations/bulkOperationRunQuery (no scope; the bulk query's own fields need theirs, checked through CATALOG_BULK_QUERY)`,
  },
  "Mutation.discountAutomaticBasicCreate": {
    scopes: ["write_discounts"],
    source: `${DOCS}/mutations/discountAutomaticBasicCreate ("Apps must have write_discounts access scope.")`,
  },
  "Mutation.discountCodeBasicCreate": {
    scopes: ["write_discounts"],
    source: `${DOCS}/mutations/discountCodeBasicCreate ("Apps must have write_discounts access scope.")`,
  },
  "Mutation.inventoryTransferCreate": {
    scopes: ["write_inventory_transfers"],
    source: `${DOCS}/mutations/inventoryTransferCreate ("Requires write_inventory_transfers access scope.")`,
    note: "Linking purchase orders in the input would also need write_inventory_purchase_orders; the app does not link them.",
  },
  "Mutation.flowTriggerReceive": {
    scopes: [],
    source: `${DOCS}/mutations/flowTriggerReceive (no scope stated)`,
  },

  // ---- Nested fields that need a different scope than their root -----------------------------
  "InventoryItem.inventoryLevels": {
    scopes: ["read_inventory"],
    source: `${DOCS}/objects/InventoryLevel ("Requires read_inventory access scope.") + https://shopify.dev/changelog/posts/inventoryitem-queryable-and-updatable-with-products-scopes ("The inventoryLevel cannot be queried from the InventoryItem object without the read_inventory scope.")`,
  },
  "InventoryLevel.location": {
    scopes: ["read_locations"],
    source: `https://shopify.dev/changelog/posts/inventoryitem-queryable-and-updatable-with-products-scopes ("The location cannot be queried without the read_locations scope.")`,
    note: "Stricter than the Location object page (which also lists read_inventory); the changelog wins.",
  },
  "InventoryItem.variants": {
    scopes: ["read_products"],
    source: `${DOCS}/objects/ProductVariant ("Requires read_products access scope.")`,
  },
  "ProductVariant.inventoryItem": {
    scopes: ["read_inventory", "read_products"],
    source: `${DOCS}/objects/InventoryItem ("Requires read_inventory access scope or read_products access scope.")`,
  },
  "Product.collections": {
    scopes: ["read_products"],
    source: `${DOCS}/objects/Collection ("Requires read_products access scope.")`,
  },
  "InventoryPurchaseOrderLineItem.inventoryItem": {
    scopes: ["read_inventory", "read_products"],
    source: `${DOCS}/objects/InventoryItem ("Requires read_inventory access scope or read_products access scope.")`,
  },
  "InventoryPurchaseOrder.transfers": {
    scopes: ["read_inventory_transfers", "write_inventory_transfers"],
    source: `${DOCS}/objects/InventoryTransfer ("Requires read_inventory_transfers access scope.") + https://shopify.dev/changelog/posts/purchase-order-read-api ("Reading these objects also requires read_inventory_transfers access.")`,
  },
};

/**
 * Webhook topics (both tomls) → scopes. Source: the WebhookSubscriptionTopic enum,
 * https://shopify.dev/docs/api/admin-graphql/2026-10/enums/WebhookSubscriptionTopic
 * ("Requires the read_x scope." on each value). App and compliance topics state none.
 */
export const WEBHOOK_TOPIC_SCOPES: Record<string, string[]> = {
  "app/uninstalled": [],
  "app/scopes_update": [],
  "inventory_levels/update": ["read_inventory"],
  "products/update": ["read_products"],
  "products/delete": ["read_products"],
  "locations/create": ["read_locations"],
  "locations/update": ["read_locations"],
  "locations/delete": ["read_locations"],
  // Mandatory compliance topics: every app must subscribe, no scope
  // (https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance).
  "customers/data_request": [],
  "customers/redact": [],
  "shop/redact": [],
};

/**
 * Scopes requested for something other than an Admin GraphQL field or a webhook topic, with
 * the reason. Empty today: every requested scope is used by a field or topic above.
 */
export const NON_GRAPHQL_SCOPE_USES: Record<string, string> = {};
