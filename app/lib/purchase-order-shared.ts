/**
 * Keha purchase orders (spec §5.3, J3, §14): numbers, status changes, dates,
 * the CSV, the confirm-link rules, auto-receive, and (merchant audit 2026-10-17)
 * draft edits, partial receiving, re-opening, supplier-currency prices, the
 * order minimums and the Open orders list. Pure, client-safe.
 *
 * Status flow: draft → sent → confirmed → received; draft / sent / confirmed
 * can be cancelled. A received or cancelled order can be re-opened for 30 days
 * (`reopenTarget`). "Partially received" is derived (a sent / confirmed order
 * with some `received` units), not a status of its own: everything that reads
 * statuses keeps working, and only the remaining units (qty − received) count
 * as incoming. Orders read from Shopify (source "shopify") are read-only here:
 * Shopify is their source of truth.
 */
import { toCsv } from "./products-shared";
import { addDays } from "./engine/dates-shared";
import { localDate } from "./sync/store-time-shared";
import { lineRemaining, type PoLine } from "./supplier-shared";

type T = (s: string) => string;

export const PO_STATUSES = ["draft", "sent", "confirmed", "received", "cancelled"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export function isPoStatus(v: unknown): v is PoStatus {
  return typeof v === "string" && (PO_STATUSES as readonly string[]).includes(v);
}

/** Allowed moves for a Keha order (the merchant presses the button; each one has a confirm). */
export const PO_TRANSITIONS: Record<PoStatus, readonly PoStatus[]> = {
  draft: ["sent", "cancelled"],
  sent: ["confirmed", "received", "cancelled"],
  confirmed: ["received", "cancelled"],
  received: [],
  cancelled: [],
};

export function canTransition(from: string, to: string, source: string = "keha"): boolean {
  if (source !== "keha" || !isPoStatus(from) || !isPoStatus(to)) return false;
  return PO_TRANSITIONS[from].includes(to);
}

/** Statuses whose units count as "on order" for the Reorder suggestions (drafts too: no double ordering). */
export const REORDER_HOLD_STATUSES = ["draft", "sent", "confirmed"] as const;

/** The supplier confirm link works this long after the order is sent (spec §14). */
export const CONFIRM_LINK_DAYS = 60;
const DAY_MS = 86_400_000;

// ── Numbers ────────────────────────────────────────────────────────────────

export function formatPoNumber(n: number): string {
  return `PO-${String(Math.max(1, Math.floor(n))).padStart(4, "0")}`;
}

/** Next free "PO-0001"-style number given the store's existing numbers (any source). */
export function nextPoNumber(existing: readonly string[]): string {
  let max = 0;
  for (const s of existing) {
    const m = /^PO-(\d{1,9})$/.exec(s);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return formatPoNumber(max + 1);
}

// ── Dates ──────────────────────────────────────────────────────────────────

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * When an order is sent: expected arrival and the confirm-link expiry. The arrival is a calendar
 * day (stored at UTC midnight, @db.Date): the STORE-LOCAL day the order was sent + the lead time
 * (L1: an order sent at 23:30 in Madrid was sent on that Madrid day, not the next UTC one).
 */
export function sentDates(sentAt: Date, leadTimeDays: number, timeZone?: string | null): { expectedDate: string; confirmExpiresAt: Date } {
  const lead = Number.isFinite(leadTimeDays) && leadTimeDays > 0 ? Math.floor(leadTimeDays) : 0;
  return {
    expectedDate: addDays(localDate(sentAt, timeZone), lead),
    confirmExpiresAt: new Date(sentAt.getTime() + CONFIRM_LINK_DAYS * DAY_MS),
  };
}

/**
 * Does the supplier confirm link work? Only for Keha orders that were sent
 * (sent / confirmed) and before the expiry. Every other case gets the same
 * answer, so the page never tells a guesser whether a token existed.
 */
export function confirmLinkOpen(
  po: { source: string; status: string; confirmExpiresAt: Date | string | null } | null,
  now: Date,
): boolean {
  if (!po || po.source !== "keha") return false;
  if (po.status !== "sent" && po.status !== "confirmed") return false;
  if (!po.confirmExpiresAt) return false;
  return new Date(po.confirmExpiresAt).getTime() > now.getTime();
}

/** A ship date the supplier may pick: a real "YYYY-MM-DD" from today to one year ahead. */
export function validShipDate(raw: unknown, today: string): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || dayOf(d) !== raw) return null;
  const last = dayOf(new Date(new Date(`${today}T00:00:00Z`).getTime() + 366 * DAY_MS));
  return raw >= today && raw <= last ? raw : null;
}

// ── Totals and the CSV ─────────────────────────────────────────────────────

/** Units and cost of an order; cost null when any line has no unit cost. */
export function poTotals(lines: readonly Pick<PoLine, "qty" | "unitCost">[]): { units: number; cost: number | null } {
  let units = 0;
  let cost: number | null = 0;
  for (const l of lines) {
    units += l.qty;
    if (cost !== null) cost = l.unitCost === null ? null : cost + l.unitCost * l.qty;
  }
  return { units, cost: cost === null ? null : Math.round(cost * 100) / 100 };
}

/**
 * One order line as the SUPPLIER may see it (public page, supplier PDF and
 * email — spec §14). Only what's needed to fill the order: no variant ids,
 * no received units, no on-hand baseline (the merchant's stock), and no unit
 * cost at all when the supplier sees no prices (the key is left out, not
 * nulled, so nothing hidden reaches a browser or a document).
 */
export type SupplierLine = {
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  qty: number;
  /** Present only when prices are shown. */
  unitCost?: number | null;
};

export function supplierLines(lines: readonly PoLine[], hidePrices: boolean, factor = 1): SupplierLine[] {
  return lines.map((l) => {
    const out: SupplierLine = { productTitle: l.productTitle, variantTitle: l.variantTitle, sku: l.sku, qty: l.qty };
    // `factor`: the supplier-currency conversion (poPricing); 1 = as stored.
    if (!hidePrices) out.unitCost = convertCost(l.unitCost, factor);
    return out;
  });
}

/** Totals a supplier may see: units always, the cost only when prices are shown. */
export function supplierTotals(lines: readonly SupplierLine[], hidePrices: boolean): { units: number; cost?: number | null } {
  const t = poTotals(lines.map((l) => ({ qty: l.qty, unitCost: l.unitCost ?? null })));
  return hidePrices ? { units: t.units } : t;
}

/** "Default Title" is Shopify's name for a product's only variant. */
export const lineVariant = (title: string) => (title && title !== "Default Title" ? title : "");

const money2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

/**
 * The order as CSV (headers in the store / admin language). Unit cost and
 * line total are left out when the supplier sees no prices.
 */
export function poCsv(lines: readonly SupplierLine[], t: T, opts: { hidePrices: boolean; currency: string | null }): string {
  const header = [t("SKU"), t("Product"), t("Variant"), t("Quantity")];
  if (!opts.hidePrices) header.push(t("Unit cost"), t("Line total"), t("Currency"));
  const rows = lines.map((l) => {
    const row: (string | number | null)[] = [l.sku, l.productTitle, lineVariant(l.variantTitle), l.qty];
    if (!opts.hidePrices) row.push(money2(l.unitCost ?? null), l.unitCost == null ? null : money2(l.unitCost * l.qty), opts.currency);
    return row;
  });
  return toCsv(header, rows);
}

/** A safe download name: "PO-0001.pdf". */
export function poFileName(number: string, ext: "pdf" | "csv"): string {
  return `${number.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "order"}.${ext}`;
}

// ── Auto-receive ───────────────────────────────────────────────────────────

export const AUTO_RECEIVE_SHARE = 0.9;
/** The arrival window opens this many days before the expected arrival (ship date + transit, else the estimate). */
export const ARRIVAL_WINDOW_DAYS = 7;

const addDay = (day: string, n: number) => dayOf(new Date(new Date(`${day}T00:00:00Z`).getTime() + n * DAY_MS));

/**
 * The first day stock for this order can plausibly arrive: the expected arrival (poArrival —
 * the confirmed ship date + the supplier's transit days, else the lead-time estimate) − 7 days
 * (M1: a ship date 35 days before arrival no longer opens the window on the ship date, when the
 * goods are still at sea); never before the supplier's confirmed ship date (nothing lands before
 * it ships) and never before the order was sent. `arrival` must already include the transit.
 * null = no date known (auto-receive waits).
 */
export function arrivalWindowStart(po: { confirmedShipDate: string | null; arrival: string | null; sentDay: string | null }): string | null {
  let open = po.arrival ? addDay(po.arrival, -ARRIVAL_WINDOW_DAYS) : po.confirmedShipDate;
  if (!open) return null;
  if (po.confirmedShipDate && po.confirmedShipDate > open) open = po.confirmedShipDate;
  return po.sentDay && po.sentDay > open ? po.sentDay : open;
}

export type AutoReceiveInput = {
  status: string;
  source: string;
  /** arrivalWindowStart(); null = not due. */
  windowStart: string | null;
  /** The day the order was sent (store time). */
  sentDay: string | null;
  today: string;
  lines: readonly Pick<PoLine, "variantId" | "qty" | "received" | "baseOnHand" | "reopenedAt">[];
  /** On-hand (online pool) per variant at the end of the day before the window opened (StockDaily). */
  baseline: ReadonlyMap<string, number>;
  /** On-hand (online pool) now. */
  onHand: ReadonlyMap<string, number>;
  /** Units sold (online pool) since the window opened. */
  soldSince: ReadonlyMap<string, number>;
  /** Stock rise per variant already credited to another order in this run (never count one delivery twice). */
  used?: ReadonlyMap<string, number>;
};

export type AutoReceiveResult =
  | { receive: true; share: number; received: Record<string, number> }
  | { receive: false; reason: "status" | "not_due" | "manual" | "no_baseline" | "not_landed"; share: number | null };

/**
 * Close a sent / confirmed Keha order when its stock has landed (J3), tightened after the
 * 2026-10-17 merchant audit so a stock correction or another delivery can't close it:
 *  - only from the day the arrival window opened (arrivalWindowStart), and the rise is
 *    measured from that day: on-hand now − on-hand when the window opened + units sold since
 *    (sales would otherwise hide a delivery). When the window opened on the send day, the
 *    line's on-hand at send (baseOnHand) is the baseline;
 *  - per line: EVERY open line must have ≥ 90 % of its units landed (capped at 0…ordered,
 *    minus rise already credited to another order this run);
 *  - an order the merchant has partly received by hand is left to the merchant ("manual");
 *  - so is an order the merchant re-opened after it was received (a line's `reopenedAt`, H1):
 *    the stock rise that closed it is still there, so measuring again would close it again
 *    the next night; re-opening means "I'll receive this one myself";
 *  - drafts, cancelled and received orders and Shopify orders are never touched.
 * A line without a baseline means we can't tell: the order stays open.
 */
export function autoReceiveDecision(input: AutoReceiveInput): AutoReceiveResult {
  if (input.source !== "keha" || (input.status !== "sent" && input.status !== "confirmed")) {
    return { receive: false, reason: "status", share: null };
  }
  if (!input.windowStart || input.today < input.windowStart) return { receive: false, reason: "not_due", share: null };
  if (input.lines.some((l) => !!l.reopenedAt)) return { receive: false, reason: "manual", share: null };
  const open = input.lines.filter((l) => l.qty > 0 && (l.received ?? 0) < l.qty);
  if (open.some((l) => (l.received ?? 0) > 0)) return { receive: false, reason: "manual", share: null };
  const fromSend = !!input.sentDay && input.windowStart <= input.sentDay;
  let ordered = 0;
  let arrived = 0;
  let allLanded = true;
  const received: Record<string, number> = {};
  const credited = new Map(input.used ?? []);
  for (const l of open) {
    const base = fromSend ? (l.baseOnHand ?? input.baseline.get(l.variantId)) : input.baseline.get(l.variantId);
    const now = input.onHand.get(l.variantId);
    if (base === undefined || now === undefined) return { receive: false, reason: "no_baseline", share: null };
    const rise = now - base + (input.soldSince.get(l.variantId) ?? 0) - (credited.get(l.variantId) ?? 0);
    const got = Math.min(l.qty, Math.max(0, Math.floor(rise)));
    credited.set(l.variantId, (credited.get(l.variantId) ?? 0) + got);
    ordered += l.qty;
    arrived += got;
    received[l.variantId] = (received[l.variantId] ?? 0) + got;
    if (got < AUTO_RECEIVE_SHARE * l.qty - 1e-9) allLanded = false;
  }
  if (ordered === 0) return { receive: false, reason: "not_landed", share: null };
  const share = arrived / ordered;
  return allLanded ? { receive: true, share, received } : { receive: false, reason: "not_landed", share };
}

/** The lines after auto-receive closed the order: received = landed units, marked so the merchant can undo it. */
export function autoReceivedLines(lines: readonly PoLine[], received: Record<string, number>): PoLine[] {
  return lines.map((l) => {
    if (!(l.qty > 0) || (l.received ?? 0) >= l.qty) return { ...l, reopenReceived: l.received ?? 0 };
    const got = received[l.variantId] ?? 0;
    return { ...l, received: got, ...(got > 0 ? { autoReceived: got } : {}), reopenReceived: l.received ?? 0 };
  });
}

// ── Receiving, editing, re-opening (audit 2026-10-17) ─────────────────────

/** Units still to arrive on a line (one rule: supplier-shared lineRemaining). */
export { lineRemaining };

export function poProgress(lines: readonly Pick<PoLine, "qty" | "received">[]): { ordered: number; received: number; remaining: number } {
  let ordered = 0;
  let received = 0;
  let remaining = 0;
  for (const l of lines) {
    ordered += l.qty;
    received += Math.min(l.qty, l.received ?? 0);
    remaining += lineRemaining(l);
  }
  return { ordered, received, remaining };
}

/** A sent / confirmed order with some units received: "Partially received" (derived, no status of its own). */
export function partiallyReceived(o: { status: string; lines: readonly Pick<PoLine, "qty" | "received">[] }): boolean {
  return (o.status === "sent" || o.status === "confirmed") && o.lines.some((l) => (l.received ?? 0) > 0);
}

/** Closed automatically by auto-receive. */
export const wasAutoReceived = (o: { status: string; lines: readonly Pick<PoLine, "autoReceived">[] }) =>
  o.status === "received" && o.lines.some((l) => (l.autoReceived ?? 0) > 0);

/** Units closed as short: the order was closed by hand with units still missing. */
export function shortUnits(o: { status: string; lines: readonly Pick<PoLine, "qty" | "received" | "autoReceived">[] }): number {
  if (o.status !== "received" || wasAutoReceived(o)) return 0;
  return poProgress(o.lines).remaining;
}

const MAX_QTY = 1_000_000;
const wholeQty = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_QTY ? n : null;
};

export type DraftEditResult = { ok: true; lines: PoLine[] } | { ok: false; error: "invalid" | "empty" };

/**
 * A draft's new quantities, one per existing line in order (0 removes the line). Only the lines
 * already on the draft can change: nothing is added, prices and snapshots stay as they were.
 */
export function applyDraftEdit(lines: readonly PoLine[], quantities: unknown): DraftEditResult {
  if (!Array.isArray(quantities) || quantities.length !== lines.length) return { ok: false, error: "invalid" };
  const out: PoLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const q = wholeQty(quantities[i]);
    if (q === null) return { ok: false, error: "invalid" };
    if (q > 0) out.push({ ...lines[i]!, qty: q });
  }
  return out.length ? { ok: true, lines: out } : { ok: false, error: "empty" };
}

export type ReceiptResult = { ok: true; lines: PoLine[]; close: boolean } | { ok: false; error: "invalid" | "nothing" };

/**
 * Record a delivery: units received now per line (in order; capped at what is still to
 * arrive). The order closes when nothing is left, or when the merchant closes the rest as
 * short. Closing remembers each line's received units before this step (re-open restores them).
 */
export function applyReceipt(lines: readonly PoLine[], receivedNow: unknown, closeShort: boolean): ReceiptResult {
  if (!Array.isArray(receivedNow) || receivedNow.length !== lines.length) return { ok: false, error: "invalid" };
  let any = false;
  const next: PoLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const q = wholeQty(receivedNow[i]);
    if (q === null) return { ok: false, error: "invalid" };
    const add = Math.min(q, lineRemaining(l));
    if (add > 0) any = true;
    next.push(add > 0 ? { ...l, received: (l.received ?? 0) + add } : { ...l });
  }
  if (!any && !closeShort) return { ok: false, error: "nothing" };
  const close = closeShort || poProgress(next).remaining === 0;
  return {
    ok: true,
    close,
    lines: close ? next.map((l, i) => ({ ...l, reopenReceived: lines[i]!.received ?? 0 })) : next,
  };
}

/** A received or cancelled Keha order can be re-opened this long after it closed. */
export const REOPEN_DAYS = 30;

export type ReopenInput = {
  status: string;
  source: string;
  sentAt: Date | string | null;
  confirmedShipDate: Date | string | null;
  receivedAt: Date | string | null;
  cancelledAt: Date | string | null;
};

/** The status a closed order goes back to, or null when it can't be re-opened (any more). */
export function reopenTarget(po: ReopenInput, now: Date): PoStatus | null {
  if (po.source !== "keha") return null;
  const closedAt = po.status === "received" ? po.receivedAt : po.status === "cancelled" ? po.cancelledAt : null;
  if (!closedAt) return null;
  const age = now.getTime() - new Date(closedAt).getTime();
  if (!(age >= 0 && age <= REOPEN_DAYS * DAY_MS)) return null;
  if (!po.sentAt) return po.status === "cancelled" ? "draft" : null;
  return po.confirmedShipDate ? "confirmed" : "sent";
}

/**
 * Lines of a re-opened order: received units back to before the order closed. A received order
 * is marked `reopenedAt` (H1) so auto-receive leaves it to the merchant from now on — the stock
 * rise that closed it is still on the shelf and would close it again the next night. A cancelled
 * order isn't marked: nothing was received, so auto-receive still watches for its delivery.
 */
export function reopenedLines(lines: readonly PoLine[], fromStatus: string, now: Date = new Date()): PoLine[] {
  return lines.map((l) => {
    const { autoReceived: _a, reopenReceived, ...rest } = l;
    if (fromStatus !== "received") return rest;
    const before = reopenReceived ?? 0;
    const out: PoLine = { ...rest, received: before, reopenedAt: rest.reopenedAt ?? now.toISOString() };
    if (!before) delete out.received;
    return out;
  });
}

// ── Prices in the supplier's currency (audit 2026-10-17) ──────────────────

export type PoPricing = {
  /** The currency prices are shown in. */
  currency: string | null;
  /** Multiply a stored line cost by this to get it in `currency`. */
  factor: number;
  /** Prices were converted from the store currency with the supplier's exchange rate. */
  converted: boolean;
  /** The supplier pays in another currency and no exchange rate is set: prices stay in the store currency. */
  noRate: boolean;
};

/**
 * Which currency an order's prices are shown in. Lines are stored in `linesCurrency` (Keha
 * orders: the store currency, from Shopify's cost). With a different supplier currency and an
 * exchange rate (1 supplier unit = rate store units) prices are converted; without a rate they
 * stay in the store currency, labelled as such — never "—" for a whole order.
 */
export function poPricing(o: {
  linesCurrency: string | null;
  storeCurrency: string | null;
  supplierCurrency: string | null;
  exchangeRate: number | null;
}): PoPricing {
  const up = (c: string | null) => (c ? c.toUpperCase() : null);
  const store = up(o.storeCurrency);
  const lines = up(o.linesCurrency) ?? store;
  const supplier = up(o.supplierCurrency) ?? store;
  if (!supplier || lines === supplier) return { currency: lines, factor: 1, converted: false, noRate: false };
  if (lines === store && o.exchangeRate && o.exchangeRate > 0) {
    return { currency: supplier, factor: 1 / o.exchangeRate, converted: true, noRate: false };
  }
  return { currency: lines, factor: 1, converted: false, noRate: true };
}

/** poPricing for an order and its supplier (the order page, PDF, CSV, email, supplier page). */
export function pricingFor(order: {
  currency: string | null;
  storeCurrency: string | null;
  supplier: { currency: string | null; exchangeRate: number | null } | null;
}): PoPricing {
  return poPricing({
    linesCurrency: order.currency,
    storeCurrency: order.storeCurrency,
    supplierCurrency: order.supplier?.currency ?? null,
    exchangeRate: order.supplier?.exchangeRate ?? null,
  });
}

/** A line cost converted for display (2 decimals); null stays null. */
export function convertCost(cost: number | null | undefined, factor: number): number | null {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return null;
  return factor === 1 ? cost : Math.round(cost * factor * 100) / 100;
}

// ── Minimums on the order page (audit 2026-10-17) ─────────────────────────

export type OrderMinimums = {
  /** Units below the supplier's minimum order total. */
  total: { min: number; units: number } | null;
  /** Lines (or products, when the minimum is per product) below the minimum per item. */
  items: { min: number; count: number; perProduct: boolean } | null;
  /** Below the supplier's minimum order value (in the supplier's currency). */
  value: { min: number; amount: number; currency: string | null } | null;
  /** The supplier has a minimum order value we can't check (no exchange rate or unknown costs). */
  valueUnknown: { min: number; currency: string | null } | null;
};

export function orderMinimums(
  lines: readonly Pick<PoLine, "qty" | "unitCost" | "productTitle">[],
  supplier: {
    minOrder: number | null;
    minOrderTotal: number | null;
    minOrderValue: number | null;
    minOrderScope: string | null;
    currency: string | null;
  } | null,
  pricing: PoPricing,
  storeCurrency: string | null,
): OrderMinimums {
  const out: OrderMinimums = { total: null, items: null, value: null, valueUnknown: null };
  if (!supplier) return out;
  const live = lines.filter((l) => l.qty > 0);
  const units = live.reduce((a, l) => a + l.qty, 0);
  if (supplier.minOrderTotal && supplier.minOrderTotal > 0 && units < supplier.minOrderTotal) {
    out.total = { min: supplier.minOrderTotal, units };
  }
  if (supplier.minOrder && supplier.minOrder > 1) {
    const perProduct = supplier.minOrderScope === "product";
    const sums = new Map<string, number>();
    live.forEach((l, i) => {
      const key = perProduct ? l.productTitle || `#${i}` : `#${i}`;
      sums.set(key, (sums.get(key) ?? 0) + l.qty);
    });
    const count = [...sums.values()].filter((q) => q < supplier.minOrder!).length;
    if (count) out.items = { min: supplier.minOrder, count, perProduct };
  }
  if (supplier.minOrderValue && supplier.minOrderValue > 0) {
    const currency = (supplier.currency || storeCurrency || "").toUpperCase() || null;
    const cost = poTotals(live).cost;
    if (cost === null || (pricing.currency ?? null) !== currency) out.valueUnknown = { min: supplier.minOrderValue, currency };
    else {
      const amount = Math.round(cost * pricing.factor * 100) / 100;
      if (amount < supplier.minOrderValue) out.value = { min: supplier.minOrderValue, amount, currency };
    }
  }
  return out;
}

// ── Open orders list (audit 2026-10-17) ───────────────────────────────────

export type OpenOrderInput = {
  id: string;
  number: string;
  source: string;
  status: string;
  supplierName: string | null;
  lines: readonly PoLine[];
  currency: string | null;
  confirmedShipDate: string | null;
  /** poArrival with the supplier's transit days. */
  arrival: string | null;
  createdAt: string;
  sentAt: string | null;
};

export type OpenOrderListRow = {
  id: string;
  number: string;
  source: "keha" | "shopify";
  status: PoStatus;
  partial: boolean;
  supplierName: string | null;
  units: number;
  remaining: number;
  cost: number | null;
  currency: string | null;
  ships: string | null;
  arrival: string | null;
  /** Days since it was sent (drafts: since created). */
  ageDays: number;
  /** A draft older than DRAFT_EXPIRY_DAYS: no longer counted as ordered. */
  stale: boolean;
  /** Expected before today and not received. */
  overdue: boolean;
};

/**
 * Rows of the Open orders tab, sorted by arrival (undated last, then newest first).
 * `counts` = poCountsAsOrdered (lib/supplier-shared), passed in so this stays one rule.
 */
export function openOrderRows(
  orders: readonly OpenOrderInput[],
  opts: { now: Date; today: string; counts: (po: { status: string; createdAt: Date }, now: Date) => boolean },
): OpenOrderListRow[] {
  const rows = orders.map((o): OpenOrderListRow => {
    const p = poProgress(o.lines);
    const since = new Date(o.sentAt ?? o.createdAt).getTime();
    const status = (isPoStatus(o.status) ? o.status : "sent") as PoStatus;
    return {
      id: o.id,
      number: o.number,
      source: o.source === "shopify" ? "shopify" : "keha",
      status,
      partial: partiallyReceived({ status, lines: o.lines }),
      supplierName: o.supplierName,
      units: p.ordered,
      remaining: p.remaining,
      cost: poTotals(o.lines).cost,
      currency: o.currency,
      ships: o.confirmedShipDate,
      arrival: o.arrival,
      ageDays: Math.max(0, Math.floor((opts.now.getTime() - since) / DAY_MS)),
      stale: status === "draft" && !opts.counts({ status, createdAt: new Date(o.createdAt) }, opts.now),
      overdue: status !== "draft" && !!o.arrival && o.arrival < opts.today,
    };
  });
  return rows.sort((a, b) => {
    if (a.arrival !== b.arrival) return a.arrival === null ? 1 : b.arrival === null ? -1 : a.arrival < b.arrival ? -1 : 1;
    return a.ageDays - b.ageDays;
  });
}

// ── Labels ─────────────────────────────────────────────────────────────────

export function poStatusLabel(status: string, t: T): string {
  switch (status) {
    case "draft":
      return t("Draft");
    case "sent":
      return t("Ordered");
    case "confirmed":
      return t("Confirmed");
    case "received":
      return t("Received");
    case "cancelled":
      return t("Canceled");
    default:
      return "—";
  }
}

export function poStatusTone(status: string): "neutral" | "info" | "success" | "caution" | "critical" | "auto" {
  switch (status) {
    case "draft":
      return "neutral";
    case "sent":
      return "info";
    case "confirmed":
      return "caution";
    case "received":
      return "success";
    case "cancelled":
      return "critical";
    default:
      return "auto";
  }
}

/**
 * The status badge, with two derived labels (no status of their own): "Partially received" for an
 * ordered / confirmed order with units in, and "Closed" for a received order closed by hand with
 * units still missing (shortUnits > 0) — "Received" would say they came.
 */
export function poStatusBadge(
  o: { status: string; lines: readonly Pick<PoLine, "qty" | "received" | "autoReceived">[] },
  t: T,
): { label: string; tone: ReturnType<typeof poStatusTone> } {
  if (partiallyReceived(o)) return { label: t("Partially received"), tone: "info" };
  if (shortUnits(o) > 0) return { label: t("Closed"), tone: "neutral" };
  return { label: poStatusLabel(o.status, t), tone: poStatusTone(o.status) };
}

/** Money with cents in the order currency ("€2.50"); "—" when unknown (I-5). */
export function formatPrice(value: number | null | undefined, currency: string | null | undefined, locale: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  try {
    return currency
      ? new Intl.NumberFormat(locale, { style: "currency", currency }).format(value)
      : new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${value.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
}
