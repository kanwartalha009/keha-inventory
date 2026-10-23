/**
 * "This week" (lib/briefing-shared): the plain sentences that lead the Dashboard's This week card.
 * Clarity pass (2026-10-23): the four tiles are gone — they repeated the sentences and the order
 * table ("order" said three times); the counts per status live in "Your stock today". Words only
 * here; the numbers come from the server.
 */
import type { Briefing, BriefingSentence } from "../lib/briefing-shared";
import { fill, plural, useLocale } from "../lib/i18n";
import { formatAmount, formatCount, formatDay } from "../lib/dashboard-shared";

/** The plain sentences only (clarity pass 2026-10-23: they lead the Dashboard's "This week" card; the tiles are gone). */
export function BriefingSentences({ briefing }: { briefing: Briefing }) {
  const sentence = useSentence(briefing);
  return (
    <s-stack direction="block" gap="small-200">
      {briefing.sentences.map((s) => (
        <s-paragraph key={s.key}>{sentence(s)}</s-paragraph>
      ))}
    </s-stack>
  );
}

function useSentence(briefing: Briefing): (s: BriefingSentence) => string {
  const { t, locale } = useLocale();
  const money = (v: number | null) => formatAmount(v, briefing.currency, locale);
  const n = (v: number) => formatCount(v, locale);
  return (s: BriefingSentence): string => {
    switch (s.key) {
      case "order": {
        const head =
          s.cash !== null
            ? fill(plural(s.suppliers, t("Order from 1 supplier this week ({cash})."), t("Order from {n} suppliers this week ({cash}).")), { n: n(s.suppliers), cash: money(s.cash) })
            : fill(plural(s.suppliers, t("Order from 1 supplier this week."), t("Order from {n} suppliers this week.")), { n: n(s.suppliers) });
        return s.late > 0 ? `${head} ${fill(plural(s.late, t("1 of them can't wait: something runs out before a new order could arrive."), t("{n} of them can't wait: something runs out before a new order could arrive.")), { n: n(s.late) })}` : head;
      }
      case "nothingToOrder":
        return s.nextOrderBy
          ? fill(t("Nothing to order this week. Your next order is due {date}."), { date: formatDay(s.nextOrderBy, locale) })
          : t("Nothing to order this week.");
      case "soldOut":
        return fill(
          plural(
            s.products,
            t("1 product is sold out while shoppers still look for it: reorder it or take preorders."),
            t("{n} products are sold out while shoppers still look for them: reorder them or take preorders."),
          ),
          { n: n(s.products) },
        );
      case "clear":
        return s.cash !== null
          ? fill(
              plural(
                s.products,
                t("1 product isn't selling and ties up {cash}. A discount turns it back into cash."),
                t("{n} products aren't selling and tie up {cash}. A discount turns that back into cash."),
              ),
              { n: n(s.products), cash: money(s.cash) },
            )
          : fill(plural(s.products, t("1 product isn't selling. A discount clears it."), t("{n} products aren't selling. A discount clears them.")), { n: n(s.products) });
      case "fix":
        return fill(plural(s.products, t("1 product page gets visitors but few sales."), t("{n} product pages get visitors but few sales.")), { n: n(s.products) });
    }
  };
}
