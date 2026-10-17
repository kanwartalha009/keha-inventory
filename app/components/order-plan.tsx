/**
 * Order plan UI pieces shared by the Dashboard, the Order plan tabs and Products: the weekly
 * cash strip, the Free plan's read-only preview and the teaching lock (plan locks teach, they
 * don't hide, with the merchant's own numbers), "Why this quantity", the due-date label and the
 * "Don't reorder" confirm.
 */
import { fill, useLocale } from "../lib/i18n";
import { formatAmount, formatCount, formatDay, formatPercent, notReadyText, type PlanNotReady, type PlanReadiness } from "../lib/dashboard-shared";
import { variantName } from "../lib/products-shared";
import { cashBars } from "../lib/planner-shared";
import type { OrderWhy, PlanWeek } from "../lib/engine/forward-plan-shared";
import { aboveLastYear, dueText, formatWeekRange, lastYearLine, whyLines, whySum, type LockTeaser, type OrderPlanData, type PreviewRow } from "../lib/order-plan-shared";
import ConfirmModal from "./ConfirmModal";
import { featureCopy, planTag } from "./plan";
import { useLinkProps } from "./wc";
import { DaysLeft, HeaderLabel } from "./ui";
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

/** Why the order plan isn't ready, in the admin's language (lib/dashboard-shared notReadyText). */
export function useNotReadyText(): (r: PlanNotReady) => string {
  const { t, locale } = useLocale();
  return (r) => notReadyText(r, t, { day: (d) => formatDay(d, locale), percent: (x) => formatPercent(x, locale) });
}

/** The not-ready reason as a line of text (banners, cards). */
export function PlanNotReadyNote({ readiness }: { readiness: PlanNotReady }) {
  const text = useNotReadyText();
  return <s-text>{text(readiness)}</s-text>;
}

/**
 * Free plan: what to order and when for the 10 most urgent products — read only. Not ready
 * (lib/dashboard-shared planReadiness): says why, never "No orders needed" (2026-10-17).
 */
export function PreviewTable({ rows, readiness }: { rows: PreviewRow[]; readiness?: PlanReadiness | null }) {
  const { t, locale } = useLocale();
  const notReadyLine = useNotReadyText();
  const notReady = readiness && !readiness.ready ? readiness : null;
  if (!rows.length && notReady)
    return (
      <s-stack direction="block" gap="small-200">
        <s-text fontWeight="medium">{t("Your order plan isn't ready yet")}</s-text>
        <s-paragraph color="subdued">{notReadyLine(notReady)}</s-paragraph>
      </s-stack>
    );
  if (!rows.length) return <s-paragraph color="subdued">{t("No orders needed in the next 13 weeks.")}</s-paragraph>;
  return (
    <>
      {notReady && <s-text color="subdued">{`${t("Your order plan isn't ready yet")}: ${notReadyLine(notReady)}`}</s-text>}
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">{t("Product")}</s-table-header>
          <s-table-header listSlot="labeled" format="numeric">
            <HeaderLabel id="keha-prev-left" label={t("Days left")} hint={t("Days of stock left")} />
          </s-table-header>
          <s-table-header listSlot="labeled">
            <HeaderLabel id="keha-prev-by" label={t("Order by")} />
          </s-table-header>
          <s-table-header listSlot="labeled" format="numeric">
            <HeaderLabel id="keha-prev-qty" label={t("To order")} hint={t("Suggested qty")} />
          </s-table-header>
        </s-table-header-row>
        <s-table-body>
          {rows.map((r) => {
            const variant = variantName(r.variantTitle);
            return (
              <s-table-row key={r.variantId}>
                <s-table-cell>
                  <s-stack direction="block" gap="none">
                    <s-text fontWeight="medium">{r.productTitle}</s-text>
                    {variant && <s-text color="subdued">{variant}</s-text>}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <DaysLeft id={`keha-prev-left-${r.variantId.replace(/\D/g, "")}`} daysLeft={r.daysLeft} neverRunsOut={r.neverRunsOut} />
                </s-table-cell>
                <s-table-cell>
                  <OrderByCell orderBy={r.orderBy} overdue={r.overdue} />
                </s-table-cell>
                <s-table-cell>{formatCount(r.qty, locale)}</s-table-cell>
              </s-table-row>
            );
          })}
        </s-table-body>
      </s-table>
    </>
  );
}

/** The teaching lock under the Free preview (with the merchant's own numbers when sent). */
export function PreviewLock({ teaser, currency }: { teaser?: LockTeaser | null; currency?: string }) {
  const { t } = useLocale();
  const link = useLinkProps();
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-badge icon="lock" tone="info">
            {planTag("reorderPlan", t)}
          </s-badge>
          <s-text fontWeight="medium">{t("Group by supplier, send purchase orders, see the next 13 weeks")}</s-text>
        </s-stack>
        <LockTeaserLine teaser={teaser} currency={currency ?? "USD"} />
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
export function TabLock({ feature, teaser, currency }: { feature: Feature; teaser?: LockTeaser | null; currency?: string }) {
  const { t } = useLocale();
  const link = useLinkProps();
  const copy = featureCopy(feature, t);
  return (
    <s-section>
      <s-empty-state heading={`${copy.title} · ${planTag(feature, t)}`}>
        <s-paragraph slot="subheading">{copy.body}</s-paragraph>
        {teaser && (
          <s-paragraph>
            <LockTeaserLine teaser={teaser} currency={currency ?? "USD"} />
          </s-paragraph>
        )}
        <s-button slot="primary-action" variant="primary" {...link(`/app/plans?upgrade=${feature}`)}>
          {t("See plans")}
        </s-button>
      </s-empty-state>
    </s-section>
  );
}

/** Products the plan leaves out, and why ("—" never stands in for them). */
export function CantPlan({ plan }: { plan: Pick<OrderPlanData, "cantPlan"> & Partial<Pick<OrderPlanData, "notReordered">> }) {
  const { t, locale } = useLocale();
  const { noData, dead } = plan.cantPlan;
  const off = plan.notReordered ?? 0;
  if (!noData && !dead && !off) return null;
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
      {off > 0 && (
        <s-text color="subdued">
          {fill(off === 1 ? t("1 product is set to Don't reorder.") : t("{n} products are set to Don't reorder."), { n: formatCount(off, locale) })}
        </s-text>
      )}
    </s-stack>
  );
}

/** Keha drafts older than 14 days no longer count as ordered: say so, with the way to them. */
export function StaleDrafts({ n }: { n: number | null | undefined }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  if (!n) return null;
  return (
    <s-banner tone="info">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-text>
          {n === 1
            ? t("1 old draft (more than 14 days, never sent) is no longer counted as ordered.")
            : fill(t("{n} old drafts (more than 14 days, never sent) are no longer counted as ordered."), { n: formatCount(n, locale) })}
        </s-text>
        <s-link {...link("/app/reorder/orders")}>{t("See open orders")}</s-link>
      </s-stack>
    </s-banner>
  );
}

/**
 * "Why this quantity" (ordering audit 2026-10-17): the terms the forward plan used for the line —
 * forecast, safety stock, stock, stock on order, the need, the rounding, top-ups — and last
 * year's sales in the same weeks. Numbers come from the plan's own computation (OrderWhy).
 */
export function WhyPopover({
  id,
  title,
  whys,
  lastYear,
  qty,
  today,
  days,
}: {
  id: string;
  title: string;
  whys: readonly OrderWhy[];
  lastYear: number | null | undefined;
  qty: number;
  /** Store-local today: a line adding up several orders dates each one (whySum). */
  today?: string;
  /** The days those orders were added over (default: the next 7 days). */
  days?: number;
}) {
  const { t, locale } = useLocale();
  const high = aboveLastYear(qty, lastYear);
  const sum = today ? whySum(whys, today, t, locale, days) : { summary: null, headings: [] as (string | null)[] };
  return (
    <>
      <s-button variant="tertiary" icon="info" commandFor={id} accessibilityLabel={`${t("Why this quantity")}: ${title}`} />
      <s-popover id={id}>
        <s-box padding="base" maxInlineSize="400px">
          <s-stack direction="block" gap="small-200">
            <s-heading>{t("Why this quantity")}</s-heading>
            {sum.summary && <s-text fontWeight="medium">{sum.summary}</s-text>}
            {whys.length ? (
              whys.map((w, i) => (
                <s-stack key={i} direction="block" gap="none">
                  {sum.headings[i] && <s-text fontWeight="medium">{sum.headings[i]}</s-text>}
                  {whyLines(w, t, locale).map((l, k) => (
                    <s-text key={k}>{l}</s-text>
                  ))}
                </s-stack>
              ))
            ) : (
              <s-text color="subdued">{t("The details appear after the next calculation.")}</s-text>
            )}
            <s-text color="subdued">{lastYearLine(lastYear, t, locale)}</s-text>
            {high && <s-badge tone="warning">{t("More than 1.5× last year's sales in these weeks")}</s-badge>}
          </s-stack>
        </s-box>
      </s-popover>
    </>
  );
}

/** The warning badge beside a quantity well above last year's same weeks. */
export function AboveLastYearBadge({ qty, lastYear }: { qty: number; lastYear: number | null | undefined }) {
  const { t } = useLocale();
  if (!aboveLastYear(qty, lastYear)) return null;
  return <s-badge tone="warning">{t("Above last year")}</s-badge>;
}

/**
 * An order-by date with the Overdue badge (Dashboard, Products, the product page, the Free
 * preview): the date, then the badge when late; the badge alone when late with no date (M3).
 */
export function OrderByCell({ orderBy, overdue }: { orderBy: string | null | undefined; overdue: boolean }) {
  const { t, locale } = useLocale();
  return (
    <span className="keha-inline">
      {(orderBy || !overdue) && <span>{formatDay(orderBy, locale)}</span>}
      {overdue && <s-badge tone="critical">{t("Overdue")}</s-badge>}
    </span>
  );
}

/** A line's real deadline: "Due 27 Oct", "Due today", "Overdue since 12 Oct" or "Overdue" (critical). */
export function DueLabel({ deadline, today, overdue = false }: { deadline: string | null | undefined; today: string; overdue?: boolean }) {
  const { t, locale } = useLocale();
  const text = dueText(deadline, today, t, locale, overdue);
  if ((deadline && deadline < today) || (!deadline && overdue)) return <s-badge tone="critical">{text}</s-badge>;
  return <span className="keha-nowrap">{text}</span>;
}

/**
 * Confirm for "Don't reorder" (or "Reorder again"): says it stays in the stock numbers and only
 * leaves the orders. Nothing in the store changes.
 */
export function NoReorderConfirm({
  open,
  name,
  value,
  scope,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  name: string;
  /** true = set "Don't reorder"; false = reorder again. */
  value: boolean;
  scope: "product" | "variant";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  return (
    <ConfirmModal
      open={open}
      destructive={false}
      title={fill(value ? t("Stop reordering {product}?") : t("Reorder {product} again?"), { product: name })}
      message={
        value
          ? scope === "product"
            ? t("Every variant of this product leaves Order now, Next 13 weeks, the Dashboard and Products' To order. It stays in your stock numbers, and you can turn it back on any time.")
            : t("This variant leaves Order now, Next 13 weeks, the Dashboard and Products' To order. It stays in your stock numbers, and you can turn it back on any time.")
          : t("It comes back into your order plan from the next refresh of this page.")
      }
      confirmLabel={value ? t("Don't reorder") : t("Reorder again")}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/** The Free plan's teaching line with the merchant's own numbers (never shown in Sidekick). */
export function LockTeaserLine({ teaser, currency }: { teaser: LockTeaser | null | undefined; currency: string }) {
  const { t, locale } = useLocale();
  if (!teaser) return null;
  return (
    <s-text>
      {fill(teaser.suppliers === 1 ? t("Your plan has {n} more products to order from 1 supplier — {cash} over the next 13 weeks. Growth shows every order and turns it into a purchase order.") : t("Your plan has {n} more products to order from {suppliers} suppliers — {cash} over the next 13 weeks. Growth shows every order and turns it into a purchase order."), {
        n: formatCount(teaser.more, locale),
        suppliers: formatCount(teaser.suppliers, locale),
        cash: formatAmount(teaser.cash, currency, locale),
      })}
    </s-text>
  );
}
