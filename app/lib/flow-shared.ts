/**
 * Shopify Flow triggers (spec §11; plan feature `flowTriggers` = Growth; task 2.6).
 * Pure: which products are in each trigger's state, the payloads, and the
 * episode rule. Firing is app/services/flow.server.ts from the hourly alerts job.
 *
 * Triggers (extensions/keha-inventory-flow/*.extension.toml — keys must match
 * FLOW_FIELDS; tests/flow-extensions.test.ts checks both ways):
 *  - "Product needs reorder": a variant is running low or out with a suggested
 *    order quantity > 0. Per product, the variant that runs out first.
 *  - "Product went dead": every planned variant of the product is Dead.
 *
 * Episode rule (chosen over "every 30 days"): a trigger fires once when a product
 * enters the state and fires again only after the product has LEFT that state
 * and come back. Each fire is an AlertLog row (kind flow_reorder / flow_dead,
 * channel "flow"); when the product leaves the state an "episode ended" row
 * (channel "flow_end") is written. The latest row per (product, kind) decides.
 * Why: a merchant's Flow (e.g. "create a task", "email the buyer") should run
 * once per real event, not every month while nothing changed.
 */

export const FLOW_NEEDS_REORDER = "product-needs-reorder";
export const FLOW_WENT_DEAD = "product-went-dead";
export type FlowHandle = typeof FLOW_NEEDS_REORDER | typeof FLOW_WENT_DEAD;

/**
 * Payload keys per trigger, exactly as declared in each extension toml.
 * Custom keys are letters and spaces only (Shopify rejects anything else at
 * deploy). `product_id` is the key Shopify uses for a product_reference field.
 */
export const FLOW_FIELDS: Record<FlowHandle, readonly string[]> = {
  [FLOW_NEEDS_REORDER]: ["product_id", "Variant id", "Days left", "Order by", "Suggested quantity"],
  [FLOW_WENT_DEAD]: ["product_id", "Cash stuck"],
};

/** AlertLog.kind per trigger. */
export const FLOW_LOG_KIND: Record<FlowHandle, "flow_reorder" | "flow_dead"> = {
  [FLOW_NEEDS_REORDER]: "flow_reorder",
  [FLOW_WENT_DEAD]: "flow_dead",
};
/** AlertLog.channel: a fire, and the end of an episode. */
export const FLOW_FIRED = "flow";
export const FLOW_ENDED = "flow_end";

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
    "Variant id": s.variantId,
    "Days left": Math.max(0, Math.round(s.daysLeft * 10) / 10),
    "Order by": s.orderBy,
    "Suggested quantity": s.orderQty,
  };
}

export function wentDeadPayload(productId: string, cashStuck: number): Record<string, unknown> | null {
  const id = legacyId(productId);
  if (id == null) return null;
  return { product_id: id, "Cash stuck": Math.round(cashStuck * 100) / 100 };
}

/** Every declared key present (Shopify requires all of them), and nothing else. */
export function payloadMatches(handle: FlowHandle, payload: Record<string, unknown>): boolean {
  const keys = Object.keys(payload).sort();
  const want = [...FLOW_FIELDS[handle]].sort();
  return JSON.stringify(keys) === JSON.stringify(want) && keys.every((k) => payload[k] !== null && payload[k] !== undefined);
}

/**
 * The episode rule. `latest` = channel of the newest AlertLog row for this
 * (product, trigger), or undefined when there is none.
 *  - in the state, no fire yet in this episode → "fire";
 *  - out of the state after a fire → "end" (the next entry fires again);
 *  - otherwise nothing.
 */
export function episodeStep(latest: string | undefined, inState: boolean): "fire" | "end" | "none" {
  if (inState) return latest === FLOW_FIRED ? "none" : "fire";
  return latest === FLOW_FIRED ? "end" : "none";
}
