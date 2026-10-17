/**
 * Keha orders that changed since the nightly run (H2, review 2026-10-17). Pure, client-safe.
 *
 * Compute counts the remaining units of sent / confirmed Keha orders as incoming
 * (inputs.kehaOnOrder, the dated part in inputs.arrivals; since H2 also each order's share,
 * inputs.kehaOrders). The order plan reads that row until the next night, so between runs it has
 * to correct it with what the merchant did since:
 *  - units ADDED since the run (fresh drafts, orders sent since, a re-opened order) arrive after
 *    one lead time (`notCounted`, as before);
 *  - units REMOVED since the run — an order closed short (received with units missing), cancelled
 *    or deleted — will never arrive: they come out of the projection's incoming at once
 *    (`removed`, on that order's arrival day), so Dashboard, Order now, Products, Sidekick and the
 *    Monday email order them today, not tomorrow.
 *  - units RECEIVED by hand since the run are neither: they moved from the supplier to the shelf.
 *    The stored on-hand is last night's, so they stay counted as incoming (the position is right;
 *    only their day is early) until the next run reads the new on-hand.
 * Units compute already estimated as landed (the stock rose; inputs.kehaLanded) are never taken
 * out twice: a cut is capped at the order's units still counted as incoming.
 */
import type { DayKey } from "./engine/dates-shared";
import type { KehaOrderShare } from "./compute-shared";

/** One Keha order's state now for one variant. */
export type KehaOrderNow = {
  /** Still counts as ordered (poCountsAsOrdered: sent / confirmed, drafts under 14 days). */
  counts: boolean;
  /** Sent / confirmed (compute only counts these). */
  sent: boolean;
  /** Units of this variant still to arrive (ordered − received); for a closed order: what was left when it closed. */
  remaining: number;
  /** Sent before the metric's run and received / cancelled after it (the legacy path only). */
  closedSinceRun: boolean;
};

/** Units to take out of a variant's incoming: on `day` (an arrival), else the latest arrivals first. */
export type IncomingCut = { day: DayKey | null; units: number };

export type KehaSinceRun = { notCounted: number; removed: IncomingCut[] };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pos = (v: unknown) => (finite(v) && v > 0 ? v : 0);

/** inputs.kehaOrders read defensively; null = a row written before H2 (the legacy path). */
export function readKehaShares(inputs: unknown): KehaOrderShare[] | null {
  const raw = inputs && typeof inputs === "object" ? (inputs as Record<string, unknown>).kehaOrders : undefined;
  if (!Array.isArray(raw)) return null;
  const out: KehaOrderShare[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    if (typeof x.po !== "string" || !finite(x.open) || !finite(x.units)) continue;
    out.push({ po: x.po, open: pos(x.open), units: pos(x.units), day: typeof x.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.day) ? x.day : null });
  }
  return out;
}

/**
 * What changed for one variant since its metric's run (see the module header).
 * `orders`: every Keha order of this variant that still counts, plus those closed (received /
 * cancelled) since the run, by id; an id in `kehaOrders` that is missing was deleted.
 */
export function kehaSinceRun(inputs: unknown, orders: ReadonlyMap<string, KehaOrderNow>): KehaSinceRun {
  const shares = readKehaShares(inputs);
  const rec = inputs && typeof inputs === "object" ? (inputs as Record<string, unknown>) : {};
  if (shares === null) return legacySinceRun(pos(rec.kehaOnOrder), pos(rec.kehaLanded), orders);
  const known = new Set(shares.map((s) => s.po));
  let added = 0;
  for (const [id, o] of orders) if (o.counts && !known.has(id)) added += o.remaining;
  const removed: IncomingCut[] = [];
  for (const s of shares) {
    const o = orders.get(s.po);
    if (o?.counts) {
      // Still open: received units moved to the shelf; more units than counted = re-opened in part.
      added += Math.max(0, o.remaining - s.open);
      continue;
    }
    // Closed (what was left at closing never comes) or deleted (none of it comes).
    const gone = o ? Math.min(s.open, o.remaining) : s.open;
    const receivedSince = s.open - gone; // closed: received since the run; deleted: 0
    // Units received beyond the landed estimate came out of the incoming part; they stay counted.
    const fromIncoming = Math.max(0, receivedSince - Math.max(0, s.open - s.units));
    const cut = Math.min(gone, Math.max(0, s.units - fromIncoming));
    if (cut > 0) removed.push({ day: s.day, units: cut });
  }
  return { notCounted: added, removed };
}

/**
 * Rows written before H2 (no per-order shares): the drop in sent / confirmed Keha units since the
 * run, but only as far as orders closed since the run explain it (a hand receipt is not a drop),
 * capped at the Keha units still counted as incoming; taken from the latest arrivals first.
 */
function legacySinceRun(counted: number, landed: number, orders: ReadonlyMap<string, KehaOrderNow>): KehaSinceRun {
  let current = 0;
  let currentSent = 0;
  let closed = 0;
  for (const o of orders.values()) {
    if (o.counts) {
      current += o.remaining;
      if (o.sent) currentSent += o.remaining;
    } else if (o.closedSinceRun) closed += o.remaining;
  }
  const drop = Math.min(Math.max(0, counted - currentSent), closed);
  const cut = Math.min(drop, Math.max(0, counted - landed));
  return { notCounted: Math.max(0, current - counted + drop), removed: cut > 0 ? [{ day: null, units: cut }] : [] };
}
