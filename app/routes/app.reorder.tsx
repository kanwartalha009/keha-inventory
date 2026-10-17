/**
 * Order plan · Order now (/app/reorder) — spec §5.3, J3; Order plan tabs (Kanwar 2026-10-17);
 * ordering audit 2026-10-17.
 *
 * Growth (`reorderPlan`; every action checks the plan on the server too): everything due in the
 * next 7 days (overdue included) — exactly the Dashboard's "Order this week", from the same
 * forward plan (models/order-plan.server): each order on its order-by date, the supplier's
 * minimums (per line, per style, per order in units and money) already applied. Grouped by
 * supplier (unassigned products by vendor), lines by product then size, each with its real
 * deadline ("Due 27 Oct", "Overdue since 12 Oct"), "Why this quantity" and last year's sales in
 * the same weeks. Under each supplier, "Can join this order": its lines due before its next
 * order. "Create order" (with a confirm showing units and cost) saves a Draft for one group and
 * opens it (/app/reorder/:id) — nothing is sent until the merchant emails it or marks it sent.
 *
 * Links: `?supplier=<key>&from=&to=` (Dashboard, Next 90 days: that supplier's planned orders in
 * the range, resolved here — never truncated), `?scenario=<id>&group=<key>` (Season plan: its
 * planned quantities, resolved here), `?variants=gid,…` (an action's "Add to order", at most 250
 * — highlights those lines). `?supplier=<key>` alone shows that supplier only.
 *
 * "Don't reorder this product" (line menu, with a confirm): the product leaves every order; it
 * stays in the stock numbers. Our database only.
 *
 * Free: a read-only preview — the 10 most urgent products — and the teaching lock with the
 * merchant's own numbers. The page is not plan-locked (ORDER_PLAN_PATHS).
 *
 * Pro (`locations`): a location switcher (`?location=`) shows one warehouse's or store's own
 * plan; an order created there records the location in its note. Ignored below Pro.
 *
 * Transfers (Pro `transfers`): only when the store plans at least two locations; below Pro the
 * section teaches only when the store has two or more locations (otherwise nothing is shown).
 * Open orders are their own tab (/app/reorder/orders).
 */
import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { createOrderFromGroup, loadReorder, scenarioPlanned, setNoReorder, type ReorderData } from "../models/reorder.server";
import { activeLocations, listPlanningLocations } from "../models/locations.server";
import { loadOrderPlan } from "../models/order-plan.server";
import { OrderPlanTabs } from "../components/order-plan-tabs";
import { AboveLastYearBadge, DueLabel, NoReorderConfirm, PreviewLock, PreviewTable, StaleDrafts, WhyPopover } from "../components/order-plan";
import { lockTeaser, previewRows, readOrderLink, shortDay, type LockTeaser, type PreviewRow } from "../lib/order-plan-shared";
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
  minimumWarnings,
  orderTotals,
  parseVariantsWithQty,
  productRuns,
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
  // Free: the read-only preview of the forward order plan and its totals, nothing else.
  if (!features.reorderPlan) {
    const plan = await loadOrderPlan(session.shop);
    return {
      ...EMPTY_REORDER,
      currency: plan.currency,
      enabled: false,
      preview: previewRows(plan),
      teaser: lockTeaser(plan),
    };
  }
  const url = new URL(request.url);
  // `?variants=id,id` (an action's "Add to order") or `id:qty,…` (older links).
  const { ids: selected, planned: fromUrl } = parseVariantsWithQty(url.searchParams.get("variants"));
  const scenario = url.searchParams.get("scenario");
  const fromScenario = scenario ? await scenarioPlanned(session.shop, scenario, url.searchParams.get("group")) : null;
  const planned = new Map([...fromUrl, ...(fromScenario ?? [])]);
  const link = readOrderLink(url.searchParams);
  const supplierKey = url.searchParams.get("supplier");
  const locations = features.locations ? await listPlanningLocations(session.shop) : [];
  const view = resolveScope(parseLocationParam(url.searchParams.get("location")), features.locations, locations);
  // Active locations: the switcher hides itself in a one-location store; transfers need two.
  const active = await activeLocationCount(session.shop);
  const transfersShown = showTransfers({ transfersEnabled: features.transfers, planningLocations: locations.length, activeLocations: active });
  const [reorder, transfers] = await Promise.all([
    loadReorder(session.shop, selected, view.scope, planned, new Date(), link),
    features.transfers && transfersShown ? loadTransfers(session.shop).then((x) => ({ enabled: true, ...x })) : Promise.resolve(LOCKED_TRANSFERS),
  ]);
  const only = supplierKey ? reorder.groups.find((g) => g.key === supplierKey) : undefined;
  return {
    ...reorder,
    groups: only ? [only] : reorder.groups,
    supplierFilter: only ? { key: only.key, name: only.name, kind: only.kind } : null,
    hiddenGroups: only ? reorder.groups.length - 1 : 0,
    linkRange: link && only ? { from: link.from, to: link.to } : null,
    scenarioMissing: !!scenario && fromScenario === null,
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

export type ReorderAction =
  | { ok: true; id: string; number: string }
  | { ok: false; error: "gone" | "empty" }
  | { ok: true; intent: "noReorder"; count: number }
  | { ok: false; intent: "noReorder"; error: "notFound" };

const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.reorderPlan) return upgradeResponse("reorderPlan", "The order plan is on the Growth plan.");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  if (body.intent === "noReorder") {
    // "Don't reorder this product" (confirmed in the UI): our database only.
    const value = body.value !== false;
    const target =
      typeof body.productId === "string" && PRODUCT_GID.test(body.productId)
        ? { productId: body.productId }
        : typeof body.variantId === "string" && VARIANT_GID.test(body.variantId)
          ? { variantId: body.variantId }
          : null;
    if (!target) throw new Response("Bad request", { status: 400 });
    const r = await setNoReorder(session.shop, target, value);
    return (r.ok ? { ok: true, intent: "noReorder", count: r.count } : { ok: false, intent: "noReorder", error: "notFound" }) satisfies ReorderAction;
  }
  if (body.intent !== "create" || typeof body.groupKey !== "string") throw new Response("Bad request", { status: 400 });
  const raw = body.quantities && typeof body.quantities === "object" ? (body.quantities as Record<string, unknown>) : {};
  const quantities: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw).slice(0, 5000)) if (VARIANT_GID.test(k)) quantities[k] = readQty(v);
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
  /** Free: the rest of the plan in numbers (the teaching lock). */
  teaser?: LockTeaser | null;
  /** `?supplier=` matched a group: only that group is shown. */
  supplierFilter?: { key: string; name: string; kind: "supplier" | "vendor" } | null;
  hiddenGroups?: number;
  /** The planned orders of a link's date range are shown (Next 90 days). */
  linkRange?: { from: string; to: string } | null;
  /** `?scenario=` isn't a saved Season plan of this store. */
  scenarioMissing?: boolean;
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
  const today = data.today ?? new Date().toISOString().slice(0, 10);
  if (!data.enabled) {
    return (
      <AppPage heading={t("Order plan")} intro={t("Your 10 most urgent products: how many days of stock are left, the date to order by and how many to order.")}>
        <OrderPlanTabs current="now" />
        <FormCard title={t("What to order, and by when")}>
          <PreviewTable rows={data.preview ?? []} />
          <PreviewLock teaser={data.teaser} currency={data.currency} />
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
          ? fill(t("What {location} needs to order in the next 7 days, from each supplier, each line on its own order-by date. Quantities include case packs and the supplier's minimums."), {
              location: location.name,
            })
          : t("Everything to order in the next 7 days, from each supplier, each line on its own order-by date. Quantities include case packs and the supplier's minimums.")
      }
    >
      {filter && (
        <s-banner tone="info">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>
              {data.linkRange
                ? fill(t("Showing {supplier}'s planned orders from {from} to {to}."), {
                    supplier: groupTitle(filter, t),
                    from: shortDay(data.linkRange.from, locale),
                    to: shortDay(data.linkRange.to, locale),
                  })
                : fill(t("Showing {supplier} only."), { supplier: groupTitle(filter, t) })}
            </s-text>
            {(data.hiddenGroups ?? 0) > 0 && <s-link {...link("/app/reorder")}>{t("Show all suppliers")}</s-link>}
          </s-stack>
        </s-banner>
      )}
      {anySelected && (
        <s-banner tone="info">
          {fromPlanner
            ? t("The products from your Season plan are highlighted, starting at the planned quantities.")
            : t("The products from your action list are highlighted.")}
        </s-banner>
      )}
      {data.missingSelected > 0 && (
        <s-banner tone="warning">{t("Some products from the link aren't tracked in your store any more.")}</s-banner>
      )}
      {data.scenarioMissing && <s-banner tone="warning">{t("This Season plan scenario no longer exists.")}</s-banner>}
      <StaleDrafts n={data.staleDrafts} />
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
            heading={t("Nothing to order today")}
            body={
              data.next
                ? fill(t("Next order: {supplier} by {date}."), {
                    supplier: data.next.kind === "supplier" ? data.next.name : data.next.name || t("No vendor"),
                    date: formatDay(data.next.orderBy, locale),
                  })
                : t("No orders needed in the next 90 days.")
            }
            action={<s-link {...link("/app/reorder/calendar")}>{t("See the next 90 days")}</s-link>}
          />
        </s-section>
      ) : (
        data.groups.map((g) => <GroupCard key={g.key} group={g} location={location} today={today} />)
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

/** Store amount, and the supplier's when its currency differs and the rate is known: "€1,200 · $1,300". */
function money(store: number | null, supplier: number | null, group: Pick<ReorderGroup, "currency" | "storeCurrency">, locale: string): string {
  const a = formatPrice(store, group.storeCurrency, locale);
  if (group.currency === group.storeCurrency || supplier === null || store === null) return a;
  return `${a} · ${formatPrice(supplier, group.currency, locale)}`;
}

function GroupCard({ group, location, today }: { group: ReorderGroup; location: PlanningLocation | null; today: string }) {
  const { t, locale } = useLocale();
  const navigate = useNavigate();
  const fetcher = useFetcher<ReorderAction>();
  const noReorder = useFetcher<ReorderAction>();
  // Lines that joined from "Can join this order" (client side until the order is created).
  const [joined, setJoined] = useState<string[]>([]);
  const lines = useMemo(() => [...group.lines, ...group.joinable.filter((l) => joined.includes(l.variantId))], [group, joined]);
  // Reset typed quantities only when the suggestions change, not on every loader revalidation.
  const resetKey = quantitiesKey(group.key, group.lines.map((l) => [l.variantId, l.suggested] as const));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => Object.fromEntries(group.lines.map((l) => [l.variantId, String(l.suggested)])), [resetKey]);
  const [qty, setQty] = useState<Record<string, string>>(initial);
  const [confirm, setConfirm] = useState(false);
  const [stop, setStop] = useState<ReorderLine | null>(null);
  useEffect(() => setQty(initial), [initial]);
  useEffect(() => {
    const d = fetcher.data;
    if (d && d.ok && "id" in d) navigate(`/app/reorder/${d.id}`);
  }, [fetcher.data, navigate]);

  const q = (id: string) => readQty(qty[id]);
  const totals = orderTotals(group, lines, q);
  const warn = minimumWarnings({ ...group, lines }, q);
  const title = groupTitle(group, t);
  const leadLabel = fill(group.leadTimeSource === "supplier" ? t("{n} days (supplier)") : t("{n} days (store default)"), {
    n: formatCount(group.leadTimeDays, locale),
  });
  const failed = fetcher.data && !fetcher.data.ok && "error" in fetcher.data ? fetcher.data.error : null;
  const costText = money(totals.cost, totals.supplierCost, group, locale);
  const runs = productRuns(lines);
  const join = (l: ReorderLine) => {
    setJoined((j) => [...j, l.variantId]);
    setQty((s) => ({ ...s, [l.variantId]: String(l.suggested) }));
  };
  const joinable = group.joinable.filter((l) => !joined.includes(l.variantId));

  return (
    <FormCard
      title={title}
      sub={`${t("Lead time")}: ${leadLabel} · ${t("Order by")}: ${formatDay(group.orderBy, locale)}`}
      action={
        group.kind === "vendor" || group.selected || group.overdue ? (
          <span className="keha-inline">
            {group.overdue && <s-badge tone="critical">{t("Overdue")}</s-badge>}
            {group.kind === "vendor" && <s-badge tone="neutral">{t("No supplier — grouped by vendor")}</s-badge>}
            {group.selected && (
              <s-badge tone="info">{group.lines.some((l) => l.fromPlanner) ? t("From your Season plan") : t("From your action list")}</s-badge>
            )}
          </span>
        ) : undefined
      }
    >
      <s-stack direction="block" gap="base">
        {group.styleToppedUp.length > 0 && group.minOrder && (
          <s-text color="subdued">
            {fill(t("Styles topped up to {supplier}'s minimum of {min} units per style, split across sizes by sales."), { supplier: title, min: formatCount(group.minOrder, locale) })}
          </s-text>
        )}
        {group.toppedUp && (
          <s-text color="subdued">
            {fill(t("Topped up to reach {supplier}'s minimum of {min} units."), {
              supplier: title,
              min: formatCount(group.minOrderTotal, locale),
            })}
          </s-text>
        )}
        {group.valueToppedUp && (
          <s-text color="subdued">
            {fill(t("Topped up to reach {supplier}'s minimum order value of {min}."), {
              supplier: title,
              min: formatPrice(group.minOrderValue, group.currency, locale),
            })}
          </s-text>
        )}
        {group.minOrderValue !== null && group.minOrderValueStore === null && (
          <s-text color="subdued">
            {fill(t("{supplier}'s minimum order value ({min}) isn't applied: add an exchange rate in Settings → Suppliers."), {
              supplier: title,
              min: formatPrice(group.minOrderValue, group.currency, locale),
            })}
          </s-text>
        )}
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("Product")}</s-table-header>
            <s-table-header listSlot="labeled">
              <HeaderLabel id={`keha-due-${group.key}`} label={t("Order by")} />
            </s-table-header>
            <s-table-header listSlot="labeled" format="numeric">{t("Stock now")}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">{t("Incoming")}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              <HeaderLabel id={`keha-left-${group.key}`} label={t("Days left")} hint={t("Days of stock left")} />
            </s-table-header>
            <s-table-header>{t("Quantity")}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">{t("Unit cost")}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">{t("Line total")}</s-table-header>
            <s-table-header>
              <HeaderLabel id={`keha-act-${group.key}`} label={t("Actions")} />
            </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {runs.flatMap((run) => {
              const rows = run.lines.map((l) => (
                <LineRow
                  key={l.variantId}
                  l={l}
                  group={group}
                  today={today}
                  value={qty[l.variantId] ?? ""}
                  belowMoq={warn.belowLine.includes(l.variantId)}
                  offPack={warn.notPack.includes(l.variantId)}
                  onChange={(v) => setQty((s) => ({ ...s, [l.variantId]: v }))}
                  onStop={() => setStop(l)}
                />
              ));
              if (run.lines.length < 2) return rows;
              const sub = orderTotals(group, run.lines, q);
              return [
                ...rows,
                <s-table-row key={`${run.productId}-subtotal`}>
                  <s-table-cell>
                    <s-text color="subdued">{fill(t("{product}: subtotal"), { product: run.title })}</s-text>
                  </s-table-cell>
                  <s-table-cell />
                  <s-table-cell />
                  <s-table-cell />
                  <s-table-cell />
                  <s-table-cell>
                    <s-text fontWeight="medium">{fill(t("{n} units"), { n: formatCount(sub.units, locale) })}</s-text>
                  </s-table-cell>
                  <s-table-cell />
                  <s-table-cell>
                    <s-text fontWeight="medium">{money(sub.cost, sub.supplierCost, group, locale)}</s-text>
                  </s-table-cell>
                  <s-table-cell />
                </s-table-row>,
              ];
            })}
          </s-table-body>
        </s-table>
        {joinable.length > 0 && <JoinList lines={joinable} group={group} today={today} onJoin={join} />}
        {warn.belowTotal && (
          <s-banner tone="warning">
            {fill(t("Below {supplier}'s minimum of {min} units."), { supplier: title, min: formatCount(group.minOrderTotal, locale) })}
          </s-banner>
        )}
        {warn.belowValue && (
          <s-banner tone="warning">
            {fill(t("Below {supplier}'s minimum order value of {min}."), { supplier: title, min: formatPrice(group.minOrderValue, group.currency, locale) })}
          </s-banner>
        )}
        {warn.belowStyle.length > 0 && (
          <s-banner tone="warning">
            {fill(t("{n} styles are below {supplier}'s minimum of {min} units per style."), {
              n: formatCount(warn.belowStyle.length, locale),
              supplier: title,
              min: formatCount(group.minOrder, locale),
            })}
          </s-banner>
        )}
        {failed === "gone" && <s-banner tone="warning">{t("This list changed. Reload the page and try again.")}</s-banner>}
        {failed === "empty" && <s-banner tone="warning">{t("Enter a quantity for at least one product.")}</s-banner>}
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-stack direction="block" gap="none">
            <s-text fontWeight="medium">
              {`${fill(t("Units: {n}"), { n: formatCount(totals.units, locale) })} · ${fill(t("Cost: {amount}"), { amount: costText })}`}
            </s-text>
            {totals.missingCost > 0 && (
              <s-text color="subdued">{fill(t("{n} lines without a cost price"), { n: formatCount(totals.missingCost, locale) })}</s-text>
            )}
          </s-stack>
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
          fill(t("{n} units, {cost}. Nothing is sent to the supplier until you email the order or mark it as sent."), {
            n: formatCount(totals.units, locale),
            cost: costText,
          }),
          totals.missingCost > 0 ? fill(t("{n} lines without a cost price are not in this total."), { n: formatCount(totals.missingCost, locale) }) : null,
          location ? fill(t("The order notes that it is for {location}."), { location: location.name }) : null,
        ]
          .filter(Boolean)
          .join(" ")}
        confirmLabel={t("Create order")}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          const quantities = Object.fromEntries(lines.map((l) => [l.variantId, q(l.variantId)]));
          const body = { intent: "create", groupKey: group.key, quantities, ...(location ? { location: locationNumericId(location.id) } : {}) };
          fetcher.submit(body as never, { method: "post", encType: "application/json" });
        }}
      />
      <NoReorderConfirm
        open={!!stop}
        name={stop?.productTitle ?? ""}
        value
        scope="product"
        onCancel={() => setStop(null)}
        onConfirm={() => {
          const l = stop;
          setStop(null);
          if (l) noReorder.submit({ intent: "noReorder", productId: l.productId, value: true } as never, { method: "post", encType: "application/json" });
        }}
      />
    </FormCard>
  );
}

/** "Can join this order": the supplier's lines due before its next order, collapsed. */
function JoinList({ lines, group, today, onJoin }: { lines: ReorderLine[]; group: ReorderGroup; today: string; onJoin: (l: ReorderLine) => void }) {
  const { t, locale } = useLocale();
  const [open, setOpen] = useState(false);
  const id = `keha-join-${group.key}`;
  return (
    <s-box padding="small" border="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <button type="button" className="keha-disclosure" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          <s-stack direction="block" gap="none">
            <s-text fontWeight="medium">{fill(t("Can join this order ({n})"), { n: formatCount(lines.length, locale) })}</s-text>
            <s-text color="subdued">{t("Due before this supplier's next order — add them to send one order instead of two.")}</s-text>
          </s-stack>
          <s-icon type={open ? "chevron-up" : "chevron-down"} />
        </button>
        {open && (
          <div id={id}>
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">{t("Product")}</s-table-header>
                <s-table-header listSlot="labeled">
                  <HeaderLabel id={`${id}-by`} label={t("Order by")} />
                </s-table-header>
                <s-table-header listSlot="labeled" format="numeric">{t("Quantity")}</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">{t("Line total")}</s-table-header>
                <s-table-header>
                  <HeaderLabel id={`${id}-add`} label={t("Actions")} />
                </s-table-header>
              </s-table-header-row>
              <s-table-body>
                {lines.map((l) => {
                  const variant = variantName(l.variantTitle);
                  return (
                    <s-table-row key={l.variantId}>
                      <s-table-cell>
                        <s-stack direction="block" gap="none">
                          <s-text fontWeight="medium">{l.productTitle}</s-text>
                          {variant && <s-text color="subdued">{variant}</s-text>}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <DueLabel deadline={l.orderBy} overdue={l.overdue} today={today} />
                      </s-table-cell>
                      <s-table-cell>{formatCount(l.suggested, locale)}</s-table-cell>
                      <s-table-cell>{formatPrice(l.unitCostStore === null ? null : l.unitCostStore * l.suggested, group.storeCurrency, locale)}</s-table-cell>
                      <s-table-cell>
                        <s-button variant="secondary" onClick={() => onJoin(l)} accessibilityLabel={`${t("Add to this order")}: ${[l.productTitle, variant].filter(Boolean).join(" — ")}`}>
                          {t("Add to this order")}
                        </s-button>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          </div>
        )}
      </s-stack>
    </s-box>
  );
}

function LineRow({
  l,
  group,
  today,
  value,
  belowMoq,
  offPack,
  onChange,
  onStop,
}: {
  l: ReorderLine;
  group: ReorderGroup;
  today: string;
  value: string;
  belowMoq: boolean;
  offPack: boolean;
  onChange: (v: string) => void;
  onStop: () => void;
}) {
  const { t, locale } = useLocale();
  const variant = variantName(l.variantTitle);
  const sub = [variant, l.sku].filter(Boolean).join(" · ");
  const n = readQty(value);
  const name = [l.productTitle, variant].filter(Boolean).join(" — ");
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
  const unitSupplier = group.currency !== group.storeCurrency ? l.unitCost : null;
  const menuId = `keha-line-menu-${l.variantId.replace(/\D/g, "")}`;
  return (
    <s-table-row>
      <s-table-cell>
        <div className="keha-cell-product">
          <ProductThumb src={l.image} alt={l.productTitle} size={40} />
          <s-stack direction="block" gap="none">
            <s-text fontWeight="medium">{l.productTitle}</s-text>
            {sub && <s-text color="subdued">{sub}</s-text>}
            {l.selected && <s-badge tone="info">{l.fromPlanner ? t("From your Season plan") : t("From your action list")}</s-badge>}
            {l.noReorder && <s-badge tone="neutral">{t("Not reordered")}</s-badge>}
          </s-stack>
        </div>
      </s-table-cell>
      <s-table-cell>
        <DueLabel deadline={l.orderBy} overdue={l.overdue} today={today} />
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
        <s-stack direction="block" gap="small-200">
          <s-number-field
            label={fill(t("Quantity for {product}"), { product: name })}
            labelAccessibilityVisibility="exclusive"
            value={value}
            min={0}
            step={1}
            details={details || undefined}
            error={error}
            onInput={(e) => onChange(val(e))}
          />
          <AboveLastYearBadge qty={l.suggested} lastYear={l.lastYear} />
        </s-stack>
      </s-table-cell>
      <s-table-cell>{money(l.unitCostStore, unitSupplier, group, locale)}</s-table-cell>
      <s-table-cell>{money(l.unitCostStore === null || n === 0 ? null : l.unitCostStore * n, unitSupplier === null || n === 0 ? null : unitSupplier * n, group, locale)}</s-table-cell>
      <s-table-cell>
        <span className="keha-inline">
          <WhyPopover id={`keha-why-${l.variantId.replace(/\D/g, "")}`} title={name} whys={l.why} lastYear={l.lastYear} qty={l.suggested} today={today} />
          <s-button variant="tertiary" icon="menu-horizontal" commandFor={menuId} accessibilityLabel={`${t("More actions")}: ${name}`} />
          <s-menu id={menuId} accessibilityLabel={t("More actions")}>
            <s-button onClick={onStop}>{t("Don't reorder this product")}</s-button>
          </s-menu>
        </span>
      </s-table-cell>
    </s-table-row>
  );
}
