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

/** Home tabs (spec §5.1): All · Reorder · Bridge · Push · Fix · Clear. */
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
 * English sentence templates for `reason.key` ({placeholders} filled from
 * `reason.params`). Owned by the engine task (2.1/2.4); every value here is a
 * translation key (registered in tests/i18n-coverage.test.ts).
 */
export const ACTION_REASONS: Record<string, string> = {};

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
