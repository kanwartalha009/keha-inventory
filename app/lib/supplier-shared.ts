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
}

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
}

export const OPEN_PO_STATUSES = ["sent", "confirmed"] as const;

/** Expected arrival: the supplier's confirmed date, else the lead-time estimate. */
export function poArrival(po: { confirmedShipDate: Date | null; expectedDate: Date | null }): Date | null {
  return po.confirmedShipDate ?? po.expectedDate ?? null;
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
    });
  }
  return out;
}
