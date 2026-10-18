/**
 * The action list contract (spec §5.1, §7.7). Pure, client-safe.
 *
 * The engine (compute) produces ActionDrafts; compute persists them as Action
 * rows, one per (kind, product) via `dedupeKey`; Home and the Monday email read
 * them. Every visible sentence is an English template key from ACTION_REASONS,
 * filled with `reason.params` and translated in the UI (tests/i18n-coverage).
 */

export const ACTION_KINDS = [
  "reorder",
  "bridge",
  "push",
  "fix_falling",
  "fix_sizes",
  "fix_page",
  "fix_returns",
  "clear",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Home tabs (spec §5.1): All · Reorder · Sold out (kind "bridge") · Promote (kind "push") · Fix · Clear. */
export const ACTION_TABS = ["all", "reorder", "bridge", "push", "fix", "clear"] as const;
export type ActionTab = (typeof ACTION_TABS)[number];

export function tabOf(kind: ActionKind): Exclude<ActionTab, "all"> {
  return kind.startsWith("fix_") ? "fix" : (kind as Exclude<ActionTab, "all" | "fix">);
}

export const ACTION_STATES = ["open", "snoozed", "dismissed", "done"] as const;
export type ActionState = (typeof ACTION_STATES)[number];

/** Days a snooze lasts (spec §5.1 "snooze 7 days"). */
export const SNOOZE_DAYS = 7;

/**
 * A "done" action (e.g. a clearance discount created) that still triggers this
 * many days later opens again — the default clearance discount lasts 30 days.
 * The spec doesn't say when done items return; without this they never would,
 * because there is one row per (kind, product).
 */
export const DONE_REOPEN_DAYS = 30;

/**
 * English sentence templates for `reason.key` ({placeholders} filled from
 * `reason.params`). Owned by the engine task (2.1/2.4); every value here is a
 * translation key (registered in tests/i18n-coverage.test.ts).
 */
export const ACTION_REASONS: Record<string, string> = {
  // Params: {days} {lead} whole days; {date} an ISO day "YYYY-MM-DD" shown as "12 Nov";
  // {rate} units per day (1 decimal); {pct} {conv} {median} percentages; {gap} {out} {total} {units} counts.
  reorder_low: "Runs out in {days} days; a new order takes {lead} days to arrive. Order by {date}.",
  reorder_now: "Runs out in {days} days; a new order takes {lead} days to arrive. Order now.",
  reorder_out: "Out of stock. It sells {rate} a day while in stock.",
  bridge_gap: "Runs out {gap} days before new stock arrives on {date}.",
  bridge_out: "Out of stock for about {gap} more days, until new stock arrives on {date}.",
  push_up: "Sales are up {pct}% on last year and it has enough stock. Feature it to sell more.",
  push_steady: "One of your best sellers, with enough stock. Feature it to sell more.",
  push_converts: "{conv}% of visitors buy it (store median {median}%), but it is overstocked. Send it more traffic.",
  fix_falling: "Sales are down {pct}% on the same weeks last year, when it was one of your top 20 products.",
  fix_sizes: "{out} of {total} variants are out of stock while the product still sells.",
  fix_page: "{conv}% of visitors who land on this page buy, against {median}% for products at a similar price.",
  fix_returns: "{pct}% of units sold come back, against {median}% across your store.",
  clear_dead: "No sale for {days} days; {units} units are sitting in stock.",
  clear_too_much: "{days} days of stock left at the current pace, far more than you need.",
  clear_no_sales: "No recent sales, and the stock isn't moving.",
  // Singular / today forms (merchant audit 2026-10-18: "Runs out in 1 days"); picked by reasonTemplate.
  "reorder_low.today": "Runs out today; a new order takes {lead} days to arrive. Order by {date}.",
  "reorder_low.one": "Runs out in 1 day; a new order takes {lead} days to arrive. Order by {date}.",
  "reorder_now.today": "Runs out today; a new order takes {lead} days to arrive. Order now.",
  "reorder_now.one": "Runs out in 1 day; a new order takes {lead} days to arrive. Order now.",
  "bridge_gap.one": "Runs out 1 day before new stock arrives on {date}.",
  "bridge_out.one": "Out of stock for about 1 more day, until new stock arrives on {date}.",
};

/** Which param a reason's singular form depends on. */
const COUNT_PARAM: Record<string, string> = { reorder_low: "days", reorder_now: "days", bridge_gap: "gap", bridge_out: "gap" };

/**
 * The English template for a reason: its "today" form for 0 days, its singular form for 1 (each
 * a key of ACTION_REASONS), else the plain one; an unknown key is returned as is.
 */
export function reasonTemplate(key: string, params: ReasonParams | null | undefined): string {
  const p = COUNT_PARAM[key];
  const n = p && params ? Number(params[p]) : NaN;
  if (n === 0 && ACTION_REASONS[`${key}.today`]) return ACTION_REASONS[`${key}.today`]!;
  if (n === 1 && ACTION_REASONS[`${key}.one`]) return ACTION_REASONS[`${key}.one`]!;
  return ACTION_REASONS[key] ?? key;
}

export type ReasonParams = Record<string, string | number>;

/** What the engine hands to compute for one action. */
export interface ActionDraft {
  kind: ActionKind;
  productId: string;
  variantIds: string[];
  /** The € figure in the store currency (≥ 0). Ranking uses it. */
  amount: number;
  /** A key of ACTION_REASONS plus its params; `facts` are the popover inputs ("Based on: …"). */
  reason: { key: string; params: ReasonParams; facts?: Record<string, string | number | null> };
}

/** One (kind, product) → one row. */
export function dedupeKey(kind: ActionKind, productId: string): string {
  return `${kind}:${productId}`;
}

/**
 * Spec §7.7: snoozed or dismissed items come back only if their € figure
 * doubles. A snooze also ends when its date passes.
 */
export function isVisible(
  row: { state: ActionState; amount: number; stateAmount: number | null; snoozeUntil: Date | null },
  now: Date,
): boolean {
  if (row.state === "open") return true;
  if (row.state === "done") return false;
  const doubled = row.stateAmount != null && row.stateAmount > 0 && row.amount >= 2 * row.stateAmount;
  if (doubled) return true;
  if (row.state === "snoozed") return row.snoozeUntil != null && row.snoozeUntil.getTime() <= now.getTime();
  return false;
}

/** Sort by € desc, ties by kind order then product id (stable across runs). */
export function rankActions<T extends { kind: ActionKind; amount: number; productId: string }>(rows: T[]): T[] {
  const order = new Map(ACTION_KINDS.map((k, i) => [k, i]));
  return [...rows].sort(
    (a, b) =>
      b.amount - a.amount ||
      (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0) ||
      (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
  );
}

/** Rows for one tab, ranked (spec §7.7: by € inside each group; All: by € across groups). */
export function rowsForTab<T extends { kind: ActionKind; amount: number; productId: string }>(rows: T[], tab: ActionTab): T[] {
  return rankActions(tab === "all" ? rows : rows.filter((r) => tabOf(r.kind) === tab));
}
