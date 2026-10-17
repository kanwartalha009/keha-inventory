/**
 * Order plan UI pieces shared by the Dashboard and the Order plan tabs: the weekly cash strip,
 * the Free plan's read-only preview and the teaching lock (plan locks teach, they don't hide).
 */
import { fill, useLocale } from "../lib/i18n";
import { formatAmount, formatCount, formatDay } from "../lib/dashboard-shared";
import { variantName } from "../lib/products-shared";
import { cashBars } from "../lib/planner-shared";
import type { PlanWeek } from "../lib/engine/forward-plan-shared";
import { formatWeekRange, type OrderPlanData, type PreviewRow } from "../lib/order-plan-shared";
import { featureCopy, planTag } from "./plan";
import { useLinkProps } from "./wc";
import type { Feature } from "../lib/plan-shared";

const STRIP_W = 640;
const STRIP_H = 120;

/** Bars of cash needed per week (unknown costs are not drawn as 0: the total says how many). */
export function CashStrip({ weeks, currency, compact }: { weeks: PlanWeek[]; currency: string; compact?: boolean }) {
  const { t, locale } = useLocale();
  const money = (v: number | null) => formatAmount(v, currency, locale);
  const bars = cashBars(
    weeks.map((w) => ({ weekStart: w.weekStart, week: w.week, amount: w.cash ?? 0, lines: w.lines, retail: 0, missing: w.missingCost, late: w.overdue })),
    STRIP_W,
    compact ? 96 : STRIP_H,
  );
  const h = compact ? 96 : STRIP_H;
  const every = Math.max(1, Math.ceil(weeks.length / (compact ? 4 : 7)));
  const total = weeks.reduce((a, w) => a + (w.cash ?? 0), 0);
  const anyCost = weeks.some((w) => w.cash !== null);
  const label = weeks.length
    ? fill(t("Cash needed per week from {from} to {to}: {amount} in total."), {
        from: formatDay(weeks[0]!.weekStart, locale),
        to: formatDay(weeks[weeks.length - 1]!.weekStart, locale),
        amount: money(anyCost ? total : null),
      })
    : "";
  return (
    <svg className="keha-chart keha-orderplan-strip" viewBox={`0 0 ${STRIP_W} ${h}`} role="img" aria-label={label} style={{ height: h }}>
      {bars.map((b, i) => (
        <g key={b.week.weekStart}>
          {b.height > 0 && (
            <rect className="keha-chart__bar" x={b.x} y={b.y} width={b.width} height={b.height} rx={2}>
              <title>{`${formatWeekRange(b.week.weekStart, locale)}: ${money(weeks[i]!.cash)}`}</title>
            </rect>
          )}
          {i % every === 0 && (
            <text x={b.x + b.width / 2} y={h - 6} textAnchor="middle" fontSize="11" fill="currentColor">
              {formatWeekRange(b.week.weekStart, locale)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/** Free plan: what to order and when for the 10 most urgent products — read only. */
export function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  const { t, locale } = useLocale();
  if (!rows.length) return <s-paragraph color="subdued">{t("No orders needed in the next 90 days.")}</s-paragraph>;
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">{t("Product")}</s-table-header>
        <s-table-header listSlot="labeled">{t("Days of stock left")}</s-table-header>
        <s-table-header listSlot="labeled">{t("Order by")}</s-table-header>
        <s-table-header listSlot="labeled">{t("Suggested qty")}</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((r) => {
          const variant = variantName(r.variantTitle);
          const days = r.neverRunsOut ? "∞" : r.daysLeft === null ? "—" : formatCount(Math.max(0, Math.floor(r.daysLeft)), locale);
          return (
            <s-table-row key={r.variantId}>
              <s-table-cell>
                <s-stack direction="block" gap="none">
                  <s-text fontWeight="medium">{r.productTitle}</s-text>
                  {variant && <s-text color="subdued">{variant}</s-text>}
                </s-stack>
              </s-table-cell>
              <s-table-cell>{days}</s-table-cell>
              <s-table-cell>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <span>{formatDay(r.orderBy, locale)}</span>
                  {r.overdue && <s-badge tone="critical">{t("Overdue")}</s-badge>}
                </s-stack>
              </s-table-cell>
              <s-table-cell>{formatCount(r.qty, locale)}</s-table-cell>
            </s-table-row>
          );
        })}
      </s-table-body>
    </s-table>
  );
}

/** The teaching lock under the Free preview. */
export function PreviewLock() {
  const { t } = useLocale();
  const link = useLinkProps();
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-badge icon="lock" tone="info">
            {planTag("reorderPlan", t)}
          </s-badge>
          <s-text fontWeight="medium">{t("Group by supplier, send purchase orders, see the next 90 days")}</s-text>
        </s-stack>
        <s-text color="subdued">{t("Free shows your 10 most urgent products, read only.")}</s-text>
        <s-stack direction="inline">
          <s-button variant="primary" {...link("/app/plans?upgrade=reorderPlan")}>
            {t("Upgrade")}
          </s-button>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

/** A tab the plan doesn't include: what it does and the Upgrade button (the tab bar stays). */
export function TabLock({ feature }: { feature: Feature }) {
  const { t } = useLocale();
  const link = useLinkProps();
  const copy = featureCopy(feature, t);
  return (
    <s-section>
      <s-empty-state heading={`${copy.title} · ${planTag(feature, t)}`}>
        <s-paragraph slot="subheading">{copy.body}</s-paragraph>
        <s-button slot="primary-action" variant="primary" {...link(`/app/plans?upgrade=${feature}`)}>
          {t("See plans")}
        </s-button>
      </s-empty-state>
    </s-section>
  );
}

/** Products the plan leaves out, and why ("—" never stands in for them). */
export function CantPlan({ plan }: { plan: Pick<OrderPlanData, "cantPlan"> }) {
  const { t, locale } = useLocale();
  const { noData, dead } = plan.cantPlan;
  if (!noData && !dead) return null;
  return (
    <s-stack direction="block" gap="none">
      {noData > 0 && (
        <s-text color="subdued">
          {fill(noData === 1 ? t("1 product can't be planned yet — not enough sales history.") : t("{n} products can't be planned yet — not enough sales history."), {
            n: formatCount(noData, locale),
          })}
        </s-text>
      )}
      {dead > 0 && (
        <s-text color="subdued">
          {fill(dead === 1 ? t("1 product isn't selling (dead stock), so it isn't reordered.") : t("{n} products aren't selling (dead stock), so they aren't reordered."), {
            n: formatCount(dead, locale),
          })}
        </s-text>
      )}
    </s-stack>
  );
}
