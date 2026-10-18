/**
 * Supplier order builder (consolidated supplier purchase order, Kanwar 2026-10-17). Database
 * only, no Shopify calls; the logic is lib/supplier-order-shared.
 *
 * One supplier's order for its whole order cycle, from the same forward plan as Order now, Next
 * 13 weeks, the Dashboard and Sidekick (models/order-plan.server computeOrderPlan): its lines due
 * now (or in a Next 13 weeks week), its lines due before its next order, and any of its products
 * the merchant adds. "Create purchase order" saves ONE Keha draft with every line; "Add to PO-00xx"
 * adds the lines to the supplier's fresh draft instead. Either way the draft counts as ordered
 * while it is under 14 days old (supplier-shared poCountsAsOrdered), so its lines leave Order
 * now, Next 13 weeks, Products and Sidekick — every unit counted once. Nothing is sent to the
 * supplier here; the merchant emails it or marks it sent on the order page.
 *
 * Which products belong to a supplier is supplierFor's answer (a product assignment wins over the
 * vendor match); unassigned products are grouped by vendor ("vendor:<name>"). Every line the
 * browser sends is checked against it again on the server.
 */
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { poCountsAsOrdered, readPoLines, supplierFor, casePackFor, lineRemaining } from "../lib/supplier-shared";
import { supplierGroupKey, vendorGroupKey } from "../lib/reorder-shared";
import { lineCosts, type PlanSupplierInfo } from "../lib/order-plan-shared";
import { METRIC_SCOPE } from "../lib/products-shared";
import {
  buildSupplierOrder,
  type AddableProduct,
  type BuilderDraft,
  type SupplierOrderView,
} from "../lib/supplier-order-shared";
import { computeOrderPlan, planSuppliers, supplierInfoOf, type PlanSupplierRow } from "./order-plan.server";
import { addDraftLines, draftLines, insertWithNumber, shipToChoices, shopBasics, type OrderEditResult, type ShopBasics } from "./reorder.server";
import { defaultShipTo, readPoNote, readShipTo } from "../lib/po-document-shared";

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};

/** The group key of a variant: its supplier, else its vendor. */
export function keyOfVariant(v: { supplierId: string | null; vendor: string | null }, suppliers: readonly PlanSupplierRow[]): string {
  const s = supplierFor(v, suppliers);
  return s ? supplierGroupKey(s.id) : vendorGroupKey(v.vendor);
}

/** The supplier behind a key, from Settings (null for a vendor group or a supplier that was deleted). */
function supplierOfKey(key: string, suppliers: readonly PlanSupplierRow[]): PlanSupplierRow | null {
  if (!key.startsWith("supplier:")) return null;
  const id = key.slice("supplier:".length);
  return suppliers.find((s) => s.id === id) ?? null;
}

/** A supplier with no planned order: its terms from Settings, as computeOrderPlan would show them. */
function infoFromSettings(key: string, suppliers: readonly PlanSupplierRow[], basics: ShopBasics, vendorName: string | null): PlanSupplierInfo | null {
  const store = basics.currency.toUpperCase();
  const s = supplierOfKey(key, suppliers);
  // The same supplier info the plan builds (terms, minimums, payment terms, measured lead time).
  if (s) return supplierInfoOf(s, store);
  if (!key.startsWith("vendor:") || vendorName === null) return null;
  return {
    key,
    kind: "vendor",
    supplierId: null,
    name: vendorName,
    currency: store,
    exchangeRate: null,
    minOrderTotal: null,
    minOrderValue: null,
    minOrderValueStore: null,
    minOrder: null,
    minOrderScope: "variant",
    leadTimeDays: basics.leadTimeDays,
    leadTimeSource: "default",
    hasEmail: false,
    cycleDays: null,
    orderCycleDays: null,
  };
}

/** A vendor group's name as the catalog spells it (the key is lower case); null when no product has it. */
async function vendorName(shop: string, key: string, suppliers: readonly PlanSupplierRow[]): Promise<string | null> {
  const lower = key.slice("vendor:".length);
  if (!lower) return "";
  const rows = await prisma.variant.findMany({
    where: { shop, tracked: true, isBundle: false, vendor: { contains: lower, mode: "insensitive" } },
    select: { vendor: true, supplierId: true },
    take: 200,
  });
  const hit = rows.find((r) => keyOfVariant(r, suppliers) === key);
  return hit ? (hit.vendor ?? "").trim() : null;
}

/** Does this draft belong to the supplier behind `info` (and still count as ordered)? */
export function draftBelongs(o: { supplierId: string | null; supplierName: string | null; createdAt: Date | null }, info: Pick<PlanSupplierInfo, "kind" | "supplierId" | "name">, now: Date): boolean {
  if (!poCountsAsOrdered({ status: "draft", createdAt: o.createdAt }, now)) return false;
  if (info.kind === "supplier") return !!info.supplierId && o.supplierId === info.supplierId;
  return o.supplierId === null && (o.supplierName ?? "").trim().toLowerCase() === info.name.trim().toLowerCase();
}

/** The supplier's newest Keha draft that still counts as ordered (lines can be added to it); null when none. */
async function freshDraft(shop: string, info: PlanSupplierInfo, now: Date): Promise<BuilderDraft | null> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { shop, source: "keha", status: "draft", supplierId: info.kind === "supplier" ? info.supplierId : null },
    select: { id: true, number: true, lines: true, createdAt: true, updatedAt: true, supplierId: true, supplierName: true },
    orderBy: [{ createdAt: "desc" }],
    take: 20,
  });
  const time = (d: Date | null | undefined) => (d instanceof Date ? d.getTime() : 0);
  const hit = rows.filter((o) => draftBelongs(o, info, now)).sort((a, b) => time(b.createdAt) - time(a.createdAt))[0];
  if (!hit) return null;
  return {
    id: hit.id,
    number: hit.number,
    units: readPoLines(hit.lines).reduce((a, l) => a + lineRemaining(l), 0),
    createdAt: (hit.createdAt instanceof Date ? hit.createdAt : now).toISOString(),
    updatedAt: hit.updatedAt ? hit.updatedAt.toISOString() : null,
  };
}

export type SupplierOrderLoad = {
  view: SupplierOrderView;
  today: string;
  /** Where the order can ship to (active locations) and the default pick (merchant audit 2026-10-18). */
  shipTo?: { choices: { id: string; name: string }[]; default: string | null };
} | null;

/**
 * The builder for one supplier (`key` = "supplier:<id>" or "vendor:<name>"; `range`: a Next 13
 * weeks supplier-week). null when the supplier doesn't exist (deleted) or the vendor has no product.
 */
export async function loadSupplierOrder(
  shop: string,
  key: string,
  range: { from: string; to: string } | null = null,
  now: Date = new Date(),
  coverDays: number | null = null,
): Promise<SupplierOrderLoad> {
  const [{ data: plan, suppliers }, basics] = await Promise.all([
    computeOrderPlan(shop, now, { lastYear: true, coverDays: coverDays === null ? undefined : new Map([[key, coverDays]]) }),
    shopBasics(shop),
  ]);
  const info = plan.suppliers[key] ?? infoFromSettings(key, suppliers, basics, key.startsWith("vendor:") ? await vendorName(shop, key, suppliers) : null);
  if (!info) return null;
  // A supplier deleted since the plan was read: nothing to order from.
  if (info.kind === "supplier" && !supplierOfKey(key, suppliers)) return null;
  const [draft, locations] = await Promise.all([freshDraft(shop, info, now), shipToChoices(shop)]);
  return {
    view: buildSupplierOrder({ plan, supplierKey: key, info, storeCycleDays: basics.cycleDays, range, draft, coverDays }),
    today: plan.today,
    shipTo: { choices: locations.filter((l) => l.active).map((l) => ({ id: l.id, name: l.name })), default: defaultShipTo(locations) },
  };
}

const SEARCH_LIMIT = 25;

/**
 * "Add products": the supplier's own products matching every word of `q` in the product name,
 * variant name or SKU (any order, any case); without words, its first products by name. At most
 * 25 variants, with their store-currency cost, case pack, minimum per item and sales per day.
 */
export async function searchSupplierProducts(shop: string, key: string, q: string): Promise<AddableProduct[]> {
  const [suppliers, basics] = await Promise.all([planSuppliers(shop), shopBasics(shop)]);
  const s = supplierOfKey(key, suppliers);
  if (key.startsWith("supplier:") && !s) return [];
  const words = q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map((w) => w.slice(0, 60));
  const scope: Prisma.VariantWhereInput[] = s
    ? [{ supplierId: s.id }, ...s.vendorMatch.filter((v) => v.trim()).map((v) => ({ vendor: { equals: v.trim(), mode: "insensitive" as const } }))]
    : [{ vendor: { contains: key.slice("vendor:".length), mode: "insensitive" as const } }];
  const rows = await prisma.variant.findMany({
    where: {
      shop,
      tracked: true,
      isBundle: false,
      AND: [
        { OR: scope },
        ...words.map((w) => ({
          OR: [
            { productTitle: { contains: w, mode: "insensitive" as const } },
            { variantTitle: { contains: w, mode: "insensitive" as const } },
            { sku: { contains: w, mode: "insensitive" as const } },
          ],
        })),
      ],
    },
    select: { id: true, productId: true, productTitle: true, variantTitle: true, sku: true, image: true, vendor: true, supplierId: true, caseQty: true, cost: true, costCurrency: true, noReorder: true },
    orderBy: [{ productTitle: "asc" }, { variantTitle: "asc" }],
    take: 200,
  });
  const mine = rows.filter((v) => keyOfVariant(v, suppliers) === key).slice(0, SEARCH_LIMIT);
  const rates = mine.length
    ? await prisma.variantMetric.findMany({ where: { shop, scope: METRIC_SCOPE, variantId: { in: mine.map((v) => v.id) } }, select: { variantId: true, rate: true } })
    : [];
  const rateOf = new Map(rates.map((r) => [r.variantId, r.rate]));
  const store = basics.currency.toUpperCase();
  return mine.map((v) => {
    const sup = supplierFor(v, suppliers);
    const rate = rateOf.get(v.id);
    return {
      variantId: v.id,
      productId: v.productId,
      productTitle: v.productTitle,
      variantTitle: v.variantTitle,
      sku: v.sku,
      image: v.image,
      unitCostStore: lineCosts(num(v.cost), v.costCurrency, store, sup?.currency ?? null, sup?.exchangeRate ?? null).store,
      pack: casePackFor(v.caseQty, sup),
      moq: sup?.minOrderScope === "product" ? null : (sup?.minOrder ?? null),
      weight: typeof rate === "number" && rate > 0 ? rate : 0,
      noReorder: !!v.noReorder,
    };
  });
}

/** The variants of `quantities` that belong to the supplier behind `key`, with their snapshots. */
async function ownedLines(shop: string, key: string, quantities: Record<string, number>, suppliers: readonly PlanSupplierRow[]) {
  const ids = Object.keys(quantities).filter((id) => quantities[id]! > 0);
  if (!ids.length) return [];
  const rows = await prisma.variant.findMany({
    where: { shop, id: { in: ids }, tracked: true, isBundle: false },
    select: { id: true, productTitle: true, variantTitle: true, sku: true, vendor: true, supplierId: true },
  });
  // Lines of another supplier never slip into this order (the browser only sends quantities).
  return rows
    .filter((v) => keyOfVariant(v, suppliers) === key)
    .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
    .map((v) => ({ variantId: v.id, qty: quantities[v.id]!, productTitle: v.productTitle, variantTitle: v.variantTitle, sku: v.sku }));
}

export type SupplierOrderResult =
  | { ok: true; id: string; number: string; added?: boolean }
  | { ok: false; error: "gone" | "empty" | "notFound" | "notAllowed" | "changed" | "invalid" | "nothing" };

/** "Create purchase order": ONE Keha draft for the supplier with every line (quantities re-checked here). */
export async function createSupplierDraft(
  shop: string,
  key: string,
  quantities: Record<string, number>,
  /** Ship-to (an active Location.id; else the default) and the note to the supplier (merchant audit 2026-10-18). */
  details: { shipTo?: unknown; note?: unknown; coverDays?: number | null } = {},
): Promise<SupplierOrderResult> {
  const [suppliers, basics] = await Promise.all([planSuppliers(shop), shopBasics(shop)]);
  const s = supplierOfKey(key, suppliers);
  if (key.startsWith("supplier:") && !s) return { ok: false, error: "gone" };
  if (!key.startsWith("supplier:") && !key.startsWith("vendor:")) return { ok: false, error: "gone" };
  const picked = await ownedLines(shop, key, quantities, suppliers);
  if (!picked.length) return { ok: false, error: "empty" };
  const note = readPoNote(details.note);
  if (!note.ok) return { ok: false, error: "invalid" };
  const locations = await shipToChoices(shop);
  const name = s ? s.name : ((await vendorName(shop, key, suppliers)) ?? "");
  const lines = await draftLines(shop, picked, basics.currency);
  const created = await insertWithNumber(shop, {
    supplierId: s?.id ?? null,
    supplierName: name || null,
    status: "draft",
    source: "keha",
    lines: lines as unknown as Prisma.InputJsonValue,
    currency: basics.currency,
    note: note.value,
    coverDays: details.coverDays ?? null,
    shipToLocationId: readShipTo(details.shipTo, locations) ?? defaultShipTo(locations),
  });
  return { ok: true, ...created };
}

/** "Add to PO-00xx": the lines go onto the supplier's fresh draft (same supplier, under 14 days, same version). */
export async function addToSupplierDraft(
  shop: string,
  key: string,
  draftId: string,
  quantities: Record<string, number>,
  version: unknown,
  now: Date = new Date(),
  /** "Order enough for N days" chosen while adding: the draft records it (audit 2026-10-18). */
  coverDays: number | null = null,
): Promise<SupplierOrderResult> {
  const [suppliers, basics] = await Promise.all([planSuppliers(shop), shopBasics(shop)]);
  const s = supplierOfKey(key, suppliers);
  if (key.startsWith("supplier:") && !s) return { ok: false, error: "gone" };
  const name = s ? s.name : await vendorName(shop, key, suppliers);
  if (name === null) return { ok: false, error: "gone" };
  const info = { kind: s ? ("supplier" as const) : ("vendor" as const), supplierId: s?.id ?? null, name };
  const picked = await ownedLines(shop, key, quantities, suppliers);
  if (!picked.length) return { ok: false, error: "empty" };
  const lines = await draftLines(shop, picked, basics.currency);
  const r: OrderEditResult = await addDraftLines(shop, draftId, lines, version, (o) => draftBelongs(o, info, now));
  if (!r.ok) return r;
  if (coverDays !== null) await prisma.purchaseOrder.updateMany({ where: { id: draftId, shop, status: "draft" }, data: { coverDays } });
  const row = await prisma.purchaseOrder.findFirst({ where: { id: draftId, shop }, select: { number: true } });
  return { ok: true, id: draftId, number: row?.number ?? "", added: true };
}
