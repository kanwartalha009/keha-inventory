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
import { outcomeOf, outcomeReasonText, planOutcome, worstOutcome, type Outcome } from "./outcome-shared";
import { isVariantStatus } from "./products-shared";
import type { MoneyCardKey } from "./money-shared";
import type { PlanNotReady } from "./dashboard-shared";
import type { MoneyRefresh } from "./plan-shared";
import { addDays, type DayKey } from "./engine/dates-shared";
import { PLAN_WEEKS, byWeek, bySupplier, cashTotals, dueDay, dueNote, ordersDue, planEnd, type DueNote } from "./engine/forward-plan-shared";
import { cashWeeks } from "./cash-shared";
import {
  orderLink,
  supplierName,
  type OrderPlanData,
  type PlanSupplierInfo,
  type PreviewRow,
} from "./order-plan-shared";

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
  notAvailable: "This information isn't available for this store in Keha Inventory Planner.",
  syncing: "Keha Inventory Planner is still reading this store's data. The numbers appear once the first read is done.",
  noTracked: "No products in this store track their stock quantity, so there is nothing to plan yet.",
  noSales: "There are fewer than 14 days of sales so far, so there is no advice yet.",
  nothingToOrder: "Nothing needs to be ordered in this period.",
  noSupplierMatch: "No supplier or vendor with that name has anything to order.",
  noProducts: "No tracked product matches that search.",
  noActions: "There is nothing to do this week.",
  noOrders: "No purchase orders are open.",
  noAccuracy: "No month has been graded yet. The first grade appears after the first full month of forecasts.",
  emptyQuery: "Give a product title, variant name or SKU to look up.",
  failed: "Keha Inventory Planner could not load this right now.",
  slow: "Keha Inventory Planner took too long to answer. Try again in a moment.",
} as const;

/**
 * The order plan isn't ready (Home's state — the same rule as the app's screens, 2026-10-17):
 * say so and why, so an empty answer is never read as "nothing needs ordering".
 */
export function notReadyMessage(r: PlanNotReady, today: string): string {
  switch (r.state) {
    case "syncing":
      return `Order suggestions aren't ready yet: Keha Inventory Planner is still reading this store's data (${r.percent}% done). This doesn't mean nothing needs ordering.`;
    case "noSales": {
      const when = r.readyOn ? dayLabel(r.readyOn, today) : null;
      return `Order suggestions aren't ready yet: the first ones need 14 days of sales${when ? `, expected on ${when}` : ""}. This doesn't mean nothing needs ordering.`;
    }
    case "noTracked":
      return MSG.noTracked;
  }
}

/** Products left out of the order suggestions and why ("1 product can't be planned yet …"); null when none. */
export function cantPlanNote(c: { noData: number; dead: number } | null | undefined): string | null {
  if (!c) return null;
  const parts: string[] = [];
  if (c.noData > 0)
    parts.push(c.noData === 1 ? "1 product can't be planned yet — not enough sales history." : `${c.noData} products can't be planned yet — not enough sales history.`);
  if (c.dead > 0) parts.push(c.dead === 1 ? "1 product isn't selling (dead stock), so it isn't reordered." : `${c.dead} products aren't selling (dead stock), so they aren't reordered.`);
  return parts.length ? `${parts.join(" ")} They are not in this answer.` : null;
}

/** The answer of get_order_plan / get_product_stock's order fields while the plan isn't ready. */
export function notReadyResponse(r: PlanNotReady, today: string, extra: Record<string, unknown> = {}): SidekickResponse {
  return { ...extra, ready: false, results: [], message: notReadyMessage(r, today) };
}

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

/** get_action_list `kind` values (tools.json enum): plain words. */
export const ACTION_KIND_INPUTS = ["reorder", "sold_out", "push", "fix", "clear"] as const;
/** The app's action tab the kind filters on (actions-shared tabs; "bridge" = a best seller sold out). */
export type ActionKindInput = "reorder" | "bridge" | "push" | "fix" | "clear";
/** Tab → the word Sidekick sees (and sent). */
const PUBLIC_KIND: Record<ActionKindInput, string> = { reorder: "reorder", bridge: "sold_out", push: "push", fix: "fix", clear: "clear" };

/** A kind from Sidekick → the app's tab. "sold_out" (or the old "bridge") is the sold-out tab. */
export function readActionKind(v: string | null | undefined): ActionKindInput | null {
  const s = String(v ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "sold_out" || s === "bridge") return "bridge";
  return s === "reorder" || s === "push" || s === "fix" || s === "clear" ? s : null;
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-12" (a Monday) → "Mon 12 Oct – Sun 18 Oct 2026". */
export function weekLabel(weekStartDay: DayKey): string {
  const a = new Date(`${weekStartDay}T12:00:00Z`);
  const b = new Date(`${addDays(weekStartDay, 6)}T12:00:00Z`);
  const part = (d: Date) => `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return `${part(a)} – ${part(b)} ${b.getUTCFullYear()}`;
}

/** "2026-10-24" → "Sat 24 Oct 2026 (in 7 days)"; "today", "tomorrow", "3 days ago". */
export function dayLabel(day: string | null | undefined, today: string): string | null {
  if (!day || !DAY.test(day)) return null;
  const d = new Date(`${day}T12:00:00Z`);
  // Fixed English names (ICU versions differ: "Sep" / "Sept").
  const date = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
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
//
// One source of truth with the Order plan screens: the forward order plan
// (models/order-plan.server loadOrderPlan → engine/forward-plan-shared). Day-0 orders are
// Order now's lines (/app/reorder), the 13 weeks are Next 13 weeks (/app/reorder/calendar),
// and Free gets the same read-only top-10 preview the Free Order now page shows.

export type OrderPlanOptions = { supplier: string | null; withinDays: number };

export function supplierMatches(name: string, q: string | null): boolean {
  if (!q) return true;
  return (name || "").toLowerCase().includes(q.toLowerCase());
}

function groupUri(s: PlanSupplierInfo | undefined, key: string): string {
  return s?.kind === "supplier" && s.supplierId
    ? `gid://keha-inventory/Supplier/${s.supplierId}`
    : `gid://keha-inventory/Vendor/${encodeURIComponent(s?.name || "none")}`;
}

/** The last order-by day a `within_days` window covers: today + days − 1; 90 = the whole calendar. */
export function windowEnd(today: DayKey, withinDays: number): DayKey {
  const end = planEnd(today);
  if (withinDays >= MAX_WITHIN_DAYS) return end;
  const last = addDays(today, withinDays - 1);
  return last < end ? last : end;
}

/** Why days_left is null when there is stock but no sale to measure a pace from (I-5: unknown, never ∞). */
export const NO_RECENT_SALES = "no recent sales";

/**
 * Days left, rounded down like the screens. Unknown is null; with stock and a measured pace of
 * zero it is null too, with `days_left_why: "no recent sales"` (as the screens show "—").
 */
export function daysLeftMeta(daysLeft: number | null | undefined, neverRunsOut: boolean | undefined): { days_left: number | null; days_left_why?: string } {
  if (neverRunsOut) return { days_left: null, days_left_why: NO_RECENT_SALES };
  return { days_left: daysLeft === null || daysLeft === undefined || !Number.isFinite(daysLeft) ? null : Math.max(0, Math.floor(daysLeft)) };
}

/** order_by_label of an overdue order with no date (already out, the day it ran out unknown — M3). */
const OVERDUE_NO_DATE = "due now — already out of stock, the day it ran out isn't known";
/**
 * A1: long overdue (the date would be more than lead time + cycle back) — the day it sold out, or
 * will; off season — the next order is the season's.
 */
/** The app's status word and its reason for Sidekick (the badge and the line under it on every screen). */
const statusMeta = (o: Outcome | null, today: DayKey) =>
  o ? { status: STATUS_WORDS[o.key] ?? undefined, status_reason: outcomeReasonText(o.reason, (x) => x, (d) => dayLabel(d, today) ?? d) || undefined } : {};

const dueLabel = (day: DayKey | null, overdue: boolean, today: DayKey, note?: DueNote | null) => {
  // The order-by date in words; how urgent it is comes from the status word next to it (`status`).
  if (!day && overdue && note?.soldOutSince) return `due now — sold out since ${dayLabel(note.soldOutSince, today)}`;
  if (!day && overdue && note?.runsOut) return `due now — ${note.belowSafety ? "its buffer is running low, lasts to" : "runs out"} ${dayLabel(note.runsOut, today)}`;
  if (day && !overdue && note?.nextSeason) return `next season: order by ${dayLabel(day, today)}`;
  return day ? dayLabel(day, today) : overdue ? OVERDUE_NO_DATE : null;
};

/**
 * What to order and from whom in the window, grouped by supplier (vendor when no supplier is
 * set), earliest order-by first, with the cash it needs; per-week cash when the window is
 * longer than two weeks. All costs are in the store currency (other currencies are unknown).
 */
export function orderPlanResponse(data: OrderPlanData, opts: OrderPlanOptions): SidekickResponse {
  const until = windowEnd(data.today, opts.withinDays);
  const name = (key: string) => supplierName(data, key, (s) => s);
  const events = data.events.filter((e) => e.orderBy <= until && supplierMatches(name(e.supplierKey), opts.supplier));
  const base = {
    within_days: opts.withinDays,
    order_by_until: until,
    currency: data.currency,
    url: appUrl("/app/reorder/calendar"),
    order_now_url: appUrl("/app/reorder"),
  };
  const notPlanned = cantPlanNote(data.cantPlan);
  if (!events.length) {
    const anyForSupplier = opts.supplier && data.events.some((e) => supplierMatches(name(e.supplierKey), opts.supplier));
    if (opts.supplier && !anyForSupplier) return { ...base, results: [], message: MSG.noSupplierMatch };
    // Never "nothing to order" without the products that couldn't be planned.
    return { ...base, results: [], message: notPlanned ? `${MSG.nothingToOrder} ${notPlanned}` : MSG.nothingToOrder, not_planned: notPlanned ?? undefined };
  }
  const groups = bySupplier(events);
  const results = groups.map((g) => {
    const shown = g.events.slice(0, MAX_GROUP_LINES);
    // The supplier's order-by date, as the Dashboard, Order now and the email show it (M2).
    const first = ordersDue(g.events).orderBy;
    const s = data.suppliers[g.supplierKey];
    return link(groupUri(s, g.supplierKey), name(g.supplierKey), MIME.supplierOrder, {
      grouped_by: s?.kind === "supplier" ? "supplier" : "vendor (no supplier set)",
      order_by: first,
      order_by_label: dueLabel(first, g.overdue, data.today, dueNote(g.events)),
      overdue: g.overdue || undefined,
      // Clarity pass: the supplier's most urgent status word, as the Dashboard shows it.
      ...statusMeta(worstOutcome(g.events.map((e) => planOutcome({ orderBy: dueDay(e), overdue: e.overdue, outlook: e.outlook ?? null, note: e.context ?? null }, data.today))), data.today),
      orders: g.lines,
      products: g.products,
      units: g.units,
      cost: money(g.cash),
      lines_without_cost: g.missingCost || undefined,
      lines: shown.map((e) => {
        const v = data.variants[e.variantId];
        return {
          product: displayName(v?.productTitle ?? "—", v?.variantTitle),
          sku: v?.sku ?? undefined,
          variant_gid: e.variantId,
          order_qty: e.qty,
          order_by: dueDay(e),
          overdue: e.overdue || undefined,
          ...statusMeta(planOutcome({ orderBy: dueDay(e), overdue: e.overdue, outlook: e.outlook ?? null, note: e.context ?? null }, data.today), data.today),
          arrives: e.arrives,
          cost: money(e.cost),
          ...daysLeftMeta(v?.daysLeft, v?.neverRunsOut),
        };
      }),
      more_lines: g.events.length > shown.length ? g.events.length - shown.length : undefined,
      url: appUrl(orderLink(g.events, g.supplierKey)),
    });
  });
  const totals = cashTotals(events);
  const out: SidekickResponse = {
    ...base,
    results,
    not_planned: notPlanned ?? undefined,
    totals: { suppliers: groups.length, orders: totals.lines, units: totals.units, cash: money(totals.cash), lines_without_cost: totals.missingCost || undefined },
  };
  if (opts.withinDays > 14) {
    // Supplier module: `cash` is what is PAID in the week (payment terms: deposits, balances,
    // freight & duty; without terms, the week's orders), what is still due on open orders included.
    const committed = (data.committed ?? []).filter((p) => supplierMatches(name(p.supplierKey), opts.supplier));
    const paid = cashWeeks(events, committed, data.today, PLAN_WEEKS);
    out.cash_per_week = byWeek(events, data.today)
      .map((w, i) => ({ w, p: paid[i] }))
      .filter(({ w, p }) => w.lines > 0 || (p?.total ?? 0) > 0)
      .map(({ w, p }) => {
        const cash = p && p.total > 0 ? p.total : w.cash === null ? null : 0;
        return {
          week_of: w.weekStart,
          week: weekLabel(w.weekStart),
          orders: w.lines,
          units: w.units,
          cash: money(cash),
          cash_on_open_orders: p && p.committed > 0 ? money(p.committed) : undefined,
          orders_value: w.cash !== null && cash !== null && Math.abs(w.cash - cash) > 0.005 ? money(w.cash) : undefined,
          lines_without_cost: w.missingCost || undefined,
        };
      });
    if (committed.length || events.some((e) => e.payments?.some((x) => x.kind !== "order")))
      out.cash_note = "cash = paid in that week (supplier payment terms; balances still due on open orders included). orders_value = the value of the orders placed that week, when different.";
  }
  return fitResponse(out, { total: groups.length, what: "suppliers" });
}

/** The read-only preview the app shows when the full order plan isn't part of the store's plan. */
export function orderPreviewResponse(rows: readonly PreviewRow[], data: Pick<OrderPlanData, "today" | "variants"> & Partial<Pick<OrderPlanData, "cantPlan">>): SidekickResponse {
  const base = { url: appUrl("/app/reorder") };
  const notPlanned = cantPlanNote(data.cantPlan);
  if (!rows.length) return { ...base, results: [], message: notPlanned ? `${MSG.nothingToOrder} ${notPlanned}` : MSG.nothingToOrder, not_planned: notPlanned ?? undefined };
  return {
    ...base,
    not_planned: notPlanned ?? undefined,
    shows: `The ${rows.length} most urgent products to order, most urgent first.`,
    results: rows.map((r) =>
      link(r.variantId, displayName(r.productTitle || "—", r.variantTitle), MIME.variant, {
        ...daysLeftMeta(r.daysLeft, r.neverRunsOut),
        order_by: r.orderBy,
        order_by_label: dueLabel(r.orderBy, r.overdue, data.today, r.dueNote),
        overdue: r.overdue || undefined,
        ...statusMeta(planOutcome({ orderBy: r.orderBy, overdue: r.overdue, outlook: r.outlook ?? null, note: r.dueNote ?? null }, data.today), data.today),
        suggested_order_qty: r.qty,
        sku: data.variants[r.variantId]?.sku ?? undefined,
      }),
    ),
  };
}

// ── Product stock ───────────────────────────────────────────────────────────

/** The app's own status words (lib/outcome-shared outcomeLabel, English; clarity pass 2026-10-23). */
export const STATUS_WORDS: Record<string, string> = {
  orderNow: "Order now",
  orderSoon: "Order soon",
  ok: "OK",
  tooMuch: "Too much",
  notSelling: "Not selling",
  learning: "Learning",
  dontReorder: "Don't reorder",
};

export type ProductStockIn = {
  id: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  status: string | null;
  /** The status words (lib/outcome-shared), when worked out. */
  outcome?: Outcome;
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
  ctx: { query: string; total: number; forecast: boolean; today: string; notReady?: PlanNotReady | null },
): SidekickResponse {
  if (!rows.length) return { query: ctx.query, results: [], message: MSG.noProducts };
  // Plan not ready: stock and sales stay, the order fields are unknown and the reason is given.
  const advice = ctx.notReady ? notReadyMessage(ctx.notReady, ctx.today) : null;
  const results = rows.map((r) => {
    // The page's status word; from the nightly numbers alone when the caller didn't work it out.
    const outcome =
      r.outcome ??
      (r.status && isVariantStatus(r.status)
        ? outcomeOf({ status: r.status, today: ctx.today, orderBy: ctx.forecast ? r.orderBy : null, overdue: false, onHand: r.onHand, daysLeft: ctx.forecast ? r.daysLeft : null })
        : null);
    const meta: Record<string, unknown> = {
      product_gid: r.productId,
      sku: r.sku ?? undefined,
      status: outcome ? (STATUS_WORDS[outcome.key] ?? null) : null,
      status_reason: outcome ? outcomeReasonText(outcome.reason, (x) => x, (d) => dayLabel(d, ctx.today) ?? d) || undefined : undefined,
      on_hand: r.onHand,
      incoming: r.incoming,
      on_order_with_keha: r.onOrder > 0 ? r.onOrder : undefined,
      keha_order_arrival: r.onOrder > 0 ? r.onOrderArrival : undefined,
      keha_order_arrival_label: r.onOrder > 0 ? (dayLabel(r.onOrderArrival, ctx.today) ?? undefined) : undefined,
      sales_per_day: r.rate === null ? null : Math.round(r.rate * 10) / 10,
    };
    if (ctx.forecast) {
      Object.assign(meta, daysLeftMeta(r.daysLeft, r.neverRunsOut));
      meta.order_by = advice ? null : r.orderBy;
      meta.order_by_label = advice ? null : dayLabel(r.orderBy, ctx.today);
      meta.suggested_order_qty = advice ? null : r.orderQty;
    }
    meta.url = appUrl(variantPath(r.id));
    return link(r.id, displayName(r.productTitle, r.variantTitle), MIME.variant, meta);
  });
  return fitResponse(advice ? { query: ctx.query, ready: false, order_advice: advice, results } : { query: ctx.query, results }, { total: ctx.total, what: "matching variants" });
}

// ── Action list ─────────────────────────────────────────────────────────────

export const KIND_WORDS: Record<string, string> = {
  reorder: "Reorder",
  bridge: "Stock gap: collect back-in-stock sign-ups until stock arrives",
  push: "Promote (products with enough stock)",
  fix_falling: "Product issue: falling sales",
  fix_sizes: "Product issue: missing sizes",
  fix_page: "Product issue: product page",
  fix_returns: "Product issue: returns",
  clear: "Clearance (discount overstock or dead stock)",
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
  const base = { kind: ctx.kind ? PUBLIC_KIND[ctx.kind] : "all", currency: ctx.currency, url: appUrl(ctx.kind ? `/app?tab=${ctx.kind}` : "/app") };
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
  atRisk: "Sales at risk, next 4 weeks",
  lost90: "Sales lost while sold out, last 90 days",
  cashStuck: "Cash tied up in slow stock (overstock and dead stock)",
  soldOutTraffic: "Sales missed on sold-out pages, last 30 days",
};

export type MoneyIn = {
  day: string;
  currency: string;
  refresh: MoneyRefresh;
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
          how_we_got_this: `Stock on hand now of every variant with status Dead stock (no sale for ${m.dead.deadDays} days or more), in the locations that sell online.`,
        }
      : undefined,
    url: appUrl("/app"),
  };
}

// ── Purchase orders ─────────────────────────────────────────────────────────

export const PO_STATUS_WORDS: Record<string, string> = {
  draft: "Draft (not ordered yet)",
  sent: "Ordered",
  confirmed: "Confirmed by the supplier",
};

export type PurchaseOrderIn = {
  id: string;
  number: string;
  source: "keha" | "shopify";
  status: string;
  supplierName: string | null;
  /** Units ordered. */
  units: number;
  /** Units still to arrive (ordered − received); `units` when unknown. */
  remaining?: number;
  cost: number | null;
  /** Value of the units still to arrive; `cost` when unknown. */
  remainingCost?: number | null;
  currency: string | null;
  /** Confirmed ship date + the supplier's transit days, else the lead-time estimate. */
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
  const base = { url: appUrl("/app/reorder/orders") };
  if (!picked.length) return { ...base, results: [], message: MSG.noOrders };
  const results = picked.map((r) =>
    link(`gid://keha-inventory/PurchaseOrder/${r.id}`, `${r.number}${r.supplierName ? ` — ${r.supplierName}` : ""}`, MIME.purchaseOrder, {
      created_in: r.source === "shopify" ? "Shopify" : "Keha",
      status: r.source === "shopify" ? "Ordered" : (PO_STATUS_WORDS[r.status] ?? r.status),
      supplier: r.supplierName,
      expected_arrival: r.arrival,
      expected_arrival_label: dayLabel(r.arrival, ctx.today),
      // What is still to come (a partly received order counts only the rest, as Order now).
      units: r.remaining ?? r.units,
      units_ordered: r.remaining !== undefined && r.remaining !== r.units ? r.units : undefined,
      value: money(r.remaining !== undefined && r.remaining !== r.units ? (r.remainingCost ?? null) : r.cost),
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
    url: appUrl("/app/reorder/season"),
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
