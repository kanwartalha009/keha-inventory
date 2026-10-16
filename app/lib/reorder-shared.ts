/**
 * Reorder screen (spec §5.3, J3): suggested order lines grouped by supplier,
 * with the supplier's minimums applied. Pure, client-safe.
 *
 * Minimums (Kanwar 2026-10-16, both apply):
 *  - per line: round up to the case pack (variant caseQty wins, else the
 *    supplier's casePack), then raise to the per-variant minimum (MOQ),
 *    itself rounded up to the pack;
 *  - per order: when the total is below the supplier's order minimum, the
 *    lines are topped up in proportion to forecast demand (sales per day),
 *    each line staying a whole number of case packs, until the total reaches
 *    the minimum. The merchant may edit below it: a warning, never a block.
 */
import { casePackFor, supplierFor, type SupplierLite } from "./supplier-shared";

type T = (s: string) => string;

// ── Minimums ───────────────────────────────────────────────────────────────

const roundUp = (q: number, pack: number) => Math.ceil(q / pack) * pack;
const packOf = (pack: number | null | undefined) => (pack && pack > 1 ? Math.floor(pack) : 1);

/** One line's quantity: need rounded up to the pack, then raised to the MOQ (rounded to the pack). 0 stays 0. */
export function lineQuantity(need: number, pack: number | null, moq: number | null): number {
  if (!(need > 0)) return 0;
  const p = packOf(pack);
  let q = roundUp(Math.ceil(need - 1e-9), p);
  if (moq && moq > q) q = roundUp(moq, p);
  return q;
}

export type TopUpLine = { qty: number; pack: number | null; weight: number };

/**
 * Raise the order total to `minTotal`: extra units go to the lines with a
 * quantity (> 0) in proportion to their weight (forecast sales per day; all
 * equal when no line has a weight), in whole case packs. Deterministic: bulk
 * whole-pack shares first, then one pack at a time to the line furthest below
 * its share (ties: the earlier line).
 */
export function topUpToMinimum(lines: readonly TopUpLine[], minTotal: number | null): { qtys: number[]; toppedUp: boolean } {
  const qtys = lines.map((l) => l.qty);
  const total = qtys.reduce((a, b) => a + b, 0);
  if (!minTotal || total >= minTotal) return { qtys, toppedUp: false };
  const eligible = lines.map((l, i) => ({ i, pack: packOf(l.pack), w: l.qty > 0 && l.weight > 0 && Number.isFinite(l.weight) ? l.weight : 0 })).filter((x) => lines[x.i]!.qty > 0);
  if (!eligible.length) return { qtys, toppedUp: false };
  const sumW = eligible.reduce((a, x) => a + x.w, 0);
  const share = (x: { w: number }) => (sumW > 0 ? x.w / sumW : 1 / eligible.length);
  const deficit = minTotal - total;
  const extra = new Map<number, number>();
  let added = 0;
  for (const x of eligible) {
    const bulk = Math.floor((deficit * share(x)) / x.pack) * x.pack;
    extra.set(x.i, bulk);
    added += bulk;
  }
  // Only lines with a share take more; with weights, a zero-weight line keeps its own quantity.
  const takers = eligible.filter((x) => share(x) > 0);
  while (total + added < minTotal) {
    let best = takers[0]!;
    let bestGap = -Infinity;
    for (const x of takers) {
      const gap = deficit * share(x) - (extra.get(x.i) ?? 0);
      if (gap > bestGap + 1e-9) {
        best = x;
        bestGap = gap;
      }
    }
    extra.set(best.i, (extra.get(best.i) ?? 0) + best.pack);
    added += best.pack;
  }
  for (const [i, e] of extra) qtys[i]! += e;
  return { qtys, toppedUp: added > 0 };
}

// ── Groups ─────────────────────────────────────────────────────────────────

export type ReorderVariantIn = {
  id: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  vendor: string | null;
  image: string | null;
  supplierId: string | null;
  caseQty: number | null;
  cost: number | null;
  costCurrency: string | null;
};

export type ReorderMetricIn = {
  orderQty: number | null;
  orderBy: string | null;
  daysLeft: number | null;
  neverRunsOut: boolean;
  rate: number | null;
  /**
   * Units on sent / confirmed Keha orders that compute already counted as incoming when it
   * set orderQty (VariantMetric.inputs.kehaOnOrder). Optional: 0 when absent.
   */
  kehaCounted?: number;
};

export type ReorderSupplierIn = SupplierLite & { currency: string | null; hasEmail: boolean };

export type ReorderLine = {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  image: string | null;
  onHand: number | null;
  incoming: number | null;
  /** Units on open Keha orders (draft, sent, confirmed) not yet received. */
  onOrder: number;
  daysLeft: number | null;
  neverRunsOut: boolean;
  orderBy: string | null;
  /** Suggested quantity after the open Keha orders, the case pack, the MOQ and the order minimum. */
  suggested: number;
  pack: number | null;
  moq: number | null;
  /** Unit cost in the group currency; null when unknown or in another currency. */
  unitCost: number | null;
  /** Forecast sales per day (top-up weight). */
  rate: number | null;
  /** Asked for through ?variants= (Home "Add to reorder plan"). */
  selected: boolean;
};

export type ReorderGroup = {
  key: string;
  kind: "supplier" | "vendor";
  supplierId: string | null;
  /** Supplier name, or the vendor ("" = products without a vendor). */
  name: string;
  leadTimeDays: number;
  leadTimeSource: "supplier" | "default";
  /** Earliest order-by date of its lines. */
  orderBy: string | null;
  currency: string;
  minOrderTotal: number | null;
  toppedUp: boolean;
  hasEmail: boolean;
  selected: boolean;
  lines: ReorderLine[];
};

export const supplierGroupKey = (id: string) => `supplier:${id}`;
export const vendorGroupKey = (vendor: string | null) => `vendor:${(vendor ?? "").trim().toLowerCase()}`;

/** Unit cost in `currency`: known only when the cost is in that currency (no FX guessing). */
export function unitCostIn(
  cost: number | null,
  costCurrency: string | null,
  currency: string,
  storeCurrency: string,
): number | null {
  if (cost === null || !Number.isFinite(cost) || cost < 0) return null;
  const from = (costCurrency || storeCurrency).toUpperCase();
  return from === currency.toUpperCase() ? cost : null;
}

export type BuildReorderInput = {
  variants: readonly ReorderVariantIn[];
  metrics: ReadonlyMap<string, ReorderMetricIn>;
  stock: ReadonlyMap<string, { onHand: number | null; incoming: number | null }>;
  /** Open Keha order units per variant now (draft + sent + confirmed − received). */
  onOrder: ReadonlyMap<string, number>;
  suppliers: readonly ReorderSupplierIn[];
  storeCurrency: string;
  defaultLeadTimeDays: number;
  selected?: ReadonlySet<string>;
};

/**
 * The Reorder plan: every variant whose suggested quantity (VariantMetric
 * orderQty minus open Keha orders) is above 0, plus any `selected` variant,
 * grouped by supplier — unassigned variants by vendor. Groups with a selected
 * line come first, then by order-by date, then by name.
 */
export function buildReorderGroups(input: BuildReorderInput): ReorderGroup[] {
  const selected = input.selected ?? new Set<string>();
  const groups = new Map<string, ReorderGroup>();
  for (const v of input.variants) {
    const m = input.metrics.get(v.id);
    const onOrder = Math.max(0, input.onOrder.get(v.id) ?? 0);
    // orderQty already nets out the Keha units compute counted; subtract only the rest
    // (drafts, and orders sent since compute last ran).
    const notCounted = Math.max(0, onOrder - Math.max(0, m?.kehaCounted ?? 0));
    const need = Math.max(0, (m?.orderQty ?? 0) - notCounted);
    const isSel = selected.has(v.id);
    if (need <= 0 && !isSel) continue;
    const supplier = supplierFor(v, input.suppliers);
    const key = supplier ? supplierGroupKey(supplier.id) : vendorGroupKey(v.vendor);
    let g = groups.get(key);
    if (!g) {
      const currency = (supplier?.currency || input.storeCurrency).toUpperCase();
      g = {
        key,
        kind: supplier ? "supplier" : "vendor",
        supplierId: supplier?.id ?? null,
        name: supplier ? supplier.name : (v.vendor ?? "").trim(),
        leadTimeDays: supplier ? supplier.leadTimeDays : input.defaultLeadTimeDays,
        leadTimeSource: supplier ? "supplier" : "default",
        orderBy: null,
        currency,
        minOrderTotal: supplier?.minOrderTotal ?? null,
        toppedUp: false,
        hasEmail: !!supplier?.hasEmail,
        selected: false,
        lines: [],
      };
      groups.set(key, g);
    }
    const pack = casePackFor(v.caseQty, supplier);
    const moq = supplier?.minOrder ?? null;
    const stock = input.stock.get(v.id);
    const orderBy = m?.orderBy ?? null;
    g.lines.push({
      variantId: v.id,
      productTitle: v.productTitle,
      variantTitle: v.variantTitle,
      sku: v.sku,
      image: v.image,
      onHand: stock?.onHand ?? null,
      incoming: stock?.incoming ?? null,
      onOrder,
      daysLeft: m?.daysLeft ?? null,
      neverRunsOut: !!m?.neverRunsOut,
      orderBy,
      suggested: lineQuantity(need, pack, moq),
      pack,
      moq,
      unitCost: unitCostIn(v.cost, v.costCurrency, g.currency, input.storeCurrency),
      rate: m?.rate ?? null,
      selected: isSel,
    });
    if (isSel) g.selected = true;
    if (orderBy && (!g.orderBy || orderBy < g.orderBy)) g.orderBy = orderBy;
  }
  const out: ReorderGroup[] = [];
  for (const g of groups.values()) {
    g.lines.sort(
      (a, b) =>
        Number(b.selected) - Number(a.selected) ||
        (a.orderBy ?? "9999").localeCompare(b.orderBy ?? "9999") ||
        a.productTitle.localeCompare(b.productTitle) ||
        a.variantTitle.localeCompare(b.variantTitle) ||
        (a.variantId < b.variantId ? -1 : 1),
    );
    const top = topUpToMinimum(
      g.lines.map((l) => ({ qty: l.suggested, pack: l.pack, weight: l.rate ?? 0 })),
      g.minOrderTotal,
    );
    g.lines.forEach((l, i) => (l.suggested = top.qtys[i]!));
    out.push({ ...g, toppedUp: top.toppedUp });
  }
  return out.sort(
    (a, b) =>
      Number(b.selected) - Number(a.selected) ||
      (a.orderBy ?? "9999").localeCompare(b.orderBy ?? "9999") ||
      Number(a.kind === "vendor") - Number(b.kind === "vendor") ||
      a.name.localeCompare(b.name),
  );
}

/** Units and cost of a group at the given quantities; cost null when any ordered line has no unit cost. */
export function groupTotals(
  lines: readonly Pick<ReorderLine, "variantId" | "unitCost">[],
  qty: (variantId: string) => number,
): { units: number; cost: number | null } {
  let units = 0;
  let cost: number | null = 0;
  for (const l of lines) {
    const q = qty(l.variantId);
    if (!(q > 0)) continue;
    units += q;
    if (cost !== null) cost = l.unitCost === null ? null : cost + l.unitCost * q;
  }
  return { units, cost: cost === null ? null : Math.round(cost * 100) / 100 };
}

export type MinimumWarnings = {
  /** The order total is below the supplier's order minimum. */
  belowTotal: boolean;
  /** Lines below the per-variant minimum. */
  belowLine: string[];
  /** Lines that aren't a whole number of case packs. */
  notPack: string[];
};

/** Warnings for edited quantities (never a block). Lines at 0 are left out of the order and not warned. */
export function minimumWarnings(
  group: Pick<ReorderGroup, "minOrderTotal" | "lines">,
  qty: (variantId: string) => number,
): MinimumWarnings {
  const belowLine: string[] = [];
  const notPack: string[] = [];
  let total = 0;
  for (const l of group.lines) {
    const q = qty(l.variantId);
    if (!(q > 0)) continue;
    total += q;
    if (l.moq && q < l.moq) belowLine.push(l.variantId);
    if (l.pack && l.pack > 1 && q % l.pack !== 0) notPack.push(l.variantId);
  }
  return { belowTotal: !!group.minOrderTotal && total > 0 && total < group.minOrderTotal, belowLine, notPack };
}

/** Quantity typed by the merchant → whole units 0…1,000,000 (anything else 0). */
export function readQty(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : 0;
}

/** `?variants=gid,gid` (or numeric ids) → variant gids, at most 250. */
export function parseVariantsParam(raw: string | null): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const s = part.trim();
    const m = /^(?:gid:\/\/shopify\/ProductVariant\/)?(\d{1,20})$/.exec(s);
    if (m) out.add(`gid://shopify/ProductVariant/${m[1]}`);
    if (out.size >= 250) break;
  }
  return [...out];
}

/** The group's heading: the supplier, or "No supplier — grouped by vendor". */
export function groupTitle(g: Pick<ReorderGroup, "kind" | "name">, t: T): string {
  if (g.kind === "supplier") return g.name;
  return g.name || t("No vendor");
}
