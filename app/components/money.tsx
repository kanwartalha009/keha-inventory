/**
 * One money-at-stake figure with its "How we got this" popover (Dashboard: sales at risk and cash
 * tied up; Actions page: lost sales and sold-out page visits — clarity pass 2026-10-23).
 */
import { useLocale } from "../lib/i18n";
import type { MoneyCardKey, MoneySnapshot } from "../lib/money-shared";
import { basisLines, formatAmount, formatCount, formatDay, formatPercent, moneyCardTitle, type Fmt } from "../lib/dashboard-shared";

export function useFmt(currency: string): Fmt {
  const { locale } = useLocale();
  return {
    money: (v) => formatAmount(v, currency, locale),
    count: (v) => formatCount(v, locale),
    percent: (v) => formatPercent(v, locale),
    day: (v) => formatDay(v, locale),
  };
}

export function MoneyFigure({ cardKey, money, fmt }: { cardKey: MoneyCardKey; money: MoneySnapshot | null; fmt: Fmt }) {
  const { t } = useLocale();
  const value = money?.values[cardKey] ?? null;
  const lines = basisLines(cardKey, money?.basis ?? null, t, fmt);
  const title = moneyCardTitle(cardKey, t);
  const popId = `keha-how-${cardKey}`;
  return (
    <s-stack direction="block" gap="small-100">
      <s-text color="subdued">{title}</s-text>
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <span className="keha-money__figure">{fmt.money(value)}</span>
        <s-button variant="tertiary" icon="info" commandFor={popId} accessibilityLabel={`${t("How we got this")}: ${title}`} />
      </s-stack>
      {value === null && <s-text color="subdued">{t("Not enough sales yet to advise")}</s-text>}
      <s-popover id={popId}>
        <s-box padding="base" maxInlineSize="360px">
          <s-stack direction="block" gap="small-200">
            <s-heading>{title}</s-heading>
            {lines.length > 0 ? (
              lines.map((l, i) => (
                <s-text key={i} color={i === lines.length - 1 ? "subdued" : "base"}>
                  {l}
                </s-text>
              ))
            ) : (
              <s-text color="subdued">{t("The details appear after the next calculation.")}</s-text>
            )}
          </s-stack>
        </s-box>
      </s-popover>
    </s-stack>
  );
}
