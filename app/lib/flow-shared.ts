/**
 * Shopify Flow triggers (spec §11; plan feature `flowTriggers` = Growth; task 2.6).
 * Pure: which products are in each trigger's state, the payloads, and the
 * episode rule. Firing is app/services/flow.server.ts from the hourly alerts job.
 *
 * Triggers (extensions/keha-inventory-flow/*.extension.toml — keys must match
 * FLOW_FIELDS; tests/flow-extensions.test.ts checks both ways):
 *  - "Product needs reorder": a variant is running low or out with a suggested
 *    order quantity > 0. Per product, the variant that runs out first.
 *  - "Product became dead stock": every planned variant of the product is Dead.
 *
 * Notification triggers (owner decision 2026-10-18: no paid email provider — the merchant gets
 * Keha's summaries by email through Flow's "Send internal email" action; every plan, like the
 * Monday email they replace; docs/FLOW-TEMPLATES.md):
 *  - "Weekly order plan ready": the Monday summary, once per store week (services/monday).
 *  - "First order plan ready": once, when the first read finished and the plan is built
 *    (services/plan-ready — where the one-time "plan is ready" email goes out with a provider).
 * Instant alerts reuse "Product needs reorder" (a best seller running out before stock can
 * arrive, or a busy product selling out, is a product Keha suggests reordering) — no third trigger.
 *
 * Episode rule (chosen over "every 30 days"): a trigger fires once when a product
 * enters the state and fires again only after the product has LEFT that state
 * and come back. Each fire is an AlertLog row (kind flow_reorder / flow_dead,
 * channel "flow"); when the product leaves the state an "episode ended" row
 * (channel "flow_end") is written. The latest row per (product, kind) decides.
 * Why: a merchant's Flow (e.g. "create a task", "email the buyer") should run
 * once per real event, not every month while nothing changed.
 */

/** The Shopify Flow app in the merchant's admin (App Bridge resolves shopify://admin/… links). */
export const SHOPIFY_FLOW_ADMIN = "shopify://admin/apps/flow";

export const FLOW_NEEDS_REORDER = "product-needs-reorder";
export const FLOW_WENT_DEAD = "product-went-dead";
export type FlowHandle = typeof FLOW_NEEDS_REORDER | typeof FLOW_WENT_DEAD;
export const FLOW_WEEKLY_PLAN = "weekly-order-plan-ready";
export const FLOW_FIRST_PLAN = "first-order-plan-ready";
/** The notification triggers (one store-level event each, no product). */
export type NotifyHandle = typeof FLOW_WEEKLY_PLAN | typeof FLOW_FIRST_PLAN;
export type AnyFlowHandle = FlowHandle | NotifyHandle;

/**
 * Payload keys per trigger, exactly as declared in each extension toml.
 * Custom keys are letters and spaces only (Shopify rejects anything else at
 * deploy). `product_id` is the key Shopify uses for a product_reference field.
 */
export const FLOW_FIELDS: Record<AnyFlowHandle, readonly string[]> = {
  [FLOW_NEEDS_REORDER]: ["product_id", "Variant ID", "Days of stock", "Order by", "Suggested quantity"],
  [FLOW_WENT_DEAD]: ["product_id", "Cash tied up"],
  [FLOW_WEEKLY_PLAN]: ["Subject", "Summary text", "Orders due this week", "Cash due this week", "Order plan link"],
  [FLOW_FIRST_PLAN]: ["Subject", "Summary text", "Order plan link"],
};

/** OwnerEmailLog kinds: each notification trigger fires once per period (like the email it stands in for). */
export const FLOW_NOTIFY_KIND: Record<NotifyHandle, string> = {
  [FLOW_WEEKLY_PLAN]: "monday_flow",
  [FLOW_FIRST_PLAN]: "plan_ready_flow",
};

/**
 * Flow text fields are strings; keep each well inside what an email subject / body can carry.
 * (Flow documents no limit for trigger strings; this keeps a runaway summary from being refused.)
 */
export const FLOW_TEXT_MAX = 10_000;
const DASH = "—";
const clip = (s: string, max = FLOW_TEXT_MAX) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export type WeeklyPlanFields = {
  subject: string;
  summary: string;
  /** Orders (suppliers, or products on Free) due this week; null = not known (sent as "—", never 0). */
  ordersDue: number | null;
  /** Cash for those orders, already formatted in the store currency; null = not known ("—"). */
  cashDue: string | null;
  /** Admin link to the order plan. */
  link: string;
  numberLocale: string;
};

export function weeklyPlanPayload(f: WeeklyPlanFields): Record<string, unknown> {
  return {
    Subject: clip(f.subject, 250),
    "Summary text": clip(f.summary),
    "Orders due this week": f.ordersDue == null ? DASH : new Intl.NumberFormat(f.numberLocale).format(f.ordersDue),
    "Cash due this week": f.cashDue ?? DASH,
    "Order plan link": f.link,
  };
}

export function firstPlanPayload(f: { subject: string; summary: string; link: string }): Record<string, unknown> {
  return { Subject: clip(f.subject, 250), "Summary text": clip(f.summary), "Order plan link": f.link };
}

/** AlertLog.kind per trigger. */
export const FLOW_LOG_KIND: Record<FlowHandle, "flow_reorder" | "flow_dead"> = {
  [FLOW_NEEDS_REORDER]: "flow_reorder",
  [FLOW_WENT_DEAD]: "flow_dead",
};
/** AlertLog.channel: a fire, and the end of an episode. */
export const FLOW_FIRED = "flow";
export const FLOW_ENDED = "flow_end";
/**
 * AlertLog.channel: Shopify refused the trigger (userErrors, e.g. the Flow
 * extension isn't released yet). Not a fire: tried again after
 * FLOW_REJECT_RETRY_MS, at most FLOW_MAX_REJECTIONS times per (product,
 * trigger) in FLOW_REJECTION_WINDOW_DAYS — so an unreleased extension doesn't
 * use up every product's one fire, and doesn't hammer Shopify either
 * (review fix 2026-10-17).
 */
export const FLOW_REJECTED = "flow_rejected";
export const FLOW_REJECT_RETRY_MS = 24 * 60 * 60 * 1000;
export const FLOW_MAX_REJECTIONS = 7;
export const FLOW_REJECTION_WINDOW_DAYS = 30;

/** Triggers sent per store per hourly tick (the rest go on the next tick). */
export const MAX_FLOW_PER_TICK = 25;

/** gid://shopify/Product/123 → 123 (what a product_reference payload takes). */
export function legacyId(gid: string): number | null {
  const m = /^gid:\/\/shopify\/\w+\/(\d+)$/.exec(gid);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

export type FlowMetric = {
  variantId: string;
  productId: string;
  status: string;
  daysLeft: number | null;
  orderQty: number | null;
  /** YYYY-MM-DD or null. */
  orderBy: string | null;
};

export type ReorderState = { variantId: string; daysLeft: number; orderBy: string; orderQty: number };

/** Products that need a reorder: running low / out with an order quantity, and a known days-left and order-by date. */
export function needsReorderProducts(metrics: FlowMetric[]): Map<string, ReorderState> {
  const out = new Map<string, ReorderState>();
  for (const m of metrics) {
    if (m.status !== "running_low" && m.status !== "out") continue;
    if (m.orderQty == null || m.orderQty <= 0 || m.daysLeft == null || !Number.isFinite(m.daysLeft) || !m.orderBy) continue;
    const cand: ReorderState = { variantId: m.variantId, daysLeft: m.daysLeft, orderBy: m.orderBy, orderQty: m.orderQty };
    const cur = out.get(m.productId);
    if (
      !cur ||
      cand.daysLeft < cur.daysLeft ||
      (cand.daysLeft === cur.daysLeft && (cand.orderQty > cur.orderQty || (cand.orderQty === cur.orderQty && cand.variantId < cur.variantId)))
    )
      out.set(m.productId, cand);
  }
  return out;
}

/** Products whose every planned variant is Dead. */
export function deadProductIds(metrics: Pick<FlowMetric, "productId" | "status">[]): Set<string> {
  const all = new Map<string, boolean>();
  for (const m of metrics) all.set(m.productId, (all.get(m.productId) ?? true) && m.status === "dead");
  return new Set([...all].filter(([, dead]) => dead).map(([p]) => p));
}

/**
 * Cash stuck in one dead variant (spec §7.6): cost × on hand, retail price when
 * the cost is missing; null when neither is known (the trigger then waits —
 * never a made-up 0).
 */
export function variantCash(inputs: Record<string, unknown> | undefined): number | null {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const onHand = n(inputs?.onHand);
  const unit = n(inputs?.cost) ?? n(inputs?.price);
  if (onHand == null || unit == null) return null;
  return Math.max(0, onHand) * unit;
}

/** Σ variant cash; null when any variant's value is unknown. */
export function productCash(variantIds: string[], cashOf: (variantId: string) => number | null): number | null {
  let total = 0;
  for (const v of variantIds) {
    const c = cashOf(v);
    if (c == null) return null;
    total += c;
  }
  return Math.round(total * 100) / 100;
}

export function needsReorderPayload(productId: string, s: ReorderState): Record<string, unknown> | null {
  const id = legacyId(productId);
  if (id == null) return null;
  return {
    product_id: id,
    "Variant ID": s.variantId,
    "Days of stock": Math.max(0, Math.round(s.daysLeft * 10) / 10),
    "Order by": s.orderBy,
    "Suggested quantity": s.orderQty,
  };
}

export function wentDeadPayload(productId: string, cashStuck: number): Record<string, unknown> | null {
  const id = legacyId(productId);
  if (id == null) return null;
  return { product_id: id, "Cash tied up": Math.round(cashStuck * 100) / 100 };
}

/** Every declared key present (Shopify requires all of them), and nothing else. */
export function payloadMatches(handle: AnyFlowHandle, payload: Record<string, unknown>): boolean {
  const keys = Object.keys(payload).sort();
  const want = [...FLOW_FIELDS[handle]].sort();
  return JSON.stringify(keys) === JSON.stringify(want) && keys.every((k) => payload[k] !== null && payload[k] !== undefined);
}

/**
 * The episode rule. `latest` = channel of the newest AlertLog row for this
 * (product, trigger), or undefined when there is none.
 *  - in the state, no fire yet in this episode → "fire";
 *  - in the state after a rejection → "fire" again once the rejection is
 *    FLOW_REJECT_RETRY_MS old and fewer than FLOW_MAX_REJECTIONS were logged
 *    in the window (`retry`; without it a rejection waits) — else nothing;
 *  - out of the state after a fire or a rejection → "end" (the next entry fires again);
 *  - otherwise nothing.
 */
export function episodeStep(
  latest: string | undefined,
  inState: boolean,
  retry?: { latestAt: Date; rejections: number; now: Date },
): "fire" | "end" | "none" {
  const open = latest === FLOW_FIRED || latest === FLOW_REJECTED;
  if (!inState) return open ? "end" : "none";
  if (latest === FLOW_FIRED) return "none";
  if (latest === FLOW_REJECTED) {
    if (!retry) return "none";
    const waited = retry.now.getTime() - retry.latestAt.getTime() >= FLOW_REJECT_RETRY_MS;
    return waited && retry.rejections < FLOW_MAX_REJECTIONS ? "fire" : "none";
  }
  return "fire";
}
