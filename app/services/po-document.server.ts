/**
 * Everything the PDF / CSV of a Keha order needs (spec §5.3): the order, the
 * store's name, the supplier's PO language (Settings → Suppliers; English by
 * default — merchant audit 2026-10-18), whether the supplier sees prices, the
 * supplier-page link while it works, and the details block: buyer (the store's
 * legal name and address), ship-to (the order's location, else the default),
 * payment terms, Incoterms, expected ship / arrival dates and the note. Shared
 * by the merchant downloads, the email and the public supplier page. Prices are
 * in the supplier's currency when it has an exchange rate (else the store
 * currency, labelled); the arrival is the ship date + transit days.
 */
import prisma from "../db.server";
import { storeLabel, todayIn } from "../lib/dashboard-shared";
import { defaultShipTo, poDates, readPoLanguage, type PoDetails } from "../lib/po-document-shared";
import { poBuyer, poShipTo } from "./po-parties.server";
import { confirmLinkOpen, supplierLines, type SupplierLine } from "../lib/purchase-order-shared";
import { buildPoGrid, poGridCsv, type GridLine } from "../lib/po-grid-shared";
import { poCsv, poFileName } from "../lib/purchase-order-shared";
import { poDetailRows, withDetailRows } from "../lib/po-document-shared";
import { translate } from "../lib/i18n";
import { confirmUrl } from "../lib/po-email-shared";
import { getShopContact } from "./shop-contact.server";
import { getOrder, hidePricesFor, pricingFor, type OrderDetail } from "../models/reorder.server";
import type { PoPdfInput } from "./po-pdf.server";

export async function documentFor(shop: string, order: OrderDetail, now: Date = new Date()): Promise<PoPdfInput> {
  const [shopRow, contact, details] = await Promise.all([
    prisma.shop.findUnique({ where: { domain: shop }, select: { timezone: true } }),
    getShopContact(shop),
    poDetailsFor(shop, order),
  ]);
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const hidePrices = hidePricesFor(order);
  // Prices in the supplier's currency when it has an exchange rate (audit 2026-10-17), else as stored.
  const pricing = pricingFor(order);
  const linkOpen = confirmLinkOpen({ source: order.source, status: order.status, confirmExpiresAt: order.confirmExpiresAt }, now);
  const lines = supplierLines(order.lines, hidePrices, pricing.factor);
  return {
    // The supplier's language, not the store's (merchant audit 2026-10-18).
    locale: readPoLanguage(order.supplier?.poLanguage),
    storeName: contact?.name || storeLabel(shop),
    number: order.number,
    supplierName: order.supplier?.name ?? order.supplierName,
    orderDate: (order.sentAt ?? order.createdAt).slice(0, 10),
    // Arrival = confirmed ship date + the supplier's transit days, else the lead-time estimate.
    expectedDate: order.arrival,
    confirmedShipDate: order.confirmedShipDate,
    currency: pricing.currency,
    hidePrices,
    // Supplier-safe lines: no variant ids / stock, and no unit cost when prices are hidden.
    lines,
    // The same lines grouped per product for the size grid (an opaque counter per product, never an id).
    gridLines: await gridLinesFor(shop, order.lines.map((l) => l.variantId), lines),
    confirmUrl: linkOpen && appUrl ? confirmUrl(appUrl, order.confirmToken) : null,
    details: { ...details, ...datesOf(order, shopRow?.timezone ?? "UTC", now) },
  };
}

/** Ship and arrival dates on the document (a draft: as if sent today). */
function datesOf(order: OrderDetail, timezone: string, now: Date): Pick<PoDetails, "shipDate" | "shipConfirmed" | "arrival"> {
  const d = poDates({
    status: order.status,
    arrival: order.arrival,
    confirmedShipDate: order.confirmedShipDate,
    orderDay: order.sentAt ? todayIn(timezone, new Date(order.sentAt)) : todayIn(timezone, now),
    leadTimeDays: order.supplier?.leadTimeDays ?? null,
    transitDays: order.supplier?.transitDays ?? null,
  });
  return { shipDate: d.ship, shipConfirmed: d.shipConfirmed, arrival: d.arrival };
}

/** Buyer, ship-to, terms, Incoterms and note for an order (dates: datesOf). */
async function poDetailsFor(shop: string, order: OrderDetail): Promise<Omit<PoDetails, "shipDate" | "shipConfirmed" | "arrival">> {
  const locations = await prisma.location.findMany({ where: { shop }, select: { id: true, name: true, active: true, role: true, online: true } });
  const shipToId = order.shipToLocationId && locations.some((l) => l.id === order.shipToLocationId) ? order.shipToLocationId : defaultShipTo(locations);
  const [buyer, shipTo] = await Promise.all([poBuyer(shop), shipToId ? poShipTo(shop, shipToId) : Promise.resolve(null)]);
  const known = shipToId ? locations.find((l) => l.id === shipToId) : null;
  return {
    buyer,
    // Shopify unreachable: the location's name from our copy is still better than nothing.
    shipTo: shipTo ?? (known ? { name: known.name, lines: [] } : null),
    terms: order.supplier?.terms ?? null,
    incoterms: order.supplier?.incoterms ?? null,
    note: order.note ?? null,
  };
}

/**
 * The document's lines with their product grouping and supplier code: products and codes are read
 * from the catalog (a deleted variant groups by its product title); the group key is a counter.
 */
async function gridLinesFor(shop: string, variantIds: readonly string[], lines: readonly SupplierLine[]): Promise<GridLine[]> {
  const rows = variantIds.length
    ? await prisma.variant.findMany({ where: { shop, id: { in: [...new Set(variantIds)] } }, select: { id: true, productId: true, supplierCode: true } })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const groups = new Map<string, string>();
  return lines.map((l, i) => {
    const v = byId.get(variantIds[i]!);
    const key = v ? `p:${v.productId}` : `t:${l.productTitle}`;
    if (!groups.has(key)) groups.set(key, `g${groups.size + 1}`);
    return { ...l, group: groups.get(key)!, supplierCode: v?.supplierCode ?? null };
  });
}

/** A Keha order of this shop as a document; null for a missing or Shopify order. */
export async function poDocument(shop: string, id: string): Promise<{ pdf: PoPdfInput } | null> {
  const order = await getOrder(shop, id);
  if (!order || order.source !== "keha") return null;
  return { pdf: await documentFor(shop, order) };
}

/**
 * The order as CSV (one line per variant; `grid` = the size grid), headers in the supplier's PO
 * language, the detail rows above the table, no unit costs when the supplier sees no prices.
 * Shared by the merchant download (/app/reorder/:id/csv) and the supplier page
 * (/supplier/confirm/:token/csv).
 */
export function poCsvFile(pdf: PoPdfInput, grid: boolean): { csv: string; fileName: string } {
  const tr = (s: string) => translate(pdf.locale, s);
  const table = grid
    ? poGridCsv(buildPoGrid(pdf.gridLines ?? pdf.lines.map((l, i) => ({ ...l, group: `l${i}` })), pdf.hidePrices), tr, { hidePrices: pdf.hidePrices, currency: pdf.currency })
    : poCsv(pdf.lines, tr, { hidePrices: pdf.hidePrices, currency: pdf.currency });
  const csv = withDetailRows(table, pdf.details ? poDetailRows(pdf.details, tr, (d) => d) : []);
  return { csv, fileName: poFileName(grid ? `${pdf.number}-grid` : pdf.number, "csv") };
}
