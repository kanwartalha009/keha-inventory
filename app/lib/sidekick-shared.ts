/**
 * Shopify Sidekick app data tools (extensions/keha-inventory-sidekick, target
 * `admin.app.tools.data`). Pure, client-safe: the tool list, input parsing and
 * the response shapes Sidekick reads. The server side is
 * app/services/sidekick.server.ts; the route is app/routes/api.sidekick.$tool.tsx.
 *
 * Shopify's rules for these responses (shopify.dev/docs/apps/build/sidekick, 2026-10):
 *  - read-only data, at most 4,000 tokens (≈ 16,000 characters) — we stay under
 *    RESPONSE_MAX_CHARS (3,500 tokens at 4 characters a token) by dropping
 *    rows from the end and saying how many were left out;
 *  - lists come back as MCP resource links ({ type: "resource_link", uri, name,
 *    mimeType, _meta }); `_meta` stays small; app pages use the `app:` protocol
 *    (`url: "app://app/reorder?…"`), which Shopify resolves against the app;
 *  - factual content only: no selling, no plan or upgrade talk, no urgency
 *    words (tests/sidekick-extension.test.ts lints this). Locked plan data is
 *    simply not returned.
 *
 * Numbers follow the app's invariants: an unknown value is null, never 0.
 * Text is English (Sidekick answers in the merchant's language itself).
 */
import type { MoneyCardKey } from "./money-shared";

// ── Tools ────────────────────────────────────────────────────────────────────

/** Every tool the extension registers; the route answers exactly these (≤ 20 per app). */
export const SIDEKICK_TOOLS = [
  "get_order_plan",
  "get_product_stock",
  "get_action_list",
  "get_money_at_stake",
  "get_purchase_orders",
  "get_forecast_accuracy",
] as const;
export type SidekickTool = (typeof SIDEKICK_TOOLS)[number];

export function isSidekickTool(v: unknown): v is SidekickTool {
  return typeof v === "string" && (SIDEKICK_TOOLS as readonly string[]).includes(v);
}

/** The backend path a tool fetches (relative: the sandbox resolves it against the app URL). */
export const sidekickPath = (tool: SidekickTool) => `/api/sidekick/${tool}`;

/** Rows per list before the token budget is even checked. */
export const MAX_ROWS = 15;
/** Lines shown inside one supplier group of the order plan. */
export const MAX_GROUP_LINES = 8;
/** ≈ 3,500 tokens at 4 characters a token (Shopify rejects anything over 4,000 tokens). */
export const RESPONSE_MAX_CHARS = 14_000;
/** Shopify skips data tools that are consistently slower than 1 second; we answer before. */
export const RESPONSE_DEADLINE_MS = 900;

export const DEFAULT_WITHIN_DAYS = 14;
export const MAX_WITHIN_DAYS = 90;

export const MIME = {
  supplierOrder: "application/vnd.keha.supplier-order",
  variant: "application/vnd.keha.variant-stock",
  action: "application/vnd.keha.action",
  purchaseOrder: "application/vnd.keha.purchase-order",
} as const;

// ── Neutral messages (never a plan or upgrade mention) ──────────────────────

export const MSG = {
  notAvailable: "This information isn't available for this store in Keha Inventory Intelligence.",
  syncing: "Keha Inventory Intelligence is still reading this store's data. The numbers appear once the first read is done.",
  noTracked: "No products in this store track their stock quantity, so there is nothing to plan yet.",
  noSales: "There are fewer than 14 days of sales so far, so there is no advice yet.",
  nothingToOrder: "Nothing needs to be ordered in this period.",
  noSupplierMatch: "No supplier or vendor with that name has anything to order.",
  noProducts: "No tracked product matches that search.",
  noActions: "There is nothing to do this week.",
  noOrders: "No purchase orders are open.",
  noAccuracy: "No month has been graded yet. The first grade appears after the first full month of forecasts.",
  emptyQuery: "Give a product title, variant name or SKU to look up.",
  failed: "Keha Inventory Intelligence could not load this right now.",
  slow: "Keha Inventory Intelligence took too long to answer. Try again in a moment.",
} as const;

// ── Inputs (from the query string; Sidekick fills them from tools.json) ─────

const clip = (s: string, max: number) => s.trim().replace(/\s+/g, " ").slice(0, max);

/** A free-text input: trimmed, ≤ 200 characters, null when empty. */
export function readText(v: string | null | undefined): string | null {
  const s = clip(String(v ?? ""), 200);
  return s ? s : null;
}

/** within_days: whole days 1…90, default 14. */
export function readWithinDays(v: string | null | undefined): number {
  const n = Number(String(v ?? "").trim());
  if (!String(v ?? "").trim() || !Number.isFinite(n)) return DEFAULT_WITHIN_DAYS;
  return Math.min(MAX_WITHIN_DAYS, Math.max(1, Math.round(n)));
}

export const ACTION_KIND_INPUTS = ["reorder", "bridge", "push", "fix", "clear"] as const;
export type ActionKindInput = (typeof ACTION_KIND_INPUTS)[number];

export function readActionKind(v: string | null | undefined): ActionKindInput | null {
  const s = String(v ?? "").trim().toLowerCase();
  return (ACTION_KIND_INPUTS as readonly string[]).includes(s) ? (s as ActionKindInput) : null;
}

export const PO_STATUS_INPUTS = ["draft", "sent", "confirmed"] as const;
export type PoStatusInput = (typeof PO_STATUS_INPUTS)[number];

export function readPoStatus(v: string | null | undefined): PoStatusInput | null {
  const s = String(v ?? "").trim().toLowerCase();
  return (PO_STATUS_INPUTS as readonly string[]).includes(s) ? (s as PoStatusInput) : null;
}

/** months for the accuracy tool: 1…12, default 3. */
export function readMonths(v: string | null | undefined): number {
  const n = Number(String(v ?? "").trim());
  if (!String(v ?? "").trim() || !Number.isFinite(n)) return 3;
  return Math.min(12, Math.max(1, Math.round(n)));
}

/** Search words: at most 5 words of ≥ 1 character, lowercased duplicates removed. */
export function searchWords(q: string | null): string[] {
  if (!q) return [];
  const out: string[] = [];
  for (const w of q.split(/[\s,/]+/)) {
    const word = w.trim().slice(0, 60);
    if (word && !out.some((x) => x.toLowerCase() === word.toLowerCase())) out.push(word);
    if (out.length >= 5) break;
  }
  return out;
}

// ── Formatting ──────────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from `today` to `day` (both "YYYY-MM-DD"); null when either is not a day. */
export function daysBetween(today: string, day: string | null | undefined): number | null {
  if (!day || !DAY.test(day) || !DAY.test(today)) return null;
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** "2026-10-24" → "Sat 24 Oct 2026 (in 7 days)"; "today", "tomorrow", "3 days ago". */
export function dayLabel(day: string | null | undefined, today: string): string | null {
  if (!day || !DAY.test(day)) return null;
  const d = new Date(`${day}T12:00:00Z`);
  const date = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).replace(/,/g, "");
  const n = daysBetween(today, day);
  if (n === null) return date;
  const rel = n === 0 ? "today" : n === 1 ? "tomorrow" : n === -1 ? "yesterday" : n > 0 ? `in ${n} days` : `${-n} days ago`;
  return `${date} (${rel})`;
}

/** An app page as a Sidekick link: "/app/reorder?x=1" → "app://app/reorder?x=1" (Shopify's `app:` protocol). */
export function appUrl(path: string): string {
  return `app://${path.replace(/^\/+/, "")}`;
}

/** Numeric tail of a Shopify gid ("gid://shopify/ProductVariant/12" → "12"). */
export function gidTail(gid: string | null | undefined): string | null {
  const m = /^gid:\/\/shopify\/[A-Za-z]+\/(\d{1,20})$/.exec(String(gid ?? ""));
  return m ? m[1]! : null;
}

/** The Reorder page with these variants highlighted (numeric ids, at most 50: parseVariantsWithQty reads them). */
export function reorderPath(variantIds: readonly string[]): string {
  const ids = [...new Set(variantIds.map(gidTail).filter((x): x is string => !!x))].slice(0, 50);
  return ids.length ? `/app/reorder?variants=${ids.join(",")}` : "/app/reorder";
}

/** Our variant page. */
export function variantPath(variantId: string): string {
  const n = gidTail(variantId);
  return n ? `/app/products/${n}` : "/app/products";
}

/** Money rounded to cents; null stays null. */
export function money(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

/** "Default Title" is Shopify's name for a product's only variant. */
export function displayName(productTitle: string, variantTitle: string | null | undefined): string {
  const v = (variantTitle ?? "").trim();
  return v && v !== "Default Title" ? `${productTitle} — ${v}` : productTitle;
}

// ── Response shapes ─────────────────────────────────────────────────────────

export type ResourceLink = {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType: string;
  _meta: Record<string, unknown>;
};

export type SidekickResponse = {
  results?: ResourceLink[];
  /** A neutral sentence when there is nothing to return. */
  message?: string;
  /** Rows left out ("Showing 15 of 40 …"). */
  note?: string;
  [key: string]: unknown;
};

export function link(uri: string, name: string, mimeType: string, meta: Record<string, unknown>): ResourceLink {
  return { type: "resource_link", uri, name, mimeType, _meta: dropUndefined(meta) };
}

function dropUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

export const sizeOf = (r: unknown) => JSON.stringify(r).length;

/**
 * Keeps a response under the budget: at most `maxRows` results, then rows are
 * dropped from the end until the JSON fits. `total` is how many rows exist
 * (before any cap) and is reported in `note` when rows were left out.
 */
export function fitResponse(
  r: SidekickResponse,
  opts: { total?: number; maxRows?: number; maxChars?: number; what?: string } = {},
): SidekickResponse {
  const maxChars = opts.maxChars ?? RESPONSE_MAX_CHARS;
  const results = r.results ?? [];
  const total = Math.max(opts.total ?? results.length, results.length);
  let shown = results.slice(0, opts.maxRows ?? MAX_ROWS);
  const build = (rows: ResourceLink[]): SidekickResponse => {
    const out: SidekickResponse = { ...r, results: rows };
    if (rows.length < total) {
      out.note = `Showing ${rows.length} of ${total} ${opts.what ?? "rows"}; ${total - rows.length} more are in the app.`;
    }
    return out;
  };
  let out = build(shown);
  while (shown.length > 0 && sizeOf(out) > maxChars) {
    shown = shown.slice(0, -1);
    out = build(shown);
  }
  return out;
}

// ── Order plan ──────────────────────────────────────────────────────────────

/** One supplier group as the order plan source hands it over (from lib/reorder-shared ReorderGroup). */
export type PlanGroupIn = {
  key: string;
  kind: "supplier" | "vendor";
  supplierId: string | null;
  name: string;
  leadTimeDays: number;
  currency: string;
  lines: {
    variantId: string;
    productTitle: string;
    variantTitle: string;
    sku: string | null;
    onHand: number | null;
    daysLeft: number | null;
    orderBy: string | null;
    suggested: number;
    unitCost: number | null;
  }[];
};

export type OrderPlanOptions = { supplier: string | null; withinDays: number };

/** A line counts in the window when its order-by date is on or before the cutoff, or unknown. */
export function lineInWindow(orderBy: string | null, cutoff: string): boolean {
  return !orderBy || orderBy <= cutoff;
}

export function supplierMatches(name: string, q: string | null): boolean {
  if (!q) return true;
  return (name || "").toLowerCase().includes(q.toLowerCase());
}

function groupUri(g: Pick<PlanGroupIn, "kind" | "supplierId" | "name">): string {
  return g.kind === "supplier" && g.supplierId
    ? `gid://keha-inventory/Supplier/${g.supplierId}`
    : `gid://keha-inventory/Vendor/${encodeURIComponent(g.name || "none")}`;
}

/**
 * What to order and from whom, by order-by date. `today` and `cutoff` are store-local
 * days. Cash per currency counts only lines with a unit cost; `lines_without_cost`
 * says how many were left out of it.
 */
export function orderPlanResponse(
  groups: readonly PlanGroupIn[],
  opts: OrderPlanOptions,
  ctx: { today: string; cutoff: string; storeCurrency: string },
): SidekickResponse {
  const picked = groups
    .filter((g) => supplierMatches(g.name, opts.supplier))
    .map((g) => ({ ...g, lines: g.lines.filter((l) => l.suggested > 0 && lineInWindow(l.orderBy, ctx.cutoff)) }))
    .filter((g) => g.lines.length > 0);
  const base = { within_days: opts.withinDays, order_by_until: ctx.cutoff, store_currency: ctx.storeCurrency, url: appUrl("/app/reorder") };
  if (!picked.length) {
    return { ...base, results: [], message: opts.supplier && groups.length ? MSG.noSupplierMatch : MSG.nothingToOrder };
  }
  const cash = new Map<string, { amount: number; withoutCost: number }>();
  let units = 0;
  const results = picked.map((g) => {
    let gUnits = 0;
    let gCost = 0;
    let costed = 0;
    let orderBy: string | null = null;
    for (const l of g.lines) {
      gUnits += l.suggested;
      if (l.unitCost !== null) {
        gCost += l.unitCost * l.suggested;
        costed++;
      }
      if (l.orderBy && (!orderBy || l.orderBy < orderBy)) orderBy = l.orderBy;
    }
    const withoutCost = g.lines.length - costed;
    units += gUnits;
    const c = cash.get(g.currency) ?? { amount: 0, withoutCost: 0 };
    c.amount += gCost;
    c.withoutCost += withoutCost;
    cash.set(g.currency, c);
    const shown = g.lines.slice(0, MAX_GROUP_LINES);
    return link(groupUri(g), g.name || "Products without a vendor", MIME.supplierOrder, {
      grouped_by: g.kind === "supplier" ? "supplier" : "vendor (no supplier set)",
      order_by: orderBy,
      order_by_label: dayLabel(orderBy, ctx.today),
      lead_time_days: g.leadTimeDays,
      units: gUnits,
      cost: costed ? money(gCost) : null,
      currency: g.currency,
      lines_without_cost: withoutCost || undefined,
      lines: shown.map((l) => ({
        product: displayName(l.productTitle, l.variantTitle),
        sku: l.sku ?? undefined,
        variant_gid: l.variantId,
        order_qty: l.suggested,
        order_by: l.orderBy,
        days_left: l.daysLeft === null ? null : Math.max(0, Math.floor(l.daysLeft)),
        on_hand: l.onHand,
      })),
      more_lines: g.lines.length > shown.length ? g.lines.length - shown.length : undefined,
      url: appUrl(reorderPath(g.lines.map((l) => l.variantId))),
    });
  });
  return fitResponse(
    {
      ...base,
      results,
      totals: {
        suppliers: picked.length,
        units,
        cash: [...cash].map(([currency, c]) => ({
          currency,
          amount: money(c.amount),
          lines_without_cost: c.withoutCost || undefined,
        })),
      },
    },
    { total: picked.length, what: "suppliers" },
  );
}

// ── Product stock ───────────────────────────────────────────────────────────

/** The app's own status words (lib/products-shared statusLabel, English). */
export const STATUS_WORDS: Record<string, string> = {
  out: "Out",
  running_low: "Running low",
  healthy: "Healthy",
  too_much: "Too much",
  dead: "Dead",
  not_enough_data: "Not enough data",
};

export type ProductStockIn = {
  id: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  status: string | null;
  onHand: number | null;
  incoming: number | null;
  rate: number | null;
  daysLeft: number | null;
  neverRunsOut: boolean;
  orderBy: string | null;
  orderQty: number | null;
  onOrder: number;
  onOrderArrival: string | null;
};

/**
 * One row per matching variant. `forecast` false: days left, order-by and the
 * suggested quantity are left out (not null — they are not "unknown").
 */
export function productStockResponse(
  rows: readonly ProductStockIn[],
  ctx: { query: string; total: number; forecast: boolean; today: string },
): SidekickResponse {
  if (!rows.length) return { query: ctx.query, results: [], message: MSG.noProducts };
  const results = rows.map((r) => {
    const meta: Record<string, unknown> = {
      product_gid: r.productId,
      sku: r.sku ?? undefined,
      status: r.status ? (STATUS_WORDS[r.status] ?? null) : null,
      on_hand: r.onHand,
      incoming: r.incoming,
      on_order_with_keha: r.onOrder > 0 ? r.onOrder : undefined,
      keha_order_arrival: r.onOrder > 0 ? r.onOrderArrival : undefined,
      keha_order_arrival_label: r.onOrder > 0 ? (dayLabel(r.onOrderArrival, ctx.today) ?? undefined) : undefined,
      sales_per_day: r.rate === null ? null : Math.round(r.rate * 10) / 10,
    };
    if (ctx.forecast) {
      meta.days_left = r.neverRunsOut ? "never runs out at the current pace" : r.daysLeft === null ? null : Math.max(0, Math.floor(r.daysLeft));
      meta.order_by = r.orderBy;
      meta.order_by_label = dayLabel(r.orderBy, ctx.today);
      meta.suggested_order_qty = r.orderQty;
    }
    meta.url = appUrl(variantPath(r.id));
    return link(r.id, displayName(r.productTitle, r.variantTitle), MIME.variant, meta);
  });
  return fitResponse({ query: ctx.query, results }, { total: ctx.total, what: "matching variants" });
}

// ── Action list ─────────────────────────────────────────────────────────────

export const KIND_WORDS: Record<string, string> = {
  reorder: "Reorder",
  bridge: "Bridge the gap (preorders or back-in-stock sign-ups)",
  push: "Push (promote it)",
  fix_falling: "Fix: falling sales",
  fix_sizes: "Fix: missing sizes",
  fix_page: "Fix: product page",
  fix_returns: "Fix: returns",
  clear: "Clear (discount slow or dead stock)",
};

export type ActionIn = {
  kind: string;
  tab: string;
  productId: string;
  productTitle: string | null;
  variants: string[];
  amount: number;
  currency: string;
  reasonText: string;
  path: string;
};

export function actionListResponse(
  rows: readonly ActionIn[],
  ctx: { kind: ActionKindInput | null; currency: string; limited: number | null },
): SidekickResponse {
  const picked = ctx.kind ? rows.filter((r) => r.tab === ctx.kind) : rows;
  const base = { kind: ctx.kind ?? "all", currency: ctx.currency, url: appUrl(ctx.kind ? `/app?tab=${ctx.kind}` : "/app") };
  if (!picked.length) return { ...base, results: [], message: MSG.noActions };
  const results = picked.map((r) =>
    link(r.productId, r.productTitle ?? "—", MIME.action, {
      action: KIND_WORDS[r.kind] ?? r.kind,
      variants: r.variants.length ? r.variants.join(", ") : undefined,
      money_at_stake: money(r.amount),
      currency: r.currency !== ctx.currency ? r.currency : undefined,
      why: r.reasonText || undefined,
      url: appUrl(r.path),
    }),
  );
  const out = fitResponse({ ...base, results }, { total: picked.length, what: "actions" });
  // Free shows the largest actions only (the app's own limit): say so plainly, nothing more.
  if (ctx.limited !== null && !out.note) out.note = `Ranked by money at stake; the list covers the ${ctx.limited} largest actions.`;
  return out;
}

// ── Money at stake ──────────────────────────────────────────────────────────

/** The card titles as Home shows them (lib/dashboard-shared moneyCardTitle, English). */
export const MONEY_TITLES: Record<MoneyCardKey, string> = {
  atRisk: "Sales at risk (next 28 days)",
  lost90: "Sales lost to sell-outs (last 90 days)",
  cashStuck: "Cash stuck (too much stock and dead stock)",
  soldOutTraffic: "Sold-out page visits (last 30 days)",
};

export type MoneyIn = {
  day: string;
  currency: string;
  refresh: "monthly" | "daily";
  cards: { key: MoneyCardKey; value: number | null; how: string }[];
  dead: { cash: number | null; units: number | null; variants: number; retail: boolean; deadDays: number } | null;
};

export function moneyResponse(m: MoneyIn, today: string): SidekickResponse {
  return {
    as_of: m.day,
    as_of_label: dayLabel(m.day, today),
    currency: m.currency,
    refreshed: m.refresh,
    cards: m.cards.map((c) => ({ name: MONEY_TITLES[c.key], amount: money(c.value), how_we_got_this: c.how || null })),
    dead_stock: m.dead
      ? {
          amount: money(m.dead.cash),
          units: m.dead.units,
          variants: m.dead.variants,
          valued_at: m.dead.retail ? "cost, or retail price where a variant has no cost" : "cost",
          how_we_got_this: `Stock on hand now of every variant with status Dead (no sale for ${m.dead.deadDays} days or more), in the locations that sell online.`,
        }
      : undefined,
    url: appUrl("/app"),
  };
}

// ── Purchase orders ─────────────────────────────────────────────────────────

export const PO_STATUS_WORDS: Record<string, string> = {
  draft: "Draft (not sent yet)",
  sent: "Sent",
  confirmed: "Confirmed by the supplier",
};

export type PurchaseOrderIn = {
  id: string;
  number: string;
  source: "keha" | "shopify";
  status: string;
  supplierName: string | null;
  units: number;
  cost: number | null;
  currency: string | null;
  arrival: string | null;
  createdAt: string;
};

export function purchaseOrdersResponse(
  rows: readonly PurchaseOrderIn[],
  ctx: { status: PoStatusInput | null; supplier: string | null; today: string; storeCurrency: string },
): SidekickResponse {
  const picked = rows.filter(
    (r) => (!ctx.status || r.status === ctx.status) && (!ctx.supplier || supplierMatches(r.supplierName ?? "", ctx.supplier)),
  );
  const base = { url: appUrl("/app/reorder") };
  if (!picked.length) return { ...base, results: [], message: MSG.noOrders };
  const results = picked.map((r) =>
    link(`gid://keha-inventory/PurchaseOrder/${r.id}`, `${r.number}${r.supplierName ? ` — ${r.supplierName}` : ""}`, MIME.purchaseOrder, {
      created_in: r.source === "shopify" ? "Shopify" : "Keha",
      status: r.source === "shopify" ? "Ordered" : (PO_STATUS_WORDS[r.status] ?? r.status),
      supplier: r.supplierName,
      expected_arrival: r.arrival,
      expected_arrival_label: dayLabel(r.arrival, ctx.today),
      units: r.units,
      value: money(r.cost),
      currency: r.currency || ctx.storeCurrency,
      created: r.createdAt.slice(0, 10),
      url: appUrl(`/app/reorder/${encodeURIComponent(r.id)}`),
    }),
  );
  return fitResponse({ ...base, results }, { total: picked.length, what: "open orders" });
}

// ── Forecast accuracy ───────────────────────────────────────────────────────

export type AccuracyIn = { month: string; storeErrorPct: number | null; top20ErrorPct: number | null; graded: number };

const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

export function accuracyResponse(rows: readonly AccuracyIn[]): SidekickResponse {
  const base = {
    how_we_got_this:
      "Each month the forecast for the next month is saved, then compared with what really sold. Error = how far the forecast was from actual units sold, in percent (lower is better).",
    url: appUrl("/app/planner"),
  };
  if (!rows.length) return { ...base, message: MSG.noAccuracy };
  return {
    ...base,
    months: rows.map((r) => ({
      month: r.month.slice(0, 7),
      store_total_error_pct: pct(r.storeErrorPct),
      top_20_products_error_pct: pct(r.top20ErrorPct),
      variants_graded: r.graded,
    })),
  };
}
