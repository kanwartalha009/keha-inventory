/**
 * The public supplier page (spec §14): look up an order by its random
 * 32-byte token, only while the link works (sent / confirmed Keha order,
 * before confirmExpiresAt = sent + 60 days), rate-limited per IP and per
 * token, and record the supplier's ship date. A missing, expired, draft,
 * cancelled or received order all look the same from outside.
 */
import prisma from "../db.server";
import { toSupportedLocale, type Locale } from "../lib/i18n";
import { storeLabel, todayIn } from "../lib/dashboard-shared";
import { clientIp, createRateLimiter } from "../lib/rate-limit-shared";
import { confirmLinkOpen, supplierLines, supplierTotals, validShipDate, type SupplierLine } from "../lib/purchase-order-shared";
import { getShopContact } from "./shop-contact.server";
import { getOrder, hidePricesFor, type OrderDetail } from "../models/reorder.server";

/** 20 requests per 10 minutes, per client address and per token (spec §14). */
export const CONFIRM_RATE = { limit: 20, windowMs: 10 * 60 * 1000 };
const byIp = createRateLimiter(CONFIRM_RATE);
const byToken = createRateLimiter(CONFIRM_RATE);

/** Counts one request; false when the client or the token is over the limit. */
export function allowConfirmRequest(request: Request, token: string, now: number = Date.now()): boolean {
  const ipOk = byIp.hit(`ip:${clientIp(request.headers)}`, now);
  const tokenOk = byToken.hit(`t:${token.slice(0, 64)}`, now);
  return ipOk && tokenOk;
}

/** Tokens are 43 base64url characters; anything else is refused without a database read. */
export const plausibleToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);

/**
 * What the public page sends to the browser (serialized into the HTML), so
 * only what the supplier may see: lines without variant ids, received units
 * or the merchant's on-hand baseline, and no unit costs, cost total or
 * currency when the supplier sees no prices (lib/purchase-order-shared
 * supplierLines).
 */
export type ConfirmView = {
  number: string;
  storeName: string;
  supplierName: string | null;
  lines: SupplierLine[];
  totalUnits: number;
  /** Only when prices are shown. */
  totalCost?: number | null;
  /** Only when prices are shown. */
  currency?: string | null;
  hidePrices: boolean;
  confirmedShipDate: string | null;
  expectedDate: string | null;
  /** First and last day the supplier may pick (store time zone). */
  minDate: string;
  maxDate: string;
};

export type ConfirmLookup = { ok: true; locale: Locale; shop: string; order: OrderDetail; view: ConfirmView } | { ok: false };

export async function lookupConfirm(token: string, now: Date = new Date()): Promise<ConfirmLookup> {
  if (!plausibleToken(token)) return { ok: false };
  const row = await prisma.purchaseOrder.findUnique({
    where: { confirmToken: token },
    select: { id: true, shop: true, source: true, status: true, confirmExpiresAt: true },
  });
  if (!row || !confirmLinkOpen(row, now)) return { ok: false };
  const [order, shopRow, contact] = await Promise.all([
    getOrder(row.shop, row.id),
    prisma.shop.findUnique({ where: { domain: row.shop }, select: { locale: true, timezone: true, uninstalledAt: true } }),
    getShopContact(row.shop),
  ]);
  if (!order || !shopRow || shopRow.uninstalledAt) return { ok: false };
  const today = todayIn(shopRow.timezone, now);
  const hidePrices = hidePricesFor(order);
  const lines = supplierLines(order.lines, hidePrices);
  const totals = supplierTotals(lines, hidePrices);
  const max = new Date(new Date(`${today}T00:00:00Z`).getTime() + 366 * 86_400_000).toISOString().slice(0, 10);
  return {
    ok: true,
    locale: toSupportedLocale(shopRow.locale),
    shop: row.shop,
    order,
    view: {
      number: order.number,
      storeName: contact?.name || storeLabel(row.shop),
      supplierName: order.supplier?.name ?? order.supplierName,
      lines,
      totalUnits: totals.units,
      ...(hidePrices ? {} : { totalCost: totals.cost ?? null, currency: order.currency }),
      hidePrices,
      confirmedShipDate: order.confirmedShipDate,
      expectedDate: order.expectedDate,
      minDate: today,
      maxDate: max,
    },
  };
}

/**
 * Records the ship date and moves the order to Confirmed. Only applies while
 * the link still works (checked again in the update itself).
 */
export async function confirmShipDate(
  token: string,
  rawDate: unknown,
  now: Date = new Date(),
): Promise<{ ok: true; date: string } | { ok: false; error: "invalid" | "date" }> {
  const found = await lookupConfirm(token, now);
  if (!found.ok) return { ok: false, error: "invalid" };
  const date = validShipDate(rawDate, found.view.minDate);
  if (!date) return { ok: false, error: "date" };
  const r = await prisma.purchaseOrder.updateMany({
    where: { confirmToken: token, source: "keha", status: { in: ["sent", "confirmed"] }, confirmExpiresAt: { gt: now } },
    data: { status: "confirmed", confirmedShipDate: new Date(`${date}T00:00:00Z`) },
  });
  return r.count === 1 ? { ok: true, date } : { ok: false, error: "invalid" };
}
