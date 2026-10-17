/**
 * What a purchase order tells the supplier besides its lines (merchant audit 2026-10-18): the
 * language it is written in, who buys (the store's legal name and address), where the goods go
 * (a Shopify location), the payment terms, the delivery terms (Incoterms), the expected ship and
 * arrival dates and the merchant's note. Pure, client-safe; the database / Shopify part is
 * services/po-document.server.ts.
 *
 * One list of detail rows (`poDetailRows`) feeds the PDF, the CSV preamble and the email, so the
 * three always say the same. Freight & duty is never on it (the store's own cost).
 */
import { LOCALES, LOCALE_NAMES, type Locale } from "./i18n";
import { termsText, type PaymentTerms } from "./cash-shared";
import { csvLine } from "./products-shared";
import { addDays, type DayKey } from "./engine/dates-shared";

type T = (s: string) => string;

// ── PO language ─────────────────────────────────────────────────────────────

/** Suppliers' documents default to English: most suppliers abroad read it, whatever the store's language. */
export const DEFAULT_PO_LANGUAGE: Locale = "en";

/** The stored column (Supplier.poLanguage) as a language; unknown / null = English. */
export function readPoLanguage(v: unknown): Locale {
  return typeof v === "string" && (LOCALES as string[]).includes(v) ? (v as Locale) : DEFAULT_PO_LANGUAGE;
}

/** A CSV cell: a code ("de") or the language's own name ("Deutsch"), any case; empty = English; null = not one. */
export function parsePoLanguage(cell: string): Locale | null {
  const c = cell.trim().toLowerCase();
  if (!c) return DEFAULT_PO_LANGUAGE;
  for (const l of LOCALES) if (l === c || LOCALE_NAMES[l].toLowerCase() === c) return l;
  return null;
}

// ── Incoterms ───────────────────────────────────────────────────────────────

/** Incoterms 2020. */
export const INCOTERMS = ["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"] as const;
export const INCOTERMS_MAX = 60;

/**
 * "fob  ningbo" → "FOB ningbo": a known Incoterm, optionally followed by the named place. Empty =
 * none (ok, null); anything else is refused (ok false).
 */
export function readIncoterms(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const x = raw.trim().replace(/\s+/g, " ");
  if (!x) return { ok: true, value: null };
  if (x.length > INCOTERMS_MAX) return { ok: false };
  const [code, ...place] = x.split(" ");
  const up = code!.toUpperCase();
  if (!(INCOTERMS as readonly string[]).includes(up)) return { ok: false };
  return { ok: true, value: [up, ...place].join(" ") };
}

// ── The merchant's note ─────────────────────────────────────────────────────

export const PO_NOTE_MAX = 1000;

/** The note as stored: trimmed, line breaks kept, ≤ 1000 characters; empty = none; null when too long or not text. */
export function readPoNote(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const x = raw.replace(/\r\n?/g, "\n").trim();
  if (!x) return { ok: true, value: null };
  return x.length > PO_NOTE_MAX ? { ok: false } : { ok: true, value: x };
}

// ── Ship-to ─────────────────────────────────────────────────────────────────

export type ShipToLocation = { id: string; name: string; active: boolean; role?: string | null; online?: boolean | null };

/**
 * Where an order's goods go when the merchant didn't pick: the location the plan was for (a
 * location view), else the store's main warehouse — the first active warehouse, else the first
 * active location that fulfils online orders, else the first active one (by name). null = none.
 */
export function defaultShipTo(locations: readonly ShipToLocation[], scope?: string | null): string | null {
  const active = locations.filter((l) => l.active).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  if (scope && active.some((l) => l.id === scope)) return scope;
  return (active.find((l) => l.role === "warehouse") ?? active.find((l) => l.online) ?? active[0])?.id ?? null;
}

/** The ship-to id the browser sent, kept only when it is one of the store's active locations. */
export function readShipTo(raw: unknown, locations: readonly ShipToLocation[]): string | null {
  return typeof raw === "string" && locations.some((l) => l.active && l.id === raw) ? raw : null;
}

// ── Dates ───────────────────────────────────────────────────────────────────

/**
 * The dates on the document: the arrival (confirmed ship date + transit, else the lead-time
 * estimate; a draft: today + lead time, as if sent today), the ship date (the confirmed one, else
 * arrival − transit, never before the order day).
 */
export function poDates(o: {
  status: string;
  /** poArrival: confirmed ship + transit, else the estimate stamped when sent. */
  arrival: DayKey | null;
  confirmedShipDate: DayKey | null;
  /** The day it was sent (or today for a draft). */
  orderDay: DayKey;
  leadTimeDays: number | null;
  transitDays: number | null;
}): { ship: DayKey | null; shipConfirmed: boolean; arrival: DayKey | null } {
  const arrival = o.arrival ?? (o.status === "draft" && o.leadTimeDays !== null ? addDays(o.orderDay, Math.max(0, Math.round(o.leadTimeDays))) : null);
  if (o.confirmedShipDate) return { ship: o.confirmedShipDate, shipConfirmed: true, arrival };
  if (!arrival) return { ship: null, shipConfirmed: false, arrival };
  const transit = o.transitDays && o.transitDays > 0 ? Math.floor(o.transitDays) : 0;
  const ship = addDays(arrival, -transit);
  return { ship: ship < o.orderDay ? o.orderDay : ship, shipConfirmed: false, arrival };
}

// ── The detail rows ─────────────────────────────────────────────────────────

/** A party on the order: its name and address lines. */
export type PoParty = { name: string; lines: string[] };

export type PoDetails = {
  /** The store: legal name (Shopify's company name, else the store name) and address. */
  buyer: PoParty | null;
  /** The location the goods go to, with its address. */
  shipTo: PoParty | null;
  /** The supplier's payment terms (null = none set: not printed). */
  terms: PaymentTerms | null;
  incoterms: string | null;
  shipDate: DayKey | null;
  shipConfirmed: boolean;
  arrival: DayKey | null;
  note: string | null;
};

export type PoDetailRow = { label: string; lines: string[] };

/** The rows every document prints, in this order; missing ones are left out (never "—" rows to a supplier). */
export function poDetailRows(d: PoDetails, tr: T, day: (d: DayKey) => string): PoDetailRow[] {
  const out: PoDetailRow[] = [];
  const party = (p: PoParty) => [p.name, ...p.lines].map((x) => x.trim()).filter((x, i, all) => x && all.indexOf(x) === i);
  if (d.buyer) out.push({ label: tr("Buyer"), lines: party(d.buyer) });
  if (d.shipTo) out.push({ label: tr("Ship to"), lines: party(d.shipTo) });
  if (d.terms) out.push({ label: tr("Payment terms"), lines: [termsText(d.terms, tr)] });
  if (d.incoterms) out.push({ label: tr("Delivery terms (Incoterms)"), lines: [d.incoterms] });
  if (d.shipDate) out.push({ label: d.shipConfirmed ? tr("Ship date confirmed by the supplier") : tr("Expected ship date"), lines: [day(d.shipDate)] });
  if (d.arrival) out.push({ label: tr("Expected arrival"), lines: [day(d.arrival)] });
  if (d.note) out.push({ label: tr("Note"), lines: d.note.split("\n").map((x) => x.trim()).filter(Boolean) });
  return out.filter((r) => r.lines.length > 0);
}

/** "Label: line 1, line 2" (email, one line per row). */
export function detailText(r: PoDetailRow): string {
  return `${r.label}: ${r.lines.join(", ")}`;
}

/** The CSV with the detail rows above it (label, value), then a blank line, then the table. */
export function withDetailRows(csv: string, rows: readonly PoDetailRow[]): string {
  if (!rows.length) return csv;
  const head = rows.map((r) => csvLine([r.label, r.lines.join(", ")])).join("\r\n");
  return `﻿${head}\r\n\r\n${csv.replace(/^﻿/, "")}`;
}
