/**
 * Suppliers and purchase orders — the pieces shared by the engine (compute),
 * the Reorder screen and the bridge (spec §5.3, §5.5, §7.4). Pure, client-safe.
 */

export interface SupplierLite {
  id: string;
  name: string;
  leadTimeDays: number;
  /** Minimum units per variant line (MOQ per SKU). */
  minOrder: number | null;
  /** Minimum total units for the whole order. */
  minOrderTotal: number | null;
  casePack: number | null;
  vendorMatch: string[];
  /** Days from the supplier's ship date to arrival (freight). null = ship date is the arrival. */
  transitDays?: number | null;
  /** Minimum order value in the supplier's currency. */
  minOrderValue?: number | null;
  /** What `minOrder` applies to: each variant, or each product (style) split across its variants. */
  minOrderScope?: MinOrderScope;
  /** 1 unit of the supplier's currency in the store's currency; null = unknown. */
  exchangeRate?: number | null;
}

export type MinOrderScope = "variant" | "product";
export const readMinOrderScope = (v: unknown): MinOrderScope => (v === "product" ? "product" : "variant");

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Which supplier a variant orders from (spec §5.5 "assign by vendor or by
 * product"): an explicit Variant.supplierId wins; otherwise the first supplier
 * (by name, then id) whose vendorMatch contains the variant's vendor,
 * case-insensitive. null = unassigned (Reorder groups it by vendor).
 */
export function supplierFor<S extends SupplierLite>(
  variant: { supplierId: string | null; vendor: string | null },
  suppliers: readonly S[],
): S | null {
  if (variant.supplierId) {
    const direct = suppliers.find((s) => s.id === variant.supplierId);
    if (direct) return direct;
  }
  const vendor = norm(variant.vendor);
  if (!vendor) return null;
  const sorted = [...suppliers].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  return sorted.find((s) => s.vendorMatch.some((v) => norm(v) === vendor)) ?? null;
}

/** Case pack for one line: the variant's own caseQty wins over the supplier's default. */
export function casePackFor(variantCaseQty: number | null | undefined, supplier: SupplierLite | null): number | null {
  if (variantCaseQty && variantCaseQty > 1) return Math.floor(variantCaseQty);
  if (supplier?.casePack && supplier.casePack > 1) return Math.floor(supplier.casePack);
  return null;
}

/** One line of PurchaseOrder.lines (JSON). Shared by Keha and Shopify purchase orders. */
export interface PoLine {
  variantId: string;
  qty: number;
  /** Unit cost in the order currency; null when unknown. */
  unitCost: number | null;
  /** Snapshots so the PDF / supplier page don't need a join. */
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  /** Units already received (Shopify POs report it; Keha POs fill it on receive). */
  received?: number;
  /** Keha orders: the line's on-hand (online pool) when the order was sent — the baseline for auto-receive. */
  baseOnHand?: number;
  /** Keha orders: units auto-receive recorded on this line (the order was closed automatically). */
  autoReceived?: number;
  /** Keha orders: `received` before the step that closed the order — what re-opening restores. */
  reopenReceived?: number;
}

export const OPEN_PO_STATUSES = ["sent", "confirmed"] as const;

const DAY_MS = 86_400_000;

/**
 * Expected arrival. The supplier confirms a SHIP date; stock arrives `transitDays`
 * later (sea/air freight; audit 2026-10-17). Without a confirmation: the lead-time
 * estimate (`expectedDate`, already order → arrival).
 */
export function poArrival(
  po: { confirmedShipDate: Date | null; expectedDate: Date | null },
  transitDays?: number | null,
): Date | null {
  if (po.confirmedShipDate) {
    const t = transitDays && transitDays > 0 ? Math.floor(transitDays) : 0;
    return t ? new Date(po.confirmedShipDate.getTime() + t * DAY_MS) : po.confirmedShipDate;
  }
  return po.expectedDate ?? null;
}

/**
 * Drafts nobody sent stop counting as "already ordered" after this many days, so a
 * forgotten draft can't quietly cause under-ordering (audit 2026-10-17).
 */
export const DRAFT_EXPIRY_DAYS = 14;

/** Does this order's quantity still net off suggestions? Sent/confirmed always; drafts only while fresh. */
export function poCountsAsOrdered(po: { status: string; createdAt: Date }, now: Date): boolean {
  if (po.status === "sent" || po.status === "confirmed") return true;
  if (po.status !== "draft") return false;
  return now.getTime() - po.createdAt.getTime() < DRAFT_EXPIRY_DAYS * DAY_MS;
}

/** A store-currency amount in the supplier's currency (null when the rate is unknown). */
export function toSupplierCurrency(storeAmount: number | null, exchangeRate: number | null | undefined): number | null {
  if (storeAmount == null || !exchangeRate || !(exchangeRate > 0)) return null;
  return storeAmount / exchangeRate;
}

/** A supplier-currency amount in the store's currency (null when the rate is unknown). */
export function toStoreCurrency(supplierAmount: number | null, exchangeRate: number | null | undefined): number | null {
  if (supplierAmount == null || !exchangeRate || !(exchangeRate > 0)) return null;
  return supplierAmount * exchangeRate;
}

/** Read PurchaseOrder.lines defensively (malformed entries are dropped). */
export function readPoLines(raw: unknown): PoLine[] {
  if (!Array.isArray(raw)) return [];
  const out: PoLine[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    if (typeof x.variantId !== "string" || typeof x.qty !== "number" || !Number.isFinite(x.qty)) continue;
    out.push({
      variantId: x.variantId,
      qty: Math.max(0, Math.floor(x.qty)),
      unitCost: typeof x.unitCost === "number" && Number.isFinite(x.unitCost) ? x.unitCost : null,
      productTitle: typeof x.productTitle === "string" ? x.productTitle : "",
      variantTitle: typeof x.variantTitle === "string" ? x.variantTitle : "",
      sku: typeof x.sku === "string" ? x.sku : null,
      received: typeof x.received === "number" && Number.isFinite(x.received) ? Math.max(0, Math.floor(x.received)) : undefined,
      baseOnHand: typeof x.baseOnHand === "number" && Number.isFinite(x.baseOnHand) ? Math.floor(x.baseOnHand) : undefined,
      ...(typeof x.autoReceived === "number" && Number.isFinite(x.autoReceived) && x.autoReceived > 0
        ? { autoReceived: Math.floor(x.autoReceived) }
        : {}),
      ...(typeof x.reopenReceived === "number" && Number.isFinite(x.reopenReceived) && x.reopenReceived >= 0
        ? { reopenReceived: Math.floor(x.reopenReceived) }
        : {}),
    });
  }
  return out;
}
