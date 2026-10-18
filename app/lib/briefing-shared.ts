/**
 * The Dashboard's 30-second report (Kanwar 2026-10-18): what's going on and what to do this
 * week, in plain sentences a merchant with no inventory background understands, then one tile per
 * job (order, sold out, clear dead stock, fix product pages) with one button each.
 *
 * Built on the server from what the Dashboard already reads — this week's orders (the forward
 * plan), the action list's counts per tab and the money snapshot — so the report never disagrees
 * with the screens below it. Numbers only; the words are chosen in the component (8 languages).
 */
import type { ActionTab } from "./actions-shared";
import type { ThisWeekView } from "./order-plan-shared";

export type BriefingTileKey = "order" | "soldOut" | "clear" | "fix";

export type BriefingTile = {
  key: BriefingTileKey;
  /** How many: suppliers to order from, products sold out / not selling / with a weak page. */
  count: number;
  /** Money behind it in the store currency: cash for this week's orders, cash tied up in dead stock; null = none shown. */
  amount: number | null;
  /** Where the button goes. */
  href: string;
};

export type BriefingSentence =
  | { key: "order"; suppliers: number; cash: number | null; late: number }
  | { key: "nothingToOrder"; nextOrderBy: string | null }
  | { key: "soldOut"; products: number }
  | { key: "clear"; products: number; cash: number | null }
  | { key: "fix"; products: number };

export type Briefing = {
  currency: string;
  /** At most 3, the order sentence first, then what matters most. */
  sentences: BriefingSentence[];
  tiles: BriefingTile[];
};

export type BriefingInput = {
  currency: string;
  /** This week's orders; null when the plan isn't ready (no report then). */
  week: Pick<ThisWeekView, "suppliers" | "totals" | "next"> | null;
  /** Action list rows per tab (Free: the Fix tab is a held-back count — pass it as fixHidden). */
  counts: Partial<Record<ActionTab, number>> | null;
  fixHidden?: number;
  /** Money snapshot: cash tied up in stock that isn't selling. */
  cashStuck: number | null;
};

/** Action-list tab links (the list reads ?tab= and the page scrolls to it). */
export const actionTabHref = (tab: Exclude<ActionTab, "all">) => `/app?tab=${tab}#actions`;

export const MAX_SENTENCES = 3;

export function buildBriefing(input: BriefingInput): Briefing | null {
  if (!input.week) return null;
  const c = input.counts ?? {};
  const soldOut = c.bridge ?? 0;
  const clear = c.clear ?? 0;
  const fix = (c.fix ?? 0) + (input.fixHidden ?? 0);
  const suppliers = input.week.suppliers.length;
  const late = input.week.suppliers.filter((s) => s.late).length;
  const cash = input.week.totals.cash;
  const cashStuck = clear > 0 && input.cashStuck !== null && input.cashStuck > 0 ? input.cashStuck : null;

  const sentences: BriefingSentence[] = [
    suppliers > 0 ? { key: "order", suppliers, cash, late } : { key: "nothingToOrder", nextOrderBy: input.week.next?.orderBy ?? null },
  ];
  // Then what loses money soonest: sold-out best sellers (sales lost every day), dead stock (cash
  // tied up), weak product pages.
  if (soldOut > 0) sentences.push({ key: "soldOut", products: soldOut });
  if (clear > 0) sentences.push({ key: "clear", products: clear, cash: cashStuck });
  if (fix > 0) sentences.push({ key: "fix", products: fix });

  return {
    currency: input.currency,
    sentences: sentences.slice(0, MAX_SENTENCES),
    tiles: [
      { key: "order", count: suppliers, amount: suppliers > 0 ? cash : null, href: "/app/reorder" },
      { key: "soldOut", count: soldOut, amount: null, href: actionTabHref("bridge") },
      { key: "clear", count: clear, amount: cashStuck, href: actionTabHref("clear") },
      { key: "fix", count: fix, amount: null, href: actionTabHref("fix") },
    ],
  };
}
