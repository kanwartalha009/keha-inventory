/**
 * Order plan · Order now (/app/reorder) — spec §5.3, J3; Order plan tabs (Kanwar 2026-10-17).
 *
 * Growth (`reorderPlan`; every action checks the plan on the server too): what to order today,
 * grouped by supplier (unassigned products grouped by vendor): lead time, order-by date, lines
 * with an editable quantity (rounded to the case pack and the supplier's minimums), totals.
 * A line is here exactly when the forward order plan (engine/forward-plan-shared) has an order
 * today, with the same quantity. "Create order" saves a Draft for one group and opens it
 * (/app/reorder/:id) — nothing is sent until the merchant emails it or marks it sent.
 * `?variants=gid,gid` (actions) or `id:qty` (Planner, Dashboard, Next 90 days) highlights those
 * lines at those quantities; `?supplier=<group key>` shows that supplier only.
 *
 * Free: a read-only preview — the 10 most urgent products with days left, order-by date and
 * suggested quantity — and the teaching lock. The page is not plan-locked (ORDER_PLAN_PATHS).
 *
 * Pro (`locations`): a location switcher (`?location=`) shows one warehouse's or store's own
 * needs; an order created there records the location in its note. The server ignores
 * `?location` below Pro.
 *
 * Transfers (Pro `transfers`): only when the store plans at least two locations; below Pro the
 * section teaches only when the store has two or more locations (otherwise nothing is shown).
 * Open orders moved to their own tab (/app/reorder/orders).
 */
import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { createOrderFromGroup, loadReorder, type ReorderData } from "../models/reorder.server";
import { activeLocations, listPlanningLocations } from "../models/locations.server";
import { loadOrderPlan } from "../models/order-plan.server";
import { OrderPlanTabs } from "../components/order-plan-tabs";
import { PreviewLock, PreviewTable } from "../components/order-plan";
import { previewRows, type PreviewRow } from "../lib/order-plan-shared";
import { LocationSwitcher, switcherMode } from "../components/location-switcher";
import { LOCKED_TRANSFERS, TransfersSection, type TransfersView } from "../components/transfers-section";
import { loadTransfers } from "../models/transfers.server";
import { AppPage, EmptyState, FormCard, HeaderLabel, ProductThumb, Toolbar } from "../components/ui";
import ConfirmModal from "../components/ConfirmModal";
import { flag, useLinkProps, val } from "../components/wc";
import { fill, useLocale } from "../lib/i18n";
import { formatCount, formatDay } from "../lib/dashboard-shared";
import { variantName } from "../lib/products-shared";
import { quantitiesKey } from "../lib/quantities-key-shared";
import {
  groupTitle,
  groupTotals,
  minimumWarnings,
  parseVariantsWithQty,
  readQty,
  type ReorderGroup,
  type ReorderLine,
} from "../lib/reorder-shared";
import { formatPrice } from "../lib/purchase-order-shared";
import { locationNumericId, parseLocationParam, resolveScope, type PlanningLocation } from "../lib/locations-shared";
import { METRIC_SCOPE } from "../lib/products-shared";

type LocationView = { locationsEnabled: boolean; locations: PlanningLocation[]; location: PlanningLocation | null };
const NO_LOCATIONS: LocationView = { locationsEnabled: false, locations: [], location: null };

/** Active locations (the transfers teaching state only; never fails the page). */
async function activeLocationCount(shop: string): Promise<number> {
  try {
    return (await activeLocations(shop)).length;
  } catch {
    return 0;
  }
}

/** Transfers need somewhere to move stock: two planned locations (Pro), or two locations to teach (below Pro). */
export function showTransfers(input: { transfersEnabled: boolean; planningLocations: number; activeLocations: number }): boolean {
  return input.transfersEnabled ? input.planningLocations >= 2 : input.activeLocations >= 2;
}

export const loader = async ({ request }: LoaderFunctionArgs): Promise<ReorderPageData> => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  // Free: the read-only preview of the forward order plan, nothing else.
  if (!features.reorderPlan) {
    const plan = await loadOrderPlan(session.shop);
    return {
      ...EMPTY_REORDER,
      currency: plan.currency,
      enabled: false,
      preview: previewRows(plan),
    };
  }
  const url = new URL(request.url);
  // `?variants=id,id` (actions) or `id:qty,…` (Planner, Dashboard, Next 90 days: the planned quantities start those lines).
  const { ids: selected, planned } = parseVariantsWithQty(url.searchParams.get("variants"));
  const supplierKey = url.searchParams.get("supplier");
  const locations = features.locations ? await listPlanningLocations(session.shop) : [];
  const view = resolveScope(parseLocationParam(url.searchParams.get("location")), features.locations, locations);
  // Active locations: the switcher hides itself in a one-location store; transfers need two.
  const active = await activeLocationCount(session.shop);
  const transfersShown = showTransfers({ transfersEnabled: features.transfers, planningLocations: locations.length, activeLocations: active });
  const [reorder, transfers] = await Promise.all([
    loadReorder(session.shop, selected, view.scope, planned),
    features.transfers && transfersShown ? loadTransfers(session.shop).then((x) => ({ enabled: true, ...x })) : Promise.resolve(LOCKED_TRANSFERS),
  ]);
  const only = supplierKey ? reorder.groups.find((g) => g.key === supplierKey) : undefined;
  return {
    ...reorder,
    groups: only ? [only] : reorder.groups,
    supplierFilter: only ? { key: only.key, name: only.name, kind: only.kind } : null,
    hiddenGroups: only ? reorder.groups.length - 1 : 0,
    enabled: true,
    locationsEnabled: features.locations,
    locations,
    location: view.location,
    locationCount: active,
    transfers,
    showTransfers: transfersShown,
    preview: null,
  };
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
  // Location view (Pro only; ignored otherwise): the same group, from that location's numbers.
  const requested = parseLocationParam(typeof body.location === "string" ? body.location : null);
  const view = requested && features.locations
    ? resolveScope(requested, true, await listPlanningLocations(session.shop))
    : { scope: METRIC_SCOPE, location: null };
  return (await createOrderFromGroup(session.shop, body.groupKey, quantities, {
    scope: view.scope,
    note: view.location?.name ?? null,
  })) satisfies ReorderAction;
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export type ReorderPageData = ReorderData & {
  enabled: boolean;
  /** Free: the 10 most urgent products (read only); null on Growth / Pro. */
  preview?: PreviewRow[] | null;
  /** `?supplier=` matched a group: only that group is shown. */
  supplierFilter?: { key: string; name: string; kind: "supplier" | "vendor" } | null;
  hiddenGroups?: number;
  showTransfers?: boolean;
  /** Active locations (LocationSwitcher: fewer than 2 → not shown). */
  locationCount?: number;
} & LocationView & { transfers: TransfersView };

const EMPTY_REORDER: Omit<ReorderPageData, "enabled" | "preview"> = {
  groups: [],
  openOrders: [],
  currency: "USD",
  missingSelected: 0,
  ...NO_LOCATIONS,
  transfers: LOCKED_TRANSFERS,
  supplierFilter: null,
  hiddenGroups: 0,
  showTransfers: false,
};

export default function Reorder() {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const data = useLoaderData<typeof loader>() as ReorderPageData;
  const anySelected = data.groups.some((g) => g.selected);
  const fromPlanner = data.groups.some((g) => g.lines.some((l) => l.fromPlanner));
  const location = data.location;
  if (!data.enabled) {
    return (
      <AppPage heading={t("Order plan")} intro={t("Your 10 most urgent products: how many days of stock are left, the date to order by and how many to order.")}>
        <OrderPlanTabs current="now" />
        <FormCard title={t("What to order, and by when")}>
          <PreviewTable rows={data.preview ?? []} />
          <PreviewLock />
        </FormCard>
      </AppPage>
    );
  }
  const filter = data.supplierFilter;
  return (
    <AppPage
      heading={t("Order plan")}
      intro={
        location
          ? fill(t("What {location} needs, from each supplier, and by which date: its own sales and stock. Quantities are rounded up to case packs and minimum orders."), {
              location: location.name,
            })
          : t("What to order from each supplier, how much, and by which date. Quantities are rounded up to case packs and minimum orders.")
      }
    >
      {filter && (
        <s-banner tone="info">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>{fill(t("Showing {supplier} only."), { supplier: groupTitle(filter, t) })}</s-text>
            {(data.hiddenGroups ?? 0) > 0 && <s-link {...link("/app/reorder")}>{t("Show all suppliers")}</s-link>}
          </s-stack>
        </s-banner>
      )}
      {anySelected && (
        <s-banner tone="info">
          {fromPlanner
            ? t("The products from your order plan are highlighted, starting at the planned quantities.")
            : t("The products from your action list are highlighted.")}
        </s-banner>
      )}
      {data.missingSelected > 0 && (
        <s-banner tone="warning">{t("Some products from the link aren't tracked in your store any more.")}</s-banner>
      )}
      <OrderPlanTabs current="now" />
      {switcherMode({ enabled: data.locationsEnabled, planning: data.locations.length, locationCount: data.locationCount, viewing: !!location }) !== "none" && (
        <Toolbar
          filters={
            <LocationSwitcher enabled={data.locationsEnabled} locations={data.locations} current={location} locationCount={data.locationCount} />
          }
        />
      )}
      {data.groups.length === 0 ? (
        <s-section>
          <EmptyState
            heading={t("Nothing to reorder right now")}
            body={t("Products show up here when their stock will run out before a new order would arrive.")}
            action={<s-link {...link("/app/reorder/calendar")}>{t("See the next 90 days")}</s-link>}
          />
        </s-section>
      ) : (
        data.groups.map((g) => <GroupCard key={g.key} group={g} location={location} />)
      )}
      {data.showTransfers !== false && <TransfersSection view={data.transfers} />}
      {data.openOrders.length > 0 && (
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text color="subdued">{fill(t("Open orders: {n}"), { n: formatCount(data.openOrders.length, locale) })}</s-text>
          <s-link {...link("/app/reorder/orders")}>{t("See open orders")}</s-link>
        </s-stack>
      )}
    </AppPage>
  );
}

function GroupCard({ group, location }: { group: ReorderGroup; location: PlanningLocation | null }) {
  const { t, locale } = useLocale();
  const navigate = useNavigate();
  const fetcher = useFetcher<ReorderAction>();
  // Reset typed quantities only when the suggestions change, not on every loader revalidation.
  const resetKey = quantitiesKey(group.key, group.lines.map((l) => [l.variantId, l.suggested] as const));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => Object.fromEntries(group.lines.map((l) => [l.variantId, String(l.suggested)])), [resetKey]);
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
    <FormCard
      title={title}
      sub={`${t("Lead time")}: ${leadLabel} · ${t("Order by")}: ${formatDay(group.orderBy, locale)}`}
      action={
        group.kind === "vendor" || group.selected ? (
          <span className="keha-inline">
            {group.kind === "vendor" && <s-badge tone="neutral">{t("No supplier — grouped by vendor")}</s-badge>}
            {group.selected && (
              <s-badge tone="info">{group.lines.some((l) => l.fromPlanner) ? t("From your order plan") : t("From your action list")}</s-badge>
            )}
          </span>
        ) : undefined
      }
    >
      <s-stack direction="block" gap="base">
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
            <s-table-header listSlot="labeled" format="numeric">{t("Stock now")}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">{t("Incoming")}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              <HeaderLabel id={`keha-left-${group.key}`} label={t("Days left")} hint={t("Days of stock left")} />
            </s-table-header>
            <s-table-header>{t("Quantity")}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">{t("Unit cost")}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">{t("Line total")}</s-table-header>
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
        message={[
          fill(t("{n} units. Nothing is sent to the supplier until you email the order or mark it as sent."), {
            n: formatCount(totals.units, locale),
          }),
          location ? fill(t("The order notes that it is for {location}."), { location: location.name }) : null,
        ]
          .filter(Boolean)
          .join(" ")}
        confirmLabel={t("Create order")}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          const quantities = Object.fromEntries(group.lines.map((l) => [l.variantId, q(l.variantId)]));
          const body = { intent: "create", groupKey: group.key, quantities, ...(location ? { location: locationNumericId(location.id) } : {}) };
          fetcher.submit(body as never, { method: "post", encType: "application/json" });
        }}
      />
    </FormCard>
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
            {l.selected && <s-badge tone="info">{l.fromPlanner ? t("From your order plan") : t("From your action list")}</s-badge>}
          </s-stack>
        </div>
      </s-table-cell>
      <s-table-cell>{formatCount(l.onHand, locale)}</s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="none">
          <span>{formatCount(l.incoming, locale)}</span>
          {l.onOrder > 0 && (
            <s-text color="subdued">
              <span className="keha-nowrap">{fill(t("+{n} on order"), { n: formatCount(l.onOrder, locale) })}</span>
            </s-text>
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
