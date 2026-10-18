/**
 * "This week in 30 seconds" (lib/briefing-shared): plain sentences, then one tile per job with
 * one button. Words only here; the numbers come from the server.
 */
import type { Briefing, BriefingSentence, BriefingTile } from "../lib/briefing-shared";
import { fill, plural, useLocale } from "../lib/i18n";
import { formatAmount, formatCount, formatDay } from "../lib/dashboard-shared";
import { useLinkProps } from "./wc";

export function BriefingCard({ briefing }: { briefing: Briefing }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const money = (v: number | null) => formatAmount(v, briefing.currency, locale);
  const n = (v: number) => formatCount(v, locale);

  const sentence = (s: BriefingSentence): string => {
    switch (s.key) {
      case "order": {
        const head =
          s.cash !== null
            ? fill(plural(s.suppliers, t("Order from 1 supplier this week ({cash})."), t("Order from {n} suppliers this week ({cash}).")), { n: n(s.suppliers), cash: money(s.cash) })
            : fill(plural(s.suppliers, t("Order from 1 supplier this week."), t("Order from {n} suppliers this week.")), { n: n(s.suppliers) });
        return s.late > 0 ? `${head} ${fill(plural(s.late, t("1 order is already late."), t("{n} orders are already late.")), { n: n(s.late) })}` : head;
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

  const tile = (x: BriefingTile) => {
    const copy = {
      order: {
        title: t("Order"),
        value: fill(plural(x.count, t("1 supplier"), t("{n} suppliers")), { n: n(x.count) }),
        // Suppliers due but no cost price on any line: say it is due, never "Nothing due" (audit 2026-10-18).
        line: x.amount !== null ? fill(t("{cash} this week"), { cash: money(x.amount) }) : x.count > 0 ? t("Due this week") : t("Nothing due this week"),
        button: t("See orders"),
      },
      soldOut: {
        title: t("Sold out"),
        value: fill(plural(x.count, t("1 product"), t("{n} products")), { n: n(x.count) }),
        line: t("Shoppers still visit"),
        button: t("Reorder or preorder"),
      },
      clear: {
        title: t("Not selling"),
        value: fill(plural(x.count, t("1 product"), t("{n} products")), { n: n(x.count) }),
        line: x.amount !== null ? fill(t("{cash} tied up"), { cash: money(x.amount) }) : t("Stock that doesn't move"),
        button: t("Create discounts"),
      },
      fix: {
        title: t("Product pages"),
        value: fill(plural(x.count, t("1 product"), t("{n} products")), { n: n(x.count) }),
        line: t("Visitors but few sales"),
        button: t("See pages"),
      },
    }[x.key];
    return (
      <s-box key={x.key} padding="base" borderWidth="base" borderRadius="base" background={x.count > 0 ? "base" : "subdued"}>
        <s-stack direction="block" gap="small-200">
          <s-text color="subdued">{copy.title}</s-text>
          <s-heading>{x.count > 0 ? copy.value : t("All clear")}</s-heading>
          <s-text color="subdued">{x.count > 0 ? copy.line : t("Nothing to do here this week")}</s-text>
          {x.count > 0 && (
            <s-button variant={x.key === "order" ? "primary" : "secondary"} {...link(x.href)}>
              {copy.button}
            </s-button>
          )}
        </s-stack>
      </s-box>
    );
  };

  return (
    <s-section heading={t("This week in 30 seconds")}>
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-200">
          {briefing.sentences.map((s) => (
            <s-paragraph key={s.key}>{sentence(s)}</s-paragraph>
          ))}
        </s-stack>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
          {briefing.tiles.map(tile)}
        </s-grid>
      </s-stack>
    </s-section>
  );
}
