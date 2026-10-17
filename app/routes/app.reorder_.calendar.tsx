/**
 * Order plan · Next 90 days (/app/reorder/calendar; Kanwar 2026-10-17). Growth
 * (`orderCalendar`); Free keeps the tab bar and sees what the tab does.
 *
 * The forward order plan (engine/forward-plan-shared, models/order-plan.server): every order the
 * forecast needs from this week through the 13th, grouped by the week of its order-by date and
 * by supplier. A summary line, the cash strip, then one row per week (dates, suppliers, units,
 * cash, order-by range) that opens to its suppliers and lines. "Create order" opens Order now
 * with that supplier's lines at the planned quantities — the purchase order is only created
 * after the merchant confirms there. Unknown costs are "—" and counted, never 0.
 */
import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getEntitlements } from "../services/entitlements.server";
import { loadOrderPlan } from "../models/order-plan.server";
import { AppPage, ProductThumb } from "../components/ui";
import { OrderPlanTabs } from "../components/order-plan-tabs";
import { CantPlan, CashStrip, TabLock } from "../components/order-plan";
import { DownloadButton } from "../components/download-button";
import { useLinkProps } from "../components/wc";
import { fill, useLocale } from "../lib/i18n";
import { formatAmount, formatCount, formatDay } from "../lib/dashboard-shared";
import { variantName } from "../lib/products-shared";
import { cashTotals, type PlanSupplierWeek, type PlanWeek } from "../lib/engine/forward-plan-shared";
import {
  EMPTY_ORDER_PLAN,
  formatDayRange,
  formatWeekRange,
  orderLink,
  planWeeks,
  supplierName,
  type OrderPlanData,
} from "../lib/order-plan-shared";

export type CalendarPageData = { enabled: boolean; plan: OrderPlanData };

export const loader = async ({ request }: LoaderFunctionArgs): Promise<CalendarPageData> => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.orderCalendar) return { enabled: false, plan: EMPTY_ORDER_PLAN("") };
  return { enabled: true, plan: await loadOrderPlan(session.shop) };
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
      {data.enabled ? <Calendar plan={data.plan} /> : <TabLock feature="orderCalendar" />}
    </AppPage>
  );
}

function Calendar({ plan }: { plan: OrderPlanData }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const weeks = planWeeks(plan);
  const totals = cashTotals(plan.events);
  const money = (v: number | null) => formatAmount(v, plan.currency, locale);
  const busy = weeks.filter((w) => w.lines > 0);
  return (
    <>
      <s-section>
        <s-stack direction="block" gap="base">
          {totals.lines === 0 ? (
            <s-paragraph>{t("No orders needed in the next 90 days.")}</s-paragraph>
          ) : (
            <s-text fontWeight="medium">
              {fill(t("{orders} orders in the next 13 weeks · {units} units · {cash}"), {
                // One order per supplier and week.
                orders: formatCount(weeks.reduce((a, w) => a + w.suppliers.length, 0), locale),
                units: formatCount(totals.units, locale),
                cash: money(totals.cash),
              })}
            </s-text>
          )}
          {totals.missingCost > 0 && (
            <s-text color="subdued">
              {fill(t("{n} lines without a cost price are not in the cash totals."), { n: formatCount(totals.missingCost, locale) })}
            </s-text>
          )}
          {totals.lines > 0 && <CashStrip weeks={weeks} currency={plan.currency} />}
          <CantPlan plan={plan} />
          {!plan.suppliersSetUp && totals.lines > 0 && (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text color="subdued">{t("Grouped by vendor until you add your suppliers.")}</s-text>
              <s-link {...link("/app/settings/suppliers")}>{t("Add suppliers")}</s-link>
            </s-stack>
          )}
        </s-stack>
      </s-section>
      {busy.length > 0 && (
        <s-section heading={t("Week by week")}>
          <div className="keha-orderplan-weeks">
            {weeks.map((w) => (
              // The first week with orders starts open.
              <WeekRow key={w.weekStart} week={w} plan={plan} initiallyOpen={w.weekStart === busy[0]!.weekStart} />
            ))}
          </div>
        </s-section>
      )}
      <s-paragraph color="subdued">
        {t("Order-by date: the last day to order so the delivery arrives before your stock drops below its safety level. Based on sales per day while in stock, last year's season, the trend, stock now and stock on order with its dates.")}
      </s-paragraph>
    </>
  );
}

function WeekRow({ week, plan, initiallyOpen }: { week: PlanWeek; plan: OrderPlanData; initiallyOpen: boolean }) {
  const { t, locale } = useLocale();
  const [open, setOpen] = useState(initiallyOpen);
  const id = `keha-week-${week.weekStart}`;
  const money = (v: number | null) => formatAmount(v, plan.currency, locale);
  const range = formatWeekRange(week.weekStart, locale);
  if (week.lines === 0) {
    return (
      <div className="keha-orderplan-week keha-orderplan-week--empty">
        <span className="keha-orderplan-week__when">{range}</span>
        <s-text color="subdued">{t("Nothing to order")}</s-text>
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
        <span>{fill(week.suppliers.length === 1 ? t("1 supplier") : t("{n} suppliers"), { n: formatCount(week.suppliers.length, locale) })}</span>
        <span>{fill(t("{n} units"), { n: formatCount(week.units, locale) })}</span>
        <span className="keha-orderplan-week__cash">{money(week.cash)}</span>
        <span className="keha-orderplan-week__by">{`${t("Order by")} ${formatDayRange(week.orderByFrom, week.orderByTo, locale)}`}</span>
        <s-icon type={open ? "chevron-up" : "chevron-down"} />
      </button>
      {open && (
        <div id={id} className="keha-orderplan-week__body">
          {week.suppliers.map((s) => (
            <SupplierWeek key={s.supplierKey} s={s} plan={plan} />
          ))}
        </div>
      )}
    </div>
  );
}

function SupplierWeek({ s, plan }: { s: PlanSupplierWeek; plan: OrderPlanData }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const money = (v: number | null) => formatAmount(v, plan.currency, locale);
  const name = supplierName(plan, s.supplierKey, t);
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <div className="keha-row-between">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text fontWeight="semibold">{name}</s-text>
            {plan.suppliers[s.supplierKey]?.kind === "vendor" && <s-badge tone="neutral">{t("No supplier — grouped by vendor")}</s-badge>}
            <s-text color="subdued">
              {`${fill(t("{n} units"), { n: formatCount(s.units, locale) })} · ${money(s.cash)}`}
            </s-text>
            {s.missingCost > 0 && (
              <s-text color="subdued">{fill(t("{n} lines without a cost price"), { n: formatCount(s.missingCost, locale) })}</s-text>
            )}
          </s-stack>
          <s-button variant="secondary" {...link(orderLink(s.events, s.supplierKey))}>
            {t("Create order")}
          </s-button>
        </div>
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("Product")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Order by")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Arrives")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Quantity")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Cost")}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {s.events.map((e, i) => {
              const v = plan.variants[e.variantId];
              const variant = variantName(v?.variantTitle ?? "");
              const sub = [variant, v?.sku].filter(Boolean).join(" · ");
              return (
                <s-table-row key={`${e.variantId}-${i}`}>
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
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <span>{formatDay(e.overdue && e.deadline ? e.deadline : e.orderBy, locale)}</span>
                      {e.overdue && <s-badge tone="critical">{t("Overdue")}</s-badge>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{formatDay(e.arrives, locale)}</s-table-cell>
                  <s-table-cell>{formatCount(e.qty, locale)}</s-table-cell>
                  <s-table-cell>{money(e.cost)}</s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
      </s-stack>
    </s-box>
  );
}
