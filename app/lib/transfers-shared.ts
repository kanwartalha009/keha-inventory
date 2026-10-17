/**
 * Transfer plan: warehouse → stores (spec §4 J7, §6.4; Pro `transfers`). Pure, client-safe.
 *
 * Inputs are the per-location VariantMetric rows (compute-locations), the online pool's row,
 * and StockNow per location.
 *
 * Keep level of one metric = what the engine wants on hand: forecast demand over lead time +
 * order cycle, plus safety stock — rate × seasonal × trend × (lead + cycle) + the engine's
 * stored safety (inputs.safety = z × σ × √(lead + cycle); rows stored before it fall back to the
 * same formula from z, σ, lead and cycle). Unknown (null) when the metric has no sales rate yet
 * (fewer than 14 in-stock days) or its inputs are missing.
 *
 * A store's NEED for a variant (definition):
 *   the store's metric is Out or Running low, its keep level is known, and
 *   need = keep level − (on hand + incoming at the store) ≥ 1 unit.
 *   Out / Running low without a known keep level (not enough sales there yet) is skipped:
 *   there is nothing to size the transfer with.
 *
 * A warehouse's SPARE for a variant (definition, conservative):
 *   spare = available at the warehouse (on hand − committed, what Shopify can move)
 *           − the warehouse's own keep level (its own POS sales; usually none)
 *           − the online pool's keep level when the warehouse counts for online sales
 *             (online orders are keyed "online", not to the warehouse, so its own metric
 *             can't see them; the whole online keep level stays put even when other pool
 *             locations also hold stock) — unless its own metric was already computed at the
 *             online pool's pace (inputs.demandSource "online_pool"): then it is kept once;
 *   0 when the warehouse has no metric for the variant, or a keep level it needs is unknown.
 *
 * Transfers Keha created that may not have shipped yet (review fix: the plan used to propose
 * the same units again). Keha can't see a transfer's status without a Shopify read, so every
 * transfer Keha created in the last PENDING_TRANSFER_DAYS days counts as PENDING:
 *   - its units are added to the destination store's incoming (the store's need shrinks);
 *   - its units are taken off the origin warehouse's spare.
 * Once a transfer is marked ready to ship, Shopify's own numbers may already show it (incoming
 * at the store, less available at the warehouse) and the pending units are then counted twice
 * for the rest of the window: the plan proposes LESS, never the same units twice (ASSUMED
 * acceptable; reading each transfer's status from Shopify would remove it).
 *
 * Allocation, per variant: store needs largest first (ties: store name), each served from
 * the warehouse with the most spare left (ties: name), then the next one; quantities are
 * whole units, rounded down, never more than the spare left; lines under 1 unit are skipped.
 * Lines are grouped by origin → destination.
 */

import { safetyStock } from "./engine/order-shared";

export type PlanMetric = { status: string; rate: number | null; sigma: number | null; inputs: unknown };
export type StockAt = { onHand: number; available: number; incoming: number };
export type PlanVariant = { id: string; productTitle: string; variantTitle: string; sku: string | null; image: string | null };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The engine's target stock for one metric (see the header); null when unknown. */
export function keepLevel(m: PlanMetric | null | undefined): number | null {
  if (!m || m.rate === null || !Number.isFinite(m.rate)) return null;
  const i = m.inputs && typeof m.inputs === "object" ? (m.inputs as Record<string, unknown>) : null;
  if (!i) return null;
  const lead = num(i.leadTimeDays);
  const cycle = num(i.cycleDays);
  const z = num(i.z);
  if (lead === null || cycle === null || z === null) return null;
  const seasonal = num(i.seasonal) ?? 1;
  const trend = num(i.trend) ?? 1;
  const sigma = m.sigma !== null && Number.isFinite(m.sigma) ? m.sigma : 0;
  const safety = num(i.safety) ?? safetyStock(z, sigma, lead + cycle);
  return Math.max(0, m.rate * seasonal * trend * (lead + cycle) + safety);
}

export const NEED_STATUSES: readonly string[] = ["out", "running_low"];

/** Days a transfer Keha created counts as pending (see the header). */
export const PENDING_TRANSFER_DAYS = 14;

/** location id → variant id → units. */
export type UnitsAt = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** Pending units per destination (`inbound`) and per origin (`outbound`) from stored transfers. */
export function pendingTransferUnits(
  transfers: readonly { originLocationId: string; destinationLocationId: string; lines: unknown }[],
): { inbound: Map<string, Map<string, number>>; outbound: Map<string, Map<string, number>> } {
  const inbound = new Map<string, Map<string, number>>();
  const outbound = new Map<string, Map<string, number>>();
  const add = (m: Map<string, Map<string, number>>, loc: string, v: string, q: number) => {
    const at = m.get(loc) ?? m.set(loc, new Map()).get(loc)!;
    at.set(v, (at.get(v) ?? 0) + q);
  };
  for (const t of transfers)
    for (const l of readTransferLines(t.lines)) {
      if (!(l.quantity > 0)) continue;
      add(inbound, t.destinationLocationId, l.variantId, l.quantity);
      add(outbound, t.originLocationId, l.variantId, l.quantity);
    }
  return { inbound, outbound };
}

/** Units a store needs (fractional), or null when it doesn't qualify (see the header). `pending`: units on Keha transfers on their way. */
export function storeNeed(m: PlanMetric | null | undefined, stock: StockAt | null | undefined, pending = 0): number | null {
  if (!m || !NEED_STATUSES.includes(m.status)) return null;
  const keep = keepLevel(m);
  if (keep === null) return null;
  const need = keep - ((stock?.onHand ?? 0) + Math.max(0, stock?.incoming ?? 0) + Math.max(0, pending));
  return need >= 1 ? need : null;
}

/** Whole units a warehouse can give (see the header). */
export function warehouseSpare(
  own: PlanMetric | null | undefined,
  online: PlanMetric | null | undefined,
  inPool: boolean,
  stock: StockAt | null | undefined,
  pendingOut = 0,
): number {
  if (!own || !stock) return 0;
  const ownKeep = keepLevel(own);
  if (ownKeep === null) return 0;
  let keep = ownKeep;
  // A warehouse metric computed at the online pool's pace (compute-locations-shared,
  // demandSource "online_pool") already keeps the online needs: never twice.
  const ownInputs = own.inputs && typeof own.inputs === "object" ? (own.inputs as Record<string, unknown>) : {};
  if (inPool && ownInputs.demandSource !== "online_pool") {
    const onlineKeep = keepLevel(online);
    if (onlineKeep === null) return 0;
    keep += onlineKeep;
  }
  return Math.max(0, Math.floor(Math.min(stock.available, stock.onHand) - keep - Math.max(0, pendingOut)));
}

export type TransferLine = {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  image: string | null;
  /** Proposed units (whole, ≤ the spare left at the origin). */
  qty: number;
  /** The store's need, rounded down (qty can be less when spare runs out). */
  need: number;
  storeOnHand: number | null;
  storeDaysLeft: number | null;
  /** Spare at the origin before this line. */
  originSpare: number;
};

export type TransferGroup = {
  key: string;
  originId: string;
  originName: string;
  destinationId: string;
  destinationName: string;
  units: number;
  lines: TransferLine[];
};

export const transferGroupKey = (originId: string, destinationId: string) => `${originId}>${destinationId}`;

export type TransferPlanInput = {
  warehouses: readonly { id: string; name: string; inPool: boolean }[];
  stores: readonly { id: string; name: string }[];
  variants: ReadonlyMap<string, PlanVariant>;
  /** scope ("online" | Location.id) → variantId → metric. */
  metrics: ReadonlyMap<string, ReadonlyMap<string, PlanMetric & { daysLeft?: number | null }>>;
  /** Location.id → variantId → stock now. */
  stock: ReadonlyMap<string, ReadonlyMap<string, StockAt>>;
  /** Units on pending Keha transfers (pendingTransferUnits); none when absent. */
  pending?: { inbound: UnitsAt; outbound: UnitsAt };
};

export function buildTransferPlan(input: TransferPlanInput): TransferGroup[] {
  const online = input.metrics.get("online");
  // Needs per variant, largest first.
  const needs = new Map<string, { store: { id: string; name: string }; need: number }[]>();
  for (const store of input.stores) {
    const ms = input.metrics.get(store.id);
    if (!ms) continue;
    for (const [variantId, m] of ms) {
      if (!input.variants.has(variantId)) continue;
      const need = storeNeed(m, input.stock.get(store.id)?.get(variantId), input.pending?.inbound.get(store.id)?.get(variantId) ?? 0);
      if (need === null) continue;
      (needs.get(variantId) ?? needs.set(variantId, []).get(variantId)!).push({ store, need });
    }
  }
  const groups = new Map<string, TransferGroup>();
  for (const [variantId, list] of needs) {
    list.sort((a, b) => b.need - a.need || a.store.name.localeCompare(b.store.name) || (a.store.id < b.store.id ? -1 : 1));
    const spare = new Map(
      input.warehouses.map((w) => [
        w.id,
        warehouseSpare(
          input.metrics.get(w.id)?.get(variantId),
          online?.get(variantId),
          w.inPool,
          input.stock.get(w.id)?.get(variantId),
          input.pending?.outbound.get(w.id)?.get(variantId) ?? 0,
        ),
      ]),
    );
    const v = input.variants.get(variantId)!;
    for (const { store, need } of list) {
      let left = Math.floor(need);
      while (left >= 1) {
        const w = [...input.warehouses]
          .filter((x) => (spare.get(x.id) ?? 0) >= 1)
          .sort((a, b) => (spare.get(b.id) ?? 0) - (spare.get(a.id) ?? 0) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))[0];
        if (!w) break;
        const before = spare.get(w.id)!;
        const qty = Math.floor(Math.min(left, before));
        if (qty < 1) break;
        spare.set(w.id, before - qty);
        left -= qty;
        const key = transferGroupKey(w.id, store.id);
        const g =
          groups.get(key) ??
          groups
            .set(key, { key, originId: w.id, originName: w.name, destinationId: store.id, destinationName: store.name, units: 0, lines: [] })
            .get(key)!;
        const st = input.stock.get(store.id)?.get(variantId);
        const m = input.metrics.get(store.id)?.get(variantId);
        g.lines.push({
          variantId,
          productTitle: v.productTitle,
          variantTitle: v.variantTitle,
          sku: v.sku,
          image: v.image,
          qty,
          need: Math.floor(need),
          storeOnHand: st ? st.onHand : null,
          storeDaysLeft: num(m?.daysLeft),
          originSpare: before,
        });
        g.units += qty;
      }
    }
  }
  const out = [...groups.values()];
  for (const g of out)
    g.lines.sort((a, b) => b.qty - a.qty || a.productTitle.localeCompare(b.productTitle) || a.variantTitle.localeCompare(b.variantTitle) || (a.variantId < b.variantId ? -1 : 1));
  return out.sort(
    (a, b) => b.units - a.units || a.originName.localeCompare(b.originName) || a.destinationName.localeCompare(b.destinationName),
  );
}

/**
 * Lines the merchant asked more of than the plan's spare at the origin for that line (the
 * server refuses them: review fix — the confirm dialog's own check is only a warning).
 */
export function linesOverSpare(lines: readonly { variantId: string; qty: number; originSpare: number }[]): string[] {
  return lines.filter((l) => l.qty > l.originSpare).map((l) => l.variantId);
}

/**
 * The text an idempotency key is made from (hashed on the server): the same plan sent twice
 * on the same store-local day — a retry, a double click — gets the same key, so Shopify and
 * our Transfer table create it once. A different quantity, line, location or day is a new
 * transfer.
 */
export function transferKeyMaterial(
  shop: string,
  originId: string,
  destinationId: string,
  lines: readonly { variantId: string; qty: number }[],
  day: string,
): string {
  const body = [...lines]
    .filter((l) => l.qty > 0)
    .map((l) => `${l.variantId}:${l.qty}`)
    .sort()
    .join(",");
  return ["keha-transfer", shop, originId, destinationId, day, body].join("|");
}

/** A hex digest → UUID-shaped text (the form Shopify's idempotency examples use). */
export function uuidFromHex(hex: string): string {
  const h = hex.padEnd(32, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** A Shopify InventoryTransfer gid → its page in the Shopify admin (App Bridge admin link). */
export function transferAdminHref(gid: string): string {
  const m = /(\d+)$/.exec(gid);
  return `shopify://admin/transfers/${m ? m[1] : ""}`;
}

/** A transfer Keha created (Reorder → "Transfers created with Keha"). */
export type RecentTransfer = {
  id: string;
  shopifyTransferId: string;
  originName: string;
  destinationName: string;
  units: number;
  createdAt: string;
};

/** Stored Transfer.lines JSON, read defensively. */
export type StoredTransferLine = { variantId: string; inventoryItemId: string; quantity: number; productTitle?: string; variantTitle?: string };

export function readTransferLines(raw: unknown): StoredTransferLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const r = x as Record<string, unknown>;
    if (typeof r.variantId !== "string" || typeof r.inventoryItemId !== "string" || typeof r.quantity !== "number") return [];
    return [
      {
        variantId: r.variantId,
        inventoryItemId: r.inventoryItemId,
        quantity: r.quantity,
        productTitle: typeof r.productTitle === "string" ? r.productTitle : undefined,
        variantTitle: typeof r.variantTitle === "string" ? r.variantTitle : undefined,
      },
    ];
  });
}

/** Shopify's InventoryTransferCreateUserError list → messages. */
export function transferUserErrors(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];
  return errors
    .map((e) => (e && typeof e === "object" ? String((e as Record<string, unknown>).message ?? "") : ""))
    .filter(Boolean);
}
