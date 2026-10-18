/**
 * Suppliers (Settings → Suppliers, spec §5.5). Emails are stored encrypted
 * (AES-256-GCM, lib/crypto.server — spec §14) and decrypted only for the edit
 * form and the supplier email. Assignment: by vendor (Supplier.vendorMatch)
 * or by product (Variant.supplierId on every variant of the product); an
 * explicit product assignment wins (lib/supplier-shared supplierFor).
 */
import prisma from "../db.server";
import { forgetOrderPlan } from "./plan-cache.server";
import { decryptSecret, encryptSecret } from "../lib/crypto.server";
import { readSettings } from "../lib/settings-shared";
import { readMinOrderScope, readPoLines, type MinOrderScope } from "../lib/supplier-shared";
import { closedWithNothingDelivered } from "../lib/purchase-order-shared";
import { supplierToForm, type SupplierForm, type SupplierInput } from "../lib/suppliers-shared";
import { deliveryOf, leadStats, measuredLead, readLeadStats, statsChanged, supplierOfOrder, type Delivery, type LeadStats } from "../lib/lead-time-shared";
import { readLandedPct, readPaymentTerms, type PaymentTerms } from "../lib/cash-shared";
import { localDate } from "../lib/sync/store-time-shared";
import { readPoLanguage } from "../lib/po-document-shared";
import type { Locale } from "../lib/i18n";

export type SupplierListRow = {
  id: string;
  name: string;
  hasEmail: boolean;
  leadTimeDays: number;
  minOrder: number | null;
  minOrderTotal: number | null;
  casePack: number | null;
  transitDays: number | null;
  /** Order every … days; null = the store's order cycle. */
  orderCycleDays: number | null;
  /** In the supplier's currency. */
  minOrderValue: number | null;
  minOrderScope: MinOrderScope;
  exchangeRate: number | null;
  currency: string | null;
  hidePrices: boolean;
  vendorMatch: string[];
  /** Products assigned by product (not by vendor). */
  products: number;
  /** Payment terms (null = everything paid when ordering) and freight + duty %. */
  terms?: PaymentTerms | null;
  landedPct?: number | null;
  /** Measured lead time from received orders; null = none yet. */
  leadStats?: LeadStats | null;
  /** The language of its purchase orders, and its delivery terms. */
  poLanguage?: Locale;
  incoterms?: string | null;
};

const LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  leadTimeDays: true,
  minOrder: true,
  minOrderTotal: true,
  casePack: true,
  transitDays: true,
  orderCycleDays: true,
  minOrderValue: true,
  minOrderScope: true,
  exchangeRate: true,
  currency: true,
  hidePrices: true,
  vendorMatch: true,
  depositPercent: true,
  balanceDue: true,
  balanceDays: true,
  landedCostPercent: true,
  leadSamples: true,
  leadPromisedDays: true,
  leadActualDays: true,
  leadDelayDays: true,
  leadSigmaDays: true,
  leadOnTimeShare: true,
  leadMedianDays: true,
  leadP80Days: true,
  leadMedianDelayDays: true,
  poLanguage: true,
  incoterms: true,
} as const;

/** Decimal columns (Prisma.Decimal) → plain numbers; a column a row does not carry reads as none. */
const dec = (v: { toString(): string } | null | undefined): number | null => (v == null ? null : Number(v.toString()));

function plain<
  T extends {
    minOrderValue: { toString(): string } | null;
    exchangeRate: { toString(): string } | null;
    landedCostPercent: { toString(): string } | null;
    minOrderScope: string;
  },
>(s: T) {
  return {
    ...s,
    minOrderValue: dec(s.minOrderValue),
    exchangeRate: dec(s.exchangeRate),
    landedCostPercent: dec(s.landedCostPercent),
    minOrderScope: readMinOrderScope(s.minOrderScope),
  };
}

export async function listSuppliers(shop: string): Promise<SupplierListRow[]> {
  const [rows, assigned] = await Promise.all([
    prisma.supplier.findMany({ where: { shop }, select: LIST_SELECT, orderBy: [{ name: "asc" }, { id: "asc" }] }),
    prisma.variant.groupBy({ by: ["supplierId", "productId"], where: { shop, supplierId: { not: null } } }),
  ]);
  const products = new Map<string, number>();
  for (const a of assigned) if (a.supplierId) products.set(a.supplierId, (products.get(a.supplierId) ?? 0) + 1);
  return rows.map(({ email, ...s }) => {
    const p = plain(s);
    return {
      id: p.id,
      name: p.name,
      leadTimeDays: p.leadTimeDays,
      minOrder: p.minOrder,
      minOrderTotal: p.minOrderTotal,
      casePack: p.casePack,
      transitDays: p.transitDays,
      orderCycleDays: p.orderCycleDays,
      minOrderValue: p.minOrderValue,
      minOrderScope: p.minOrderScope,
      exchangeRate: p.exchangeRate,
      currency: p.currency,
      hidePrices: p.hidePrices,
      vendorMatch: p.vendorMatch,
      hasEmail: !!email,
      products: products.get(s.id) ?? 0,
      terms: readPaymentTerms(p),
      landedPct: readLandedPct(p.landedCostPercent),
      leadStats: readLeadStats(p),
      poLanguage: readPoLanguage(p.poLanguage),
      incoterms: p.incoterms ?? null,
    };
  });
}

/** One supplier as an edit form (email decrypted); null when not this shop's. */
export async function supplierForm(shop: string, id: string): Promise<SupplierForm | null> {
  const s = await prisma.supplier.findFirst({ where: { id, shop }, select: LIST_SELECT });
  if (!s) return null;
  return supplierToForm({ ...plain(s), email: s.email ? decryptSecret(s.email) || null : null });
}

/** The other suppliers' names (unique-name check). */
export async function otherSupplierNames(shop: string, exceptId: string | null): Promise<string[]> {
  const rows = await prisma.supplier.findMany({ where: { shop, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { name: true } });
  return rows.map((r) => r.name);
}

function data(input: SupplierInput) {
  return {
    name: input.name,
    email: input.email ? encryptSecret(input.email) : null,
    leadTimeDays: input.leadTimeDays,
    minOrder: input.minOrder,
    minOrderTotal: input.minOrderTotal,
    casePack: input.casePack,
    transitDays: input.transitDays,
    orderCycleDays: input.orderCycleDays,
    minOrderValue: input.minOrderValue,
    minOrderScope: input.minOrderScope,
    exchangeRate: input.exchangeRate,
    currency: input.currency,
    hidePrices: input.hidePrices,
    vendorMatch: input.vendorMatch,
    depositPercent: input.depositPercent,
    balanceDue: input.balanceDue,
    balanceDays: input.balanceDays,
    landedCostPercent: input.landedCostPercent,
    ...(input.poLanguage !== undefined ? { poLanguage: input.poLanguage } : {}),
    ...(input.incoterms !== undefined ? { incoterms: input.incoterms } : {}),
  };
}

/** The row data saveSupplier writes (email encrypted) — the CSV import writes the same. */
export const supplierWriteData = data;

/** Every supplier as an edit form (emails decrypted), name order — the CSV import / export (models/setup-import). */
export async function listSupplierForms(shop: string): Promise<{ id: string; form: SupplierForm }[]> {
  const rows = await prisma.supplier.findMany({ where: { shop }, select: LIST_SELECT, orderBy: [{ name: "asc" }, { id: "asc" }] });
  return rows.map((s) => ({ id: s.id, form: supplierToForm({ ...plain(s), email: s.email ? decryptSecret(s.email) || null : null }) }));
}

/** Create (id null) or update this shop's supplier. Returns its id, or null when the id isn't this shop's. */
export async function saveSupplier(shop: string, id: string | null, input: SupplierInput): Promise<string | null> {
  if (!id) {
    const created = await prisma.supplier.create({ data: { shop, ...data(input) }, select: { id: true } });
    forgetOrderPlan(shop);
    return created.id;
  }
  const r = await prisma.supplier.updateMany({ where: { id, shop }, data: data(input) });
  forgetOrderPlan(shop);
  return r.count === 1 ? id : null;
}

/**
 * Deletes a supplier. Its products go back to vendor matching, and its
 * orders keep their snapshot (number, supplier name, lines).
 *
 * The orders also keep `supplierId` (now pointing at no supplier): that is
 * how they remember "this order's supplier was deleted", so its prices stay
 * hidden from the supplier page, PDF and email (models/reorder hidePricesFor:
 * a supplier id with no supplier = hidden, the safe default). Nulling it
 * would make the order look like a never-assigned vendor order and show the
 * prices the merchant had hidden (review fix 2026-10-17).
 */
export async function deleteSupplier(shop: string, id: string): Promise<boolean> {
  const [, del] = await prisma.$transaction([
    prisma.variant.updateMany({ where: { shop, supplierId: id }, data: { supplierId: null } }),
    prisma.supplier.deleteMany({ where: { id, shop } }),
  ]);
  forgetOrderPlan(shop);
  return del.count === 1;
}

/** Assigns every variant of these products to the supplier. Returns the variants changed, or null for a foreign supplier. */
export async function assignProducts(shop: string, supplierId: string, productIds: string[]): Promise<number | null> {
  const s = await prisma.supplier.findFirst({ where: { id: supplierId, shop }, select: { id: true } });
  if (!s) return null;
  if (!productIds.length) return 0;
  const r = await prisma.variant.updateMany({ where: { shop, productId: { in: productIds } }, data: { supplierId } });
  forgetOrderPlan(shop);
  return r.count;
}

/** Removes the by-product assignments of a supplier (vendor matching applies again). */
export async function clearProducts(shop: string, supplierId: string): Promise<number> {
  const r = await prisma.variant.updateMany({ where: { shop, supplierId }, data: { supplierId: null } });
  forgetOrderPlan(shop);
  return r.count;
}

/** The store's currency (decides whether a supplier's exchange rate applies). */
export async function storeCurrency(shop: string): Promise<string> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { currency: true } });
  return row?.currency ?? "USD";
}

/** The store's vendors (vendor-match choices) and defaults for a new supplier. */
export async function supplierContext(shop: string): Promise<{ vendors: string[]; currency: string; leadTimeDays: number; cycleDays: number }> {
  const [vendors, row] = await Promise.all([
    prisma.variant.groupBy({
      by: ["vendor"],
      where: { shop, vendor: { not: null } },
      orderBy: { vendor: "asc" },
      take: 500,
    }),
    prisma.shop.findUnique({ where: { domain: shop }, select: { currency: true, settings: true } }),
  ]);
  return {
    vendors: vendors.map((v) => v.vendor).filter((v): v is string => !!v && !!v.trim()),
    currency: row?.currency ?? "USD",
    leadTimeDays: readSettings(row?.settings).leadTimeDays,
    cycleDays: readSettings(row?.settings).cycleDays,
  };
}

/**
 * Measure every supplier's lead time from its received orders (lib/lead-time-shared) and store the
 * stats on the Supplier row — only rows whose numbers changed are written. Run by the nightly
 * compute (before it reads the suppliers: the σ feeds safety stock) and after an order is received.
 * Returns the suppliers updated.
 */
export async function refreshLeadStats(shop: string): Promise<number> {
  const [suppliers, shopRow, orders] = await Promise.all([
    prisma.supplier.findMany({
      where: { shop },
      select: {
        id: true,
        name: true,
        vendorMatch: true,
        leadTimeDays: true,
        leadSamples: true,
        leadPromisedDays: true,
        leadActualDays: true,
        leadDelayDays: true,
        leadSigmaDays: true,
        leadOnTimeShare: true,
        leadMedianDays: true,
        leadP80Days: true,
        leadMedianDelayDays: true,
      },
    }),
    prisma.shop.findUnique({ where: { domain: shop }, select: { timezone: true } }),
    prisma.purchaseOrder.findMany({
      where: { shop, status: "received", sentAt: { not: null }, receivedAt: { not: null } },
      select: { source: true, supplierId: true, supplierName: true, sentAt: true, receivedAt: true, expectedDate: true, createdAt: true, lines: true },
      orderBy: { receivedAt: "desc" },
      take: 5000,
    }),
  ]);
  if (!suppliers.length) return 0;
  const tz = shopRow?.timezone ?? "UTC";
  const day = (d: Date | null | undefined) => (d instanceof Date ? localDate(d, tz) : null);
  const per = new Map<string, Delivery[]>();
  for (const o of orders) {
    // Closed before anything arrived: no delivery to measure.
    if (closedWithNothingDelivered({ source: o.source, lines: readPoLines(o.lines) })) continue;
    const s = supplierOfOrder(o, suppliers);
    if (!s) continue;
    const d = deliveryOf({
      source: o.source,
      sentDay: day(o.sentAt),
      receivedDay: day(o.receivedAt),
      // A calendar day stored at UTC midnight (@db.Date).
      expectedDay: o.expectedDate instanceof Date ? o.expectedDate.toISOString().slice(0, 10) : null,
      firstSeenDay: day(o.createdAt),
      leadTimeDays: s.leadTimeDays,
    });
    if (d) (per.get(s.id) ?? per.set(s.id, []).get(s.id)!).push(d);
  }
  let updated = 0;
  for (const s of suppliers) {
    const next = leadStats(per.get(s.id) ?? []);
    if (!statsChanged(readLeadStats(s), next)) continue;
    await prisma.supplier.updateMany({
      where: { id: s.id, shop },
      data: {
        leadSamples: next?.samples ?? null,
        leadPromisedDays: next?.promisedAvg ?? null,
        leadActualDays: next?.actualAvg ?? null,
        leadDelayDays: next?.delayAvg ?? null,
        leadSigmaDays: next?.sigma ?? null,
        leadOnTimeShare: next?.onTimeShare ?? null,
        leadMedianDays: next?.medianDays ?? null,
        leadP80Days: next?.p80Days ?? null,
        leadMedianDelayDays: next?.medianDelay ?? null,
        leadStatsAt: new Date(),
      },
    });
    updated++;
  }
  if (updated) forgetOrderPlan(shop);
  return updated;
}

export type UseMeasuredResult = { ok: true; leadTimeDays: number } | { ok: false; error: "notFound" | "notMeasured" };

/**
 * "Use measured lead time" (merchant audit 2026-10-18): the supplier's lead time becomes the median
 * of its measured deliveries (rounded; at least MIN_SAMPLES). Transit days stay ≤ the lead time.
 * Our database only; the order plan follows at once.
 */
export async function applyMeasuredLeadTime(shop: string, id: string): Promise<UseMeasuredResult> {
  const s = await prisma.supplier.findFirst({ where: { id, shop }, select: LIST_SELECT });
  if (!s) return { ok: false, error: "notFound" };
  const m = measuredLead(readLeadStats(s));
  if (!m) return { ok: false, error: "notMeasured" };
  const transit = s.transitDays !== null && s.transitDays !== undefined && s.transitDays > m.suggested ? m.suggested : s.transitDays;
  await prisma.supplier.updateMany({ where: { id, shop }, data: { leadTimeDays: m.suggested, transitDays: transit } });
  forgetOrderPlan(shop);
  return { ok: true, leadTimeDays: m.suggested };
}
