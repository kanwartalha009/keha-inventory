/**
 * Order plan · Open orders (/app/reorder/orders; Kanwar 2026-10-17) — moved here from the
 * Reorder screen: Keha drafts, sent and confirmed orders and the purchase orders read from
 * Shopify ("From Shopify") that are ordered but not received, with supplier, status, expected
 * arrival, units and value, each linking to its order page (/app/reorder/:id).
 *
 * Growth (`reorderPlan`). Free keeps the tab bar and sees what the tab does (plan locks teach).
 */
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getEntitlements } from "../services/entitlements.server";
import { openOrders, type OpenOrderRow } from "../models/reorder.server";
import { AppPage, EmptyState, FormCard, HeaderLabel } from "../components/ui";
import { OrderPlanTabs } from "../components/order-plan-tabs";
import { TabLock } from "../components/order-plan";
import { useLinkProps } from "../components/wc";
import { useLocale } from "../lib/i18n";
import { formatCount, formatDay } from "../lib/dashboard-shared";
import { formatPrice, poStatusLabel, poStatusTone } from "../lib/purchase-order-shared";

export type OpenOrdersPageData = { enabled: boolean; orders: OpenOrderRow[] };

export const loader = async ({ request }: LoaderFunctionArgs): Promise<OpenOrdersPageData> => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.reorderPlan) return { enabled: false, orders: [] };
  return { enabled: true, orders: await openOrders(session.shop) };
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export default function OpenOrdersPage() {
  const { t } = useLocale();
  const data = useLoaderData<typeof loader>() as OpenOrdersPageData;
  return (
    <AppPage heading={t("Order plan")} intro={t("Orders you created here and purchase orders in Shopify that haven't arrived yet.")}>
      <OrderPlanTabs current="orders" />
      {data.enabled ? <OpenOrders orders={data.orders} /> : <TabLock feature="poExport" />}
    </AppPage>
  );
}

export function OpenOrders({ orders }: { orders: OpenOrderRow[] }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  return (
    <FormCard flush title={t("Open orders")}>
      {orders.length === 0 ? (
        <EmptyState body={t("No open orders. Orders you create here, and purchase orders in Shopify, show up here.")} />
      ) : (
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("Order")}</s-table-header>
            <s-table-header listSlot="secondary">{t("Status")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Supplier")}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">{t("Units")}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">{t("Cost")}</s-table-header>
            <s-table-header listSlot="labeled">
              <HeaderLabel id="keha-oo-arrival" label={t("Arrives")} hint={t("Expected arrival")} />
            </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {orders.map((o) => (
              <s-table-row key={o.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-link {...link(`/app/reorder/${o.id}`)}>{o.number}</s-link>
                    {o.source === "shopify" && (
                      <span className="keha-nowrap">
                        <s-badge tone="neutral">{t("From Shopify")}</s-badge>
                      </span>
                    )}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={poStatusTone(o.status)}>{poStatusLabel(o.status, t)}</s-badge>
                </s-table-cell>
                <s-table-cell>{o.supplierName || "—"}</s-table-cell>
                <s-table-cell>{formatCount(o.units, locale)}</s-table-cell>
                <s-table-cell>{formatPrice(o.cost, o.currency, locale)}</s-table-cell>
                <s-table-cell>{formatDay(o.arrival, locale)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      )}
    </FormCard>
  );
}
