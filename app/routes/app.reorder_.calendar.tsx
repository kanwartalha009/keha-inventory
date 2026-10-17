/**
 * Order plan · Next 90 days (/app/reorder/calendar; Kanwar 2026-10-17). Growth
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
 * after the merchant confirms there. Unknown costs are "—" and counted, never 0. Free keeps the
 * tab bar and sees what the tab does, with its own plan in numbers.
 */
import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getEntitlements } from "../services/entitlements.server";
import { loadOrderPlan } from "../models/order-plan.server";
import { AppPage, FormCard, HeaderLabel, ProductThumb } from "../components/ui";
import { OrderPlanTabs } from "../components/order-plan-tabs";
import { AboveLastYearBadge, CantPlan, CashStrip, DueLabel, StaleDrafts, TabLock, WhyPopover } from "../components/order-plan";
import { DownloadButton } from "../components/download-button";
import { useLinkProps } from "../components/wc";
import { fill, useLocale } from "../lib/i18n";
import { formatAmount, formatCount, formatDay } from "../lib/dashboard-shared";
import { variantName } from "../lib/products-shared";
import { cashTotals, type PlanEvent, type PlanSupplierWeek, type PlanWeek } from "../lib/engine/forward-plan-shared";
import { toSupplierCurrency } from "../lib/supplier-shared";
import {
  EMPTY_ORDER_PLAN,
  formatDayRange,
  formatWeekRange,
  lockTeaser,
  orderLink,
  planWeeks,
  supplierName,
  type LockTeaser,
  type OrderPlanData,
} from "../lib/order-plan-shared";

export type CalendarPageData = { enabled: boolean; plan: OrderPlanData; teaser?: LockTeaser | null };

export const loader = async ({ request }: LoaderFunctionArgs): Promise<CalendarPageData> => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.orderCalendar) {
    // The lock teaches with the merchant's own totals; no order or product is sent.
    const plan = await loadOrderPlan(session.shop);
    return { enabled: false, plan: EMPTY_ORDER_PLAN("", plan.currency, plan.timezone), teaser: lockTeaser(plan) };
  }
  return { enabled: true, plan: await loadOrderPlan(session.shop, new Date(), { lastYear: true }) };
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
      {data.enabled ? <Calendar plan={data.plan} /> : <TabLock feature="orderCalendar" teaser={data.teaser} currency={data.plan.currency} />}
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
      <StaleDrafts n={plan.staleDrafts} />
      <FormCard
        title={t("Next 90 days")}
        sub={
          totals.lines === 0
            ? t("No orders needed in the next 90 days.")
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
          {totals.lines > 0 && <CashStrip weeks={weeks} currency={plan.currency} />}
          <CantPlan plan={plan} />
          {!plan.suppliersSetUp && totals.lines > 0 && (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text color="subdued">{t("Grouped by vendor until you add your suppliers.")}</s-text>
              <s-link {...link("/app/settings/suppliers")}>{t("Add suppliers")}</s-link>
            </s-stack>
          )}
        </s-stack>
      </FormCard>
      {busy.length > 0 && (
        <FormCard flush title={t("Week by week")} sub={t("Open a week to see its suppliers and lines.")}>
          <div className="keha-orderplan-weeks">
            {weeks.map((w) => (
              // The first week with orders starts open.
              <WeekRow key={w.weekStart} week={w} plan={plan} initiallyOpen={w.weekStart === busy[0]!.weekStart} />
            ))}
          </div>
        </FormCard>
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
        <span className="keha-orderplan-week__n">{fill(week.suppliers.length === 1 ? t("1 supplier") : t("{n} suppliers"), { n: formatCount(week.suppliers.length, locale) })}</span>
        <span className="keha-orderplan-week__n">{fill(t("{n} units"), { n: formatCount(week.units, locale) })}</span>
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
          </s-stack>
          <s-button variant="secondary" {...link(orderLink(s.events, s.supplierKey))}>
            {t("Create order")}
          </s-button>
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
                    <DueLabel deadline={e.overdue && e.deadline ? e.deadline : e.orderBy} today={plan.today} />
                  </s-table-cell>
                  <s-table-cell>{formatDay(e.arrives, locale)}</s-table-cell>
                  <s-table-cell>
                    <span className="keha-inline">
                      <span>{formatCount(e.qty, locale)}</span>
                      <AboveLastYearBadge qty={e.qty} lastYear={e.lastYear} />
                    </span>
                  </s-table-cell>
                  <s-table-cell>{money(e.cost)}</s-table-cell>
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
