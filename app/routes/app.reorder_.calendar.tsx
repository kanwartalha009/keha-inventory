/**
 * Order plan · Next 13 weeks (/app/reorder/calendar; Kanwar 2026-10-17). Growth
 * (`orderCalendar`); Free keeps the tab bar and sees what the tab does.
 *
 * The forward order plan (engine/forward-plan-shared, models/order-plan.server): every order the
 * forecast needs from this week through the 13th, grouped by the week of its order-by date and
 * by supplier. A summary line, the cash strip, then one row per week (dates, suppliers, units,
 * cash, order-by range) that opens to its suppliers and lines. Each order sits on its own
 * order-by date (ordering audit 2026-10-17), with the supplier's minimums applied, so the first
 * week is Order now. Every line has "Why this quantity" and last year's sales in the same weeks.
 * "Create order" opens Order now with that supplier's orders of the week (a supplier + date
 * range the Order now loader resolves — nothing is cut off) — the purchase order is only created
 * after the merchant confirms there. "Build supplier order" opens the supplier order builder for
 * that supplier-week (/app/reorder/build: the week's orders plus everything due within the
 * supplier's order cycle after it, in one purchase order). Unknown costs are "—" and counted, never 0. Free keeps the
 * tab bar and sees what the tab does, with its own plan in numbers.
 */
import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateApp } from "../services/data-scope.server";
import { getEntitlements } from "../services/entitlements.server";
import { loadOrderPlan } from "../models/order-plan.server";
import { readiness } from "../models/dashboard.server";
import { AppPage, FormCard, HeaderLabel, ProductThumb } from "../components/ui";
import { OrderPlanTabs } from "../components/order-plan-tabs";
import { AboveLastYearBadge, CantPlan, CashBreakdown, CashStrip, DueLabel, StaleDrafts, TabLock, WhyPopover, useNotReadyText } from "../components/order-plan";
import { DownloadButton } from "../components/download-button";
import { useLinkProps } from "../components/wc";
import { fill, useLocale } from "../lib/i18n";
import { formatAmount, formatCount, formatDay, type PlanReadiness } from "../lib/dashboard-shared";
import { variantName } from "../lib/products-shared";
import { cashTotals, dueDay, dueNote, type PlanEvent, type PlanSupplierWeek, type PlanWeek } from "../lib/engine/forward-plan-shared";
import { toSupplierCurrency } from "../lib/supplier-shared";
import { builderLink } from "../lib/supplier-order-shared";
import { landedText, termsText, type CashWeek as PaidWeek, type Deferral, type FitMonth } from "../lib/cash-shared";
import {
  EMPTY_ORDER_PLAN,
  formatDayRange,
  formatWeekRange,
  lockTeaser,
  monthYear,
  shortDay,
  orderByFootnote,
  orderLink,
  paidSummary,
  paidWeeks,
  planFit,
  planMonths,
  planWeeks,
  supplierName,
  type LockTeaser,
  type OrderPlanData,
} from "../lib/order-plan-shared";

export type CalendarPageData = {
  enabled: boolean;
  plan: OrderPlanData;
  teaser?: LockTeaser | null;
  /** Home's state: not ready → say why, never "No orders needed" (absent = ready). */
  readiness?: PlanReadiness;
};

export const loader = async ({ request }: LoaderFunctionArgs): Promise<CalendarPageData> => {
  const { shop } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  if (!features.orderCalendar) {
    // The lock teaches with the merchant's own totals; no order or product is sent.
    const plan = await loadOrderPlan(shop);
    return { enabled: false, plan: EMPTY_ORDER_PLAN("", plan.currency, plan.timezone), teaser: lockTeaser(plan) };
  }
  const [plan, ready] = await Promise.all([loadOrderPlan(shop, new Date(), { lastYear: true }), readiness(shop)]);
  return { enabled: true, plan, readiness: ready };
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export default function OrderCalendar() {
  const { t } = useLocale();
  const data = useLoaderData<typeof loader>() as CalendarPageData;
  return (
    <AppPage
      heading={t("Order plan")}
      intro={t("Every order your forecast needs in the next 13 weeks: by week and supplier, with the cash each week needs.")}
      secondaryActions={
        data.enabled && data.plan.events.length > 0
          ? [<DownloadButton key="csv" url="/app/reorder/calendar/csv" fileName={`order-plan-${data.plan.today}.csv`} label={t("Download CSV")} />]
          : undefined
      }
    >
      <OrderPlanTabs current="calendar" />
      {data.enabled ? <Calendar plan={data.plan} readiness={data.readiness} /> : <TabLock feature="orderCalendar" teaser={data.teaser} currency={data.plan.currency} />}
    </AppPage>
  );
}

function Calendar({ plan, readiness }: { plan: OrderPlanData; readiness?: PlanReadiness }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const notReady = readiness && !readiness.ready ? readiness : null;
  const notReadyLine = useNotReadyText();
  const weeks = planWeeks(plan);
  // Supplier module: each payment in the week it is paid (deposits, balances, freight & duty), and
  // what is still due on orders already sent.
  const paid = paidWeeks(plan);
  const cashOut = paidSummary(plan);
  const totals = cashTotals(plan.events);
  const money = (v: number | null) => formatAmount(v, plan.currency, locale);
  const busy = weeks.filter((w, i) => w.lines > 0 || (paid[i]?.total ?? 0) > 0);
  return (
    <>
      <StaleDrafts n={plan.staleDrafts} />
      <FormCard
        title={notReady ? t("Your order plan isn't ready yet") : t("Next 13 weeks")}
        sub={
          notReady
            ? // Still reading the store / fewer than 14 days of sales: say why — never "No orders needed".
              notReadyLine(notReady)
            : totals.lines === 0
            ? t("No orders needed in the next 13 weeks.")
            : fill(t("{orders} orders in the next 13 weeks · {units} units · {cash}"), {
                // One order per supplier and week.
                orders: formatCount(weeks.reduce((a, w) => a + w.suppliers.length, 0), locale),
                units: formatCount(totals.units, locale),
                cash: money(totals.cash),
              })
        }
      >
        <s-stack direction="block" gap="base">
          {totals.missingCost > 0 && (
            <s-text color="subdued">
              {fill(t("{n} lines without a cost price are not in the cash totals."), { n: formatCount(totals.missingCost, locale) })}
            </s-text>
          )}
          {(totals.lines > 0 || cashOut.committed > 0) && (
            <s-stack direction="block" gap="small-200">
              <s-text fontWeight="medium">{fill(t("Cash needed, next 13 weeks: {cash}"), { cash: money(cashOut.any ? cashOut.total : null) })}</s-text>
              <CashStrip cash={paid} currency={plan.currency} />
              <CashBreakdown summary={cashOut} currency={plan.currency} />
            </s-stack>
          )}
          {!notReady && <CantPlan plan={plan} />}
          {!plan.suppliersSetUp && totals.lines > 0 && (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text color="subdued">{t("Grouped by vendor until you add your suppliers.")}</s-text>
              <s-link {...link("/app/settings/suppliers")}>{t("Add suppliers")}</s-link>
            </s-stack>
          )}
          {!plan.budget && totals.lines > 0 && (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text color="subdued">{t("Compare each month's cash with a budget.")}</s-text>
              <s-link {...link("/app/settings")}>{t("Set a monthly budget")}</s-link>
            </s-stack>
          )}
        </s-stack>
      </FormCard>
      {!!plan.budget && (totals.lines > 0 || cashOut.committed > 0) && <BudgetCard plan={plan} />}
      {busy.length > 0 && (
        <FormCard flush title={t("Week by week")} sub={t("Open a week to see its suppliers and lines.")}>
          <div className="keha-orderplan-weeks">
            {weeks.map((w, i) => (
              // The first week with orders starts open.
              <WeekRow key={w.weekStart} week={w} paid={paid[i] ?? null} plan={plan} initiallyOpen={w.weekStart === (busy.find((b) => b.lines > 0) ?? busy[0]!).weekStart} />
            ))}
          </div>
        </FormCard>
      )}
      <s-paragraph color="subdued">{orderByFootnote(plan.trendMode, t)}</s-paragraph>
    </>
  );
}

function WeekRow({ week, paid, plan, initiallyOpen }: { week: PlanWeek; paid: PaidWeek | null; plan: OrderPlanData; initiallyOpen: boolean }) {
  const { t, locale } = useLocale();
  const [open, setOpen] = useState(initiallyOpen);
  const id = `keha-week-${week.weekStart}`;
  const money = (v: number | null) => formatAmount(v, plan.currency, locale);
  const range = formatWeekRange(week.weekStart, locale);
  // The week's cash = what is PAID in it (payment terms), not the value of the orders placed in it.
  const cashOut = paid && paid.total > 0 ? paid.total : week.cash === null ? null : 0;
  if (week.lines === 0) {
    return (
      <div className="keha-orderplan-week keha-orderplan-week--empty">
        <span className="keha-orderplan-week__when">{range}</span>
        <s-text color="subdued">
          {paid && paid.total > 0 ? fill(t("Nothing to order · {amount} to pay on earlier orders"), { amount: money(paid.total) }) : t("Nothing to order")}
        </s-text>
      </div>
    );
  }
  return (
    <div className="keha-orderplan-week">
      <button type="button" className="keha-orderplan-week__head" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span className="keha-orderplan-week__when">
          {range}
          {week.overdue && <s-badge tone="critical">{t("Overdue")}</s-badge>}
        </span>
        <span className="keha-orderplan-week__n">{fill(week.suppliers.length === 1 ? t("1 supplier") : t("{n} suppliers"), { n: formatCount(week.suppliers.length, locale) })}</span>
        <span className="keha-orderplan-week__n">{fill(t("{n} units"), { n: formatCount(week.units, locale) })}</span>
        <span className="keha-orderplan-week__cash" title={t("Paid this week")}>{money(cashOut)}</span>
        <span className="keha-orderplan-week__by">{`${t("Order by")} ${formatDayRange(week.orderByFrom, week.orderByTo, locale)}`}</span>
        <s-icon type={open ? "chevron-up" : "chevron-down"} />
      </button>
      {open && (
        <div id={id} className="keha-orderplan-week__body">
          {paid && (paid.committed > 0 || Math.abs(paid.total - (week.cash ?? 0)) > 0.005) && (
            <s-text color="subdued">
              {[
                fill(t("Paid this week: {amount}"), { amount: money(paid.total) }),
                fill(t("orders of this week: {amount}"), { amount: money(week.cash) }),
                paid.committed > 0 ? fill(t("{amount} on open orders"), { amount: money(paid.committed) }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </s-text>
          )}
          {week.suppliers.map((s) => (
            <SupplierWeek key={s.supplierKey} s={s} plan={plan} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A supplier's lines of one week: by product then variant, a product with an overdue line first. */
function byProduct(events: readonly PlanEvent[], plan: OrderPlanData): PlanEvent[] {
  const overdue = new Set(events.filter((e) => e.overdue).map((e) => e.productId));
  const title = (e: PlanEvent) => plan.variants[e.variantId]?.productTitle ?? "";
  const variant = (e: PlanEvent) => plan.variants[e.variantId]?.variantTitle ?? "";
  return [...events].sort(
    (a, b) =>
      Number(overdue.has(b.productId)) - Number(overdue.has(a.productId)) ||
      title(a).localeCompare(title(b)) ||
      (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0) ||
      variant(a).localeCompare(variant(b)) ||
      a.orderBy.localeCompare(b.orderBy) ||
      (a.variantId < b.variantId ? -1 : 1),
  );
}

function SupplierWeek({ s, plan }: { s: PlanSupplierWeek; plan: OrderPlanData }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const money = (v: number | null) => formatAmount(v, plan.currency, locale);
  const name = supplierName(plan, s.supplierKey, t);
  const info = plan.suppliers[s.supplierKey];
  // Supplier currency only with an exchange rate (then both amounts).
  const supplierCash = info?.currency && info.currency !== plan.currency.toUpperCase() ? toSupplierCurrency(s.cash, info.exchangeRate) : null;
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <div className="keha-row-between">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text fontWeight="semibold">{name}</s-text>
            {info?.kind === "vendor" && <s-badge tone="neutral">{t("No supplier — grouped by vendor")}</s-badge>}
            <span className="keha-num">
              <s-text color="subdued">
                {[fill(t("{n} units"), { n: formatCount(s.units, locale) }), money(s.cash), supplierCash !== null ? formatAmount(supplierCash, info!.currency!, locale) : null].filter(Boolean).join(" · ")}
              </s-text>
            </span>
            {s.missingCost > 0 && (
              <s-text color="subdued">{fill(t("{n} lines without a cost price"), { n: formatCount(s.missingCost, locale) })}</s-text>
            )}
            {(info?.terms || info?.landedPct) && <s-text color="subdued">{[termsText(info.terms, t), landedText(info.landedPct, t, locale)].filter(Boolean).join(" ")}</s-text>}
          </s-stack>
          <span className="keha-inline">
            <s-button variant="secondary" {...link(builderLink(s.supplierKey, { from: s.orderByFrom, to: s.orderByTo }))}>
              {t("Build supplier order")}
            </s-button>
            <s-button variant="secondary" {...link(orderLink(s.events, s.supplierKey))}>
              {t("Create order")}
            </s-button>
          </span>
        </div>
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("Product")}</s-table-header>
            <s-table-header listSlot="labeled"><HeaderLabel id="keha-cal-by" label={t("Order by")} /></s-table-header>
            <s-table-header listSlot="labeled"><HeaderLabel id="keha-cal-arrives" label={t("Arrives")} /></s-table-header>
            <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-cal-qty" label={t("Quantity")} /></s-table-header>
            <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-cal-cost" label={t("Cost")} /></s-table-header>
            <s-table-header><HeaderLabel id="keha-cal-why" label={t("Why")} hint={t("Why this quantity")} /></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {byProduct(s.events, plan).map((e, i) => {
              const v = plan.variants[e.variantId];
              const variant = variantName(v?.variantTitle ?? "");
              const sub = [variant, v?.sku].filter(Boolean).join(" · ");
              const label = [v?.productTitle ?? "", variant].filter(Boolean).join(" — ");
              return (
                <s-table-row key={`${e.variantId}-${e.orderBy}-${i}`}>
                  <s-table-cell>
                    <div className="keha-cell-product">
                      <ProductThumb src={v?.image ?? null} alt={v?.productTitle ?? ""} size={32} />
                      <s-stack direction="block" gap="none">
                        <s-text fontWeight="medium">{v?.productTitle ?? "—"}</s-text>
                        {sub && <s-text color="subdued">{sub}</s-text>}
                      </s-stack>
                    </div>
                  </s-table-cell>
                  <s-table-cell>
                    <DueLabel deadline={dueDay(e)} overdue={e.overdue} today={plan.today} note={dueNote([e])} />
                  </s-table-cell>
                  <s-table-cell>{formatDay(e.arrives, locale)}</s-table-cell>
                  <s-table-cell>
                    <span className="keha-inline">
                      <span>{formatCount(e.qty, locale)}</span>
                      <AboveLastYearBadge qty={e.qty} lastYear={e.lastYear} />
                    </span>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <span>{money(e.cost)}</span>
                      {!!e.landed && e.landed > 0 && <s-text color="subdued">{fill(t("+ {amount} freight & duty"), { amount: money(e.landed) })}</s-text>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <WhyPopover id={`keha-cal-why-${e.variantId.replace(/\D/g, "")}-${e.orderBy}`} title={label} whys={e.why ? [e.why] : []} lastYear={e.lastYear} qty={e.qty} />
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
      </s-stack>
    </s-box>
  );
}

/** "November 2026" (a month key "2026-11"), in the admin language. */
function monthName(month: string, locale: string): string {
  return monthYear(`${month}-01`, locale);
}

/**
 * Monthly budget (Settings → Defaults): each month's cash out (orders to place + still due on open
 * orders, on the days paid) against the budget; a month over it offers "Fit to budget" — the
 * lowest-priority orders (money at stake per day ÷ days until it runs out) that could wait until
 * next month without breaking a supplier's minimums. A suggestion only: nothing is changed.
 */
function BudgetCard({ plan }: { plan: OrderPlanData }) {
  const { t, locale } = useLocale();
  const months = planMonths(plan);
  const fit = planFit(plan);
  const [open, setOpen] = useState<string | null>(null);
  const money = (v: number | null) => formatAmount(v, plan.currency, locale);
  const budget = plan.budget!;
  const over = fit.length;
  return (
    <FormCard
      flush
      title={t("Monthly budget")}
      sub={
        over
          ? fill(over === 1 ? t("1 month is over your budget of {budget}.") : t("{n} months are over your budget of {budget}."), { n: formatCount(over, locale), budget: money(budget) })
          : fill(t("Every month is within your budget of {budget}."), { budget: money(budget) })
      }
    >
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">{t("Month")}</s-table-header>
          <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-bud-out" label={t("Cash out")} hint={t("Paid in the month: orders to place and still due on open orders")} /></s-table-header>
          <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-bud-budget" label={t("Monthly budget")} /></s-table-header>
          <s-table-header listSlot="labeled"><HeaderLabel id="keha-bud-status" label={t("Status")} /></s-table-header>
          <s-table-header><HeaderLabel id="keha-bud-act" label={t("Actions")} /></s-table-header>
        </s-table-header-row>
        <s-table-body>
          {months.map((m) => {
            const f = fit.find((x) => x.month === m.month);
            return (
              <s-table-row key={m.month}>
                <s-table-cell>
                  <s-stack direction="block" gap="none">
                    <s-text fontWeight="medium">{monthName(m.month, locale)}</s-text>
                    {m.partial && <s-text color="subdued">{formatDayRange(m.from, m.to, locale)}</s-text>}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-stack direction="block" gap="none">
                    <span>{money(m.total)}</span>
                    {m.committed > 0 && <s-text color="subdued">{fill(t("{amount} on open orders"), { amount: money(m.committed) })}</s-text>}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{money(budget)}</s-table-cell>
                <s-table-cell>
                  {f ? (
                    <s-badge tone="critical">{fill(t("Over by {amount}"), { amount: money(f.overBy) })}</s-badge>
                  ) : (
                    <s-badge tone="success">{t("Within budget")}</s-badge>
                  )}
                </s-table-cell>
                <s-table-cell>
                  {f ? (
                    <s-button variant="secondary" onClick={() => setOpen((o) => (o === m.month ? null : m.month))}>
                      {open === m.month ? t("Hide suggestion") : t("Fit to budget")}
                    </s-button>
                  ) : (
                    "—"
                  )}
                </s-table-cell>
              </s-table-row>
            );
          })}
        </s-table-body>
      </s-table>
      {fit
        .filter((f) => f.month === open)
        .map((f) => (
          <FitSuggestion key={f.month} fit={f} plan={plan} />
        ))}
    </FormCard>
  );
}

/** The orders that could wait until next month (a suggestion: nothing changes until the merchant changes an order). */
function FitSuggestion({ fit, plan }: { fit: FitMonth; plan: OrderPlanData }) {
  const { t, locale } = useLocale();
  const money = (v: number | null) => formatAmount(v, plan.currency, locale);
  const month = monthName(fit.month, locale);
  const moved = fit.deferrals.reduce((a, d) => a + d.amount, 0);
  return (
    <s-box padding="base">
      <s-stack direction="block" gap="small">
        <s-text fontWeight="medium">
          {fit.deferrals.length
            ? fill(t("These orders could wait until next month: {amount} moves out of {month}."), { amount: money(moved), month })
            : fill(t("No order in {month} can wait without breaking a supplier minimum or an overdue order."), { month })}
        </s-text>
        {fit.deferrals.length > 0 && (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("Product")}</s-table-header>
              <s-table-header listSlot="labeled">{t("Supplier")}</s-table-header>
              <s-table-header listSlot="labeled"><HeaderLabel id={`keha-fit-move-${fit.month}`} label={t("Order by")} hint={t("Planned date → suggested date")} /></s-table-header>
              <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id={`keha-fit-amt-${fit.month}`} label={t("Cash moved")} /></s-table-header>
              <s-table-header listSlot="labeled"><HeaderLabel id={`keha-fit-risk-${fit.month}`} label={t("Risk")} /></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {fit.deferrals.map((d) => (
                <DeferralRow key={`${d.variantId}-${d.from}`} d={d} plan={plan} money={money} />
              ))}
            </s-table-body>
          </s-table>
        )}
        <s-text color="subdued">
          {fit.fits
            ? fill(t("{month} would then be {amount}, within your budget."), { month, amount: money(fit.after) })
            : fill(t("{month} would still be {amount}: what is due on open orders and orders that can't wait stay in it."), { month, amount: money(fit.after) })}
        </s-text>
        <s-text color="subdued">{t("A suggestion only: nothing changes until you change your orders. Lowest priority first: the least money at stake per day for the most days of stock left.")}</s-text>
      </s-stack>
    </s-box>
  );
}

function DeferralRow({ d, plan, money }: { d: Deferral; plan: OrderPlanData; money: (v: number | null) => string }) {
  const { t, locale } = useLocale();
  const v = plan.variants[d.variantId];
  const variant = variantName(v?.variantTitle ?? "");
  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="block" gap="none">
          <s-text fontWeight="medium">{v?.productTitle ?? "—"}</s-text>
          {(variant || d.wholeOrder) && (
            <s-text color="subdued">{[variant, d.wholeOrder ? t("with the rest of this supplier order") : null].filter(Boolean).join(" · ")}</s-text>
          )}
        </s-stack>
      </s-table-cell>
      <s-table-cell>{supplierName(plan, d.supplierKey, t)}</s-table-cell>
      <s-table-cell>
        <span className="keha-nowrap">{`${shortDay(d.from, locale)} → ${shortDay(d.to, locale)}`}</span>
      </s-table-cell>
      <s-table-cell>{money(d.amount)}</s-table-cell>
      <s-table-cell>
        {d.lateDays === null ? (
          "—"
        ) : d.lateDays > 0 ? (
          <s-badge tone="warning">{fill(d.lateDays === 1 ? t("May sell out 1 day") : t("May sell out {n} days"), { n: formatCount(d.lateDays, locale) })}</s-badge>
        ) : (
          <s-text color="subdued">{t("Arrives in time")}</s-text>
        )}
      </s-table-cell>
    </s-table-row>
  );
}
