/**
 * Suppliers (Settings → Suppliers, spec §5.5). Emails are stored encrypted
 * (AES-256-GCM, lib/crypto.server — spec §14) and decrypted only for the edit
 * form and the supplier email. Assignment: by vendor (Supplier.vendorMatch)
 * or by product (Variant.supplierId on every variant of the product); an
 * explicit product assignment wins (lib/supplier-shared supplierFor).
 */
import prisma from "../db.server";
import { decryptSecret, encryptSecret } from "../lib/crypto.server";
import { readSettings } from "../lib/settings-shared";
import { readMinOrderScope, type MinOrderScope } from "../lib/supplier-shared";
import { supplierToForm, type SupplierForm, type SupplierInput } from "../lib/suppliers-shared";

export type SupplierListRow = {
  id: string;
  name: string;
  hasEmail: boolean;
  leadTimeDays: number;
  minOrder: number | null;
  minOrderTotal: number | null;
  casePack: number | null;
  transitDays: number | null;
  /** In the supplier's currency. */
  minOrderValue: number | null;
  minOrderScope: MinOrderScope;
  exchangeRate: number | null;
  currency: string | null;
  hidePrices: boolean;
  vendorMatch: string[];
  /** Products assigned by product (not by vendor). */
  products: number;
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
  minOrderValue: true,
  minOrderScope: true,
  exchangeRate: true,
  currency: true,
  hidePrices: true,
  vendorMatch: true,
} as const;

/** Decimal columns (Prisma.Decimal) → plain numbers for the page. */
const dec = (v: { toString(): string } | null): number | null => (v === null ? null : Number(v.toString()));

function plain<T extends { minOrderValue: { toString(): string } | null; exchangeRate: { toString(): string } | null; minOrderScope: string }>(s: T) {
  return { ...s, minOrderValue: dec(s.minOrderValue), exchangeRate: dec(s.exchangeRate), minOrderScope: readMinOrderScope(s.minOrderScope) };
}

export async function listSuppliers(shop: string): Promise<SupplierListRow[]> {
  const [rows, assigned] = await Promise.all([
    prisma.supplier.findMany({ where: { shop }, select: LIST_SELECT, orderBy: [{ name: "asc" }, { id: "asc" }] }),
    prisma.variant.groupBy({ by: ["supplierId", "productId"], where: { shop, supplierId: { not: null } } }),
  ]);
  const products = new Map<string, number>();
  for (const a of assigned) if (a.supplierId) products.set(a.supplierId, (products.get(a.supplierId) ?? 0) + 1);
  return rows.map(({ email, ...s }) => ({ ...plain(s), hasEmail: !!email, products: products.get(s.id) ?? 0 }));
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
    minOrderValue: input.minOrderValue,
    minOrderScope: input.minOrderScope,
    exchangeRate: input.exchangeRate,
    currency: input.currency,
    hidePrices: input.hidePrices,
    vendorMatch: input.vendorMatch,
  };
}

/** Create (id null) or update this shop's supplier. Returns its id, or null when the id isn't this shop's. */
export async function saveSupplier(shop: string, id: string | null, input: SupplierInput): Promise<string | null> {
  if (!id) return (await prisma.supplier.create({ data: { shop, ...data(input) }, select: { id: true } })).id;
  const r = await prisma.supplier.updateMany({ where: { id, shop }, data: data(input) });
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
  return del.count === 1;
}

/** Assigns every variant of these products to the supplier. Returns the variants changed, or null for a foreign supplier. */
export async function assignProducts(shop: string, supplierId: string, productIds: string[]): Promise<number | null> {
  const s = await prisma.supplier.findFirst({ where: { id: supplierId, shop }, select: { id: true } });
  if (!s) return null;
  if (!productIds.length) return 0;
  const r = await prisma.variant.updateMany({ where: { shop, productId: { in: productIds } }, data: { supplierId } });
  return r.count;
}

/** Removes the by-product assignments of a supplier (vendor matching applies again). */
export async function clearProducts(shop: string, supplierId: string): Promise<number> {
  const r = await prisma.variant.updateMany({ where: { shop, supplierId }, data: { supplierId: null } });
  return r.count;
}

/** The store's currency (decides whether a supplier's exchange rate applies). */
export async function storeCurrency(shop: string): Promise<string> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { currency: true } });
  return row?.currency ?? "USD";
}

/** The store's vendors (vendor-match choices) and defaults for a new supplier. */
export async function supplierContext(shop: string): Promise<{ vendors: string[]; currency: string; leadTimeDays: number }> {
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
  };
}
