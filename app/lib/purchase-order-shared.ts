/**
 * Keha purchase orders (spec §5.3, J3, §14): numbers, status changes, dates,
 * the CSV, the confirm-link rules and auto-receive. Pure, client-safe.
 *
 * Status flow: draft → sent → confirmed → received; draft / sent / confirmed
 * can be cancelled. Orders read from Shopify (source "shopify") are
 * read-only here: Shopify is their source of truth.
 */
import { toCsv } from "./products-shared";
import type { PoLine } from "./supplier-shared";

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

/** When an order is sent: expected arrival (sent + lead time, a calendar day) and the confirm-link expiry. */
export function sentDates(sentAt: Date, leadTimeDays: number): { expectedDate: string; confirmExpiresAt: Date } {
  const lead = Number.isFinite(leadTimeDays) && leadTimeDays > 0 ? Math.floor(leadTimeDays) : 0;
  return {
    expectedDate: dayOf(new Date(sentAt.getTime() + lead * DAY_MS)),
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

/** "Default Title" is Shopify's name for a product's only variant. */
export const lineVariant = (title: string) => (title && title !== "Default Title" ? title : "");

const money2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

/**
 * The order as CSV (headers in the store / admin language). Unit cost and
 * line total are left out when the supplier sees no prices.
 */
export function poCsv(lines: readonly PoLine[], t: T, opts: { hidePrices: boolean; currency: string | null }): string {
  const header = [t("SKU"), t("Product"), t("Variant"), t("Quantity")];
  if (!opts.hidePrices) header.push(t("Unit cost"), t("Line total"), t("Currency"));
  const rows = lines.map((l) => {
    const row: (string | number | null)[] = [l.sku, l.productTitle, lineVariant(l.variantTitle), l.qty];
    if (!opts.hidePrices) row.push(money2(l.unitCost), l.unitCost === null ? null : money2(l.unitCost * l.qty), opts.currency);
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

export type AutoReceiveInput = {
  status: string;
  source: string;
  /** Expected arrival (supplier-confirmed date, else lead-time estimate), "YYYY-MM-DD". */
  arrival: string | null;
  today: string;
  lines: readonly Pick<PoLine, "variantId" | "qty" | "baseOnHand">[];
  /** On-hand (online pool) per variant when the order was sent, for lines without baseOnHand (StockDaily). */
  baseline: ReadonlyMap<string, number>;
  /** On-hand (online pool) now. */
  onHand: ReadonlyMap<string, number>;
  /** Units sold (online pool) since the order was sent. */
  soldSince: ReadonlyMap<string, number>;
};

export type AutoReceiveResult =
  | { receive: true; share: number; received: Record<string, number> }
  | { receive: false; reason: "status" | "not_due" | "no_baseline" | "not_landed"; share: number | null };

/**
 * Close a sent / confirmed Keha order when its stock has landed (J3): on or
 * after the arrival date, and the units that arrived since the order was sent
 * reach ≥ 90 % of the ordered units. Arrived per line = on-hand now − on-hand
 * when sent + units sold since (sales would otherwise hide a delivery),
 * capped at 0…ordered. A line without a baseline means we can't tell: the
 * order stays open (the merchant can mark it received).
 */
export function autoReceiveDecision(input: AutoReceiveInput): AutoReceiveResult {
  if (input.source !== "keha" || (input.status !== "sent" && input.status !== "confirmed")) {
    return { receive: false, reason: "status", share: null };
  }
  if (!input.arrival || input.today < input.arrival) return { receive: false, reason: "not_due", share: null };
  let ordered = 0;
  let arrived = 0;
  const received: Record<string, number> = {};
  for (const l of input.lines) {
    if (!(l.qty > 0)) continue;
    const base = l.baseOnHand ?? input.baseline.get(l.variantId);
    const now = input.onHand.get(l.variantId);
    if (base === undefined || now === undefined) return { receive: false, reason: "no_baseline", share: null };
    const got = Math.min(l.qty, Math.max(0, now - base + (input.soldSince.get(l.variantId) ?? 0)));
    ordered += l.qty;
    arrived += got;
    received[l.variantId] = (received[l.variantId] ?? 0) + got;
  }
  if (ordered === 0) return { receive: false, reason: "not_landed", share: null };
  const share = arrived / ordered;
  return share >= AUTO_RECEIVE_SHARE - 1e-9
    ? { receive: true, share, received }
    : { receive: false, reason: "not_landed", share };
}

// ── Labels ─────────────────────────────────────────────────────────────────

export function poStatusLabel(status: string, t: T): string {
  switch (status) {
    case "draft":
      return t("Draft");
    case "sent":
      return t("Sent");
    case "confirmed":
      return t("Confirmed");
    case "received":
      return t("Received");
    case "cancelled":
      return t("Cancelled");
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
