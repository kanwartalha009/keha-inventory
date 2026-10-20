/**
 * Order plan · Open orders (/app/reorder/orders; Kanwar 2026-10-17) — moved here from the
 * Reorder screen: Keha drafts, sent and confirmed orders and the purchase orders read from
 * Shopify ("Shopify PO") that are ordered but not received, each linking to its order page
 * (/app/reorder/:id).
 *
 * Merchant audit 2026-10-17: columns supplier, number, status, ships, arrives (ship date +
 * the supplier's transit days), units (remaining / total), value, age; sorted by arrival;
 * overdue arrivals flagged ("Expected 12 Oct — not received"); drafts older than 14 days are
 * flagged as no longer counted as ordered, with a banner.
 *
 * Growth (`reorderPlan`). Free keeps the tab bar and sees what the tab does (plan locks teach).
 */
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateApp } from "../services/data-scope.server";
import { getEntitlements } from "../services/entitlements.server";
import { openOrderList } from "../models/reorder.server";
import { AppPage, EmptyState, FormCard, HeaderLabel } from "../components/ui";
import { purchaseOrdersHelp } from "../components/help";
import { OrderPlanTabs } from "../components/order-plan-tabs";
import { TabLock } from "../components/order-plan";
import { useLinkProps } from "../components/wc";
import { fill, useLocale } from "../lib/i18n";
import { formatCount, formatDay } from "../lib/dashboard-shared";
import { DRAFT_EXPIRY_DAYS } from "../lib/supplier-shared";
import { formatPrice, poStatusLabel, poStatusTone, type OpenOrderListRow } from "../lib/purchase-order-shared";

export type OpenOrdersPageData = { enabled: boolean; orders: OpenOrderListRow[]; today?: string };

export const loader = async ({ request }: LoaderFunctionArgs): Promise<OpenOrdersPageData> => {
  const { shop } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  if (!features.reorderPlan) return { enabled: false, orders: [] };
  const { rows, today } = await openOrderList(shop);
  return { enabled: true, orders: rows, today };
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export default function OpenOrdersPage() {
  const { t } = useLocale();
  const data = useLoaderData<typeof loader>() as OpenOrdersPageData;
  return (
    <AppPage heading={t("Order plan")} help={purchaseOrdersHelp(t)} intro={t("Orders you created here and purchase orders in Shopify that haven't arrived yet.")}>
      <OrderPlanTabs current="orders" />
      {data.enabled ? <OpenOrders orders={data.orders} /> : <TabLock feature="poExport" />}
    </AppPage>
  );
}

export function OpenOrders({ orders }: { orders: OpenOrderListRow[] }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const stale = orders.filter((o) => o.stale).length;
  return (
    <>
      {stale > 0 && (
        <s-banner tone="warning">
          {fill(
            stale === 1
              ? t("1 draft is older than {days} days and no longer counted as ordered. Send it or delete it.")
              : t("{count} drafts are older than {days} days and no longer counted as ordered. Send them or delete them."),
            { count: formatCount(stale, locale), days: DRAFT_EXPIRY_DAYS },
          )}
        </s-banner>
      )}
      <FormCard flush title={t("Purchase orders")}>
        {orders.length === 0 ? (
          <EmptyState body={t("No open purchase orders. Purchase orders you create in Keha, and those in Shopify, show up here.")} />
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="labeled">{t("Supplier")}</s-table-header>
              <s-table-header listSlot="primary">{t("Purchase order")}</s-table-header>
              <s-table-header listSlot="secondary">{t("Status")}</s-table-header>
              <s-table-header listSlot="labeled">
                <HeaderLabel id="keha-oo-ships" label={t("Ship date")} hint={t("Ship date confirmed by the supplier")} />
              </s-table-header>
              <s-table-header listSlot="labeled">
                <HeaderLabel id="keha-oo-arrival" label={t("Expected arrival")} hint={t("Expected arrival: the ship date plus the supplier's transit days, else the lead time")} />
              </s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                <HeaderLabel id="keha-oo-units" label={t("Units")} hint={t("Units still to come of the units ordered")} />
              </s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                {t("Value")}
              </s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                <HeaderLabel id="keha-oo-age" label={t("Age (days)")} hint={t("Days since it was ordered; drafts: since created")} />
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {orders.map((o) => (
                <s-table-row key={o.id}>
                  <s-table-cell>{o.supplierName || "—"}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-link {...link(`/app/reorder/${o.id}`)}>{o.number}</s-link>
                      {o.source === "shopify" && (
                        <span className="keha-nowrap">
                          <s-badge tone="neutral">{t("Shopify PO")}</s-badge>
                        </span>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <span className="keha-nowrap">
                        <s-badge tone={o.partial ? "caution" : poStatusTone(o.status)}>
                          {o.partial ? t("Partially received") : poStatusLabel(o.status, t)}
                        </s-badge>
                      </span>
                      {o.stale && (
                        <span className="keha-nowrap">
                          <s-badge tone="warning">{t("Not counted")}</s-badge>
                        </span>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{formatDay(o.ships, locale)}</s-table-cell>
                  <s-table-cell>
                    {o.overdue ? (
                      <s-text tone="critical">{fill(t("Expected {date} — not received"), { date: formatDay(o.arrival, locale) })}</s-text>
                    ) : (
                      formatDay(o.arrival, locale)
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <span className="keha-nowrap">
                      {o.remaining === o.units
                        ? formatCount(o.units, locale)
                        : `${formatCount(o.remaining, locale)} / ${formatCount(o.units, locale)}`}
                    </span>
                  </s-table-cell>
                  <s-table-cell>
                    <span className="keha-nowrap">{formatPrice(o.cost, o.currency, locale)}</span>
                  </s-table-cell>
                  <s-table-cell>
                    {formatCount(o.ageDays, locale)}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </FormCard>
    </>
  );
}
