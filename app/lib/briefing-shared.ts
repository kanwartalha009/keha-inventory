/**
 * The Dashboard's 30-second report (Kanwar 2026-10-18): what's going on and what to do this
 * week, in plain sentences a merchant with no inventory background understands. (The four tiles
 * went in the clarity pass, 2026-10-23: they repeated the sentences; the counts per status word
 * are "Your stock today", the jobs are the actions below.)
 *
 * Built on the server from what the Dashboard already reads — this week's orders (the forward
 * plan), the action list's counts per tab and the money snapshot — so the report never disagrees
 * with the screens below it. Numbers only; the words are chosen in the component (8 languages).
 */
import type { ActionTab } from "./actions-shared";
import type { ThisWeekView } from "./order-plan-shared";

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

/**
 * Action-list tab links: the Actions page opens on that tab. (Until 0286 they pointed at the
 * Dashboard's list with #actions, which never scrolled inside the admin iframe — live 2026-10-20.)
 */
export const actionTabHref = (tab: Exclude<ActionTab, "all">) => `/app/actions?tab=${tab}`;

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
  };
}
