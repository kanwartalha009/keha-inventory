/**
 * Reorder (/app/reorder) — spec §5.3, J3, Growth (`reorderPlan`; the page is
 * gated in PAGE_FEATURE and every action checks the plan on the server too).
 *
 * What to order, grouped by supplier (unassigned products grouped by vendor):
 * lead time, order-by date, lines with an editable quantity (rounded to the
 * case pack and the supplier's minimums), totals. "Create order" saves a
 * Draft for one group and opens it (/app/reorder/:id) — nothing is sent
 * until the merchant emails it or marks it sent. `?variants=gid,gid` (Home
 * "Add to reorder plan") highlights those lines. Open orders below include
 * purchase orders read from Shopify, marked "From Shopify".
 */
import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { createOrderFromGroup, loadReorder, type OpenOrderRow, type ReorderData } from "../models/reorder.server";
import { AppPage, ProductThumb } from "../components/ui";
import ConfirmModal from "../components/ConfirmModal";
import { flag, useLinkProps, val } from "../components/wc";
import { fill, useLocale } from "../lib/i18n";
import { formatCount, formatDay } from "../lib/dashboard-shared";
import { variantName } from "../lib/products-shared";
import {
  groupTitle,
  groupTotals,
  minimumWarnings,
  parseVariantsParam,
  readQty,
  type ReorderGroup,
  type ReorderLine,
} from "../lib/reorder-shared";
import { formatPrice, poStatusLabel, poStatusTone } from "../lib/purchase-order-shared";

export const loader = async ({ request }: LoaderFunctionArgs): Promise<ReorderData & { enabled: boolean }> => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  // Locked page (app.tsx shows the plan page): send nothing.
  if (!features.reorderPlan) return { groups: [], openOrders: [], currency: "USD", missingSelected: 0, enabled: false };
  const selected = parseVariantsParam(new URL(request.url).searchParams.get("variants"));
  return { ...(await loadReorder(session.shop, selected)), enabled: true };
};

export type ReorderAction = { ok: true; id: string; number: string } | { ok: false; error: "gone" | "empty" };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.reorderPlan) return upgradeResponse("reorderPlan", "The reorder plan is on the Growth plan.");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  if (body.intent !== "create" || typeof body.groupKey !== "string") throw new Response("Bad request", { status: 400 });
  const raw = body.quantities && typeof body.quantities === "object" ? (body.quantities as Record<string, unknown>) : {};
  const quantities: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw).slice(0, 500)) if (/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(k)) quantities[k] = readQty(v);
  return (await createOrderFromGroup(session.shop, body.groupKey, quantities)) satisfies ReorderAction;
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export type ReorderPageData = ReorderData & { enabled: boolean };

export default function Reorder() {
  const { t } = useLocale();
  const data = useLoaderData<typeof loader>() as ReorderPageData;
  const anySelected = data.groups.some((g) => g.selected);
  return (
    <AppPage
      heading={t("Reorder")}
      intro={t("What to order from each supplier, how much, and by which date. Quantities are rounded up to case packs and minimum orders.")}
    >
      {anySelected && <s-banner tone="info">{t("The products from your action list are highlighted.")}</s-banner>}
      {data.missingSelected > 0 && (
        <s-banner tone="warning">{t("Some products from the link aren't tracked in your store any more.")}</s-banner>
      )}
      {data.groups.length === 0 ? (
        <s-section>
          <s-stack direction="block" gap="small" alignItems="center">
            <s-heading>{t("Nothing to reorder right now")}</s-heading>
            <s-paragraph color="subdued">
              {t("Products show up here when their stock will run out before a new order would arrive.")}
            </s-paragraph>
          </s-stack>
        </s-section>
      ) : (
        data.groups.map((g) => <GroupCard key={g.key} group={g} />)
      )}
      <OpenOrders orders={data.openOrders} />
    </AppPage>
  );
}

function GroupCard({ group }: { group: ReorderGroup }) {
  const { t, locale } = useLocale();
  const navigate = useNavigate();
  const fetcher = useFetcher<ReorderAction>();
  const initial = useMemo(() => Object.fromEntries(group.lines.map((l) => [l.variantId, String(l.suggested)])), [group]);
  const [qty, setQty] = useState<Record<string, string>>(initial);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setQty(initial), [initial]);
  useEffect(() => {
    if (fetcher.data?.ok) navigate(`/app/reorder/${fetcher.data.id}`);
  }, [fetcher.data, navigate]);

  const q = (id: string) => readQty(qty[id]);
  const totals = groupTotals(group.lines, q);
  const warn = minimumWarnings(group, q);
  const title = groupTitle(group, t);
  const leadLabel = fill(group.leadTimeSource === "supplier" ? t("{n} days (supplier)") : t("{n} days (store default)"), {
    n: formatCount(group.leadTimeDays, locale),
  });
  const failed = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;

  return (
    <s-section heading={title}>
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          {group.kind === "vendor" && <s-badge tone="neutral">{t("No supplier — grouped by vendor")}</s-badge>}
          {group.selected && <s-badge tone="info">{t("From your action list")}</s-badge>}
          <s-text color="subdued">{`${t("Lead time")}: ${leadLabel}`}</s-text>
          <s-text color="subdued">{`${t("Order by")}: ${formatDay(group.orderBy, locale)}`}</s-text>
        </s-stack>
        {group.toppedUp && (
          <s-text color="subdued">
            {fill(t("Topped up to reach {supplier}'s minimum of {min} units."), {
              supplier: title,
              min: formatCount(group.minOrderTotal, locale),
            })}
          </s-text>
        )}
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("Product")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Stock now")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Incoming")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Days of stock left")}</s-table-header>
            <s-table-header>{t("Quantity")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Unit cost")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Line total")}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {group.lines.map((l) => (
              <LineRow
                key={l.variantId}
                l={l}
                currency={group.currency}
                value={qty[l.variantId] ?? ""}
                belowMoq={warn.belowLine.includes(l.variantId)}
                offPack={warn.notPack.includes(l.variantId)}
                onChange={(v) => setQty((s) => ({ ...s, [l.variantId]: v }))}
              />
            ))}
          </s-table-body>
        </s-table>
        {warn.belowTotal && (
          <s-banner tone="warning">
            {fill(t("Below {supplier}'s minimum of {min} units."), { supplier: title, min: formatCount(group.minOrderTotal, locale) })}
          </s-banner>
        )}
        {failed === "gone" && <s-banner tone="warning">{t("This list changed. Reload the page and try again.")}</s-banner>}
        {failed === "empty" && <s-banner tone="warning">{t("Enter a quantity for at least one product.")}</s-banner>}
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-text fontWeight="medium">
            {`${fill(t("Units: {n}"), { n: formatCount(totals.units, locale) })} · ${fill(t("Cost: {amount}"), {
              amount: formatPrice(totals.cost, group.currency, locale),
            })}`}
          </s-text>
          <s-button variant="primary" disabled={flag(totals.units === 0)} loading={flag(fetcher.state !== "idle")} onClick={() => setConfirm(true)}>
            {t("Create order")}
          </s-button>
        </s-stack>
      </s-stack>
      <ConfirmModal
        open={confirm}
        destructive={false}
        title={fill(t("Create a draft order for {supplier}?"), { supplier: title })}
        message={fill(t("{n} units. Nothing is sent to the supplier until you email the order or mark it as sent."), {
          n: formatCount(totals.units, locale),
        })}
        confirmLabel={t("Create order")}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          const quantities = Object.fromEntries(group.lines.map((l) => [l.variantId, q(l.variantId)]));
          fetcher.submit({ intent: "create", groupKey: group.key, quantities } as never, { method: "post", encType: "application/json" });
        }}
      />
    </s-section>
  );
}

function LineRow({
  l,
  currency,
  value,
  belowMoq,
  offPack,
  onChange,
}: {
  l: ReorderLine;
  currency: string;
  value: string;
  belowMoq: boolean;
  offPack: boolean;
  onChange: (v: string) => void;
}) {
  const { t, locale } = useLocale();
  const variant = variantName(l.variantTitle);
  const sub = [variant, l.sku].filter(Boolean).join(" · ");
  const n = readQty(value);
  const details = [
    l.pack ? fill(t("Cases of {n}"), { n: formatCount(l.pack, locale) }) : null,
    l.moq ? fill(t("Minimum {n} per item"), { n: formatCount(l.moq, locale) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const error = belowMoq
    ? fill(t("Below the minimum of {n} per item."), { n: formatCount(l.moq, locale) })
    : offPack
      ? fill(t("Not a whole number of cases ({n} per case)."), { n: formatCount(l.pack, locale) })
      : undefined;
  const days = l.neverRunsOut ? "∞" : l.daysLeft === null ? "—" : formatCount(Math.max(0, Math.floor(l.daysLeft)), locale);
  return (
    <s-table-row>
      <s-table-cell>
        <div className="keha-cell-product">
          <ProductThumb src={l.image} alt={l.productTitle} size={40} />
          <s-stack direction="block" gap="none">
            <s-text fontWeight="medium">{l.productTitle}</s-text>
            {sub && <s-text color="subdued">{sub}</s-text>}
            {l.selected && <s-badge tone="info">{t("From your action list")}</s-badge>}
          </s-stack>
        </div>
      </s-table-cell>
      <s-table-cell>{formatCount(l.onHand, locale)}</s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="none">
          <span>{formatCount(l.incoming, locale)}</span>
          {l.onOrder > 0 && (
            <s-text color="subdued">{fill(t("+{n} on order with Keha"), { n: formatCount(l.onOrder, locale) })}</s-text>
          )}
        </s-stack>
      </s-table-cell>
      <s-table-cell>{days}</s-table-cell>
      <s-table-cell>
        <s-number-field
          label={fill(t("Quantity for {product}"), { product: [l.productTitle, variant].filter(Boolean).join(" — ") })}
          labelAccessibilityVisibility="exclusive"
          value={value}
          min={0}
          step={1}
          details={details || undefined}
          error={error}
          onInput={(e) => onChange(val(e))}
        />
      </s-table-cell>
      <s-table-cell>{formatPrice(l.unitCost, currency, locale)}</s-table-cell>
      <s-table-cell>{formatPrice(l.unitCost === null || n === 0 ? null : l.unitCost * n, currency, locale)}</s-table-cell>
    </s-table-row>
  );
}

function OpenOrders({ orders }: { orders: OpenOrderRow[] }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  return (
    <s-section heading={t("Open orders")}>
      {orders.length === 0 ? (
        <s-paragraph color="subdued">{t("No open orders. Orders you create here, and purchase orders in Shopify, show up here.")}</s-paragraph>
      ) : (
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("Order")}</s-table-header>
            <s-table-header listSlot="secondary">{t("Status")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Supplier")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Units")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Cost")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Expected arrival")}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {orders.map((o) => (
              <s-table-row key={o.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-link {...link(`/app/reorder/${o.id}`)}>{o.number}</s-link>
                    {o.source === "shopify" && <s-badge tone="neutral">{t("From Shopify")}</s-badge>}
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
    </s-section>
  );
}
