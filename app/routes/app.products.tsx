/**
 * Products (/app/products) — spec §5.2. One row per variant, 50 per page
 * (server-side, URL params), filters for status / collection / vendor /
 * product type / supplier and a search. Forecast columns (days left, order by, to order) are
 * the Growth `forecast` feature: on Free they stay visible but locked and empty
 * (plan locks teach, they don't hide). CSV export is Growth (`csvExport`).
 *
 * "Suggested qty" and "Order by" come from the forward plan — the same orders as
 * Order now (ordering audit 2026-10-17) — and the table is sorted by order-by
 * date by default (forecast on). Row action: "Don't reorder" (with a confirm;
 * our database only): the variant or product leaves every order and shows
 * "Not reordered"; it stays in the stock numbers.
 */
import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateApp } from "../services/data-scope.server";
import { getEntitlements } from "../services/entitlements.server";
import { listProducts, productFilterOptions, supplierFilterOptions } from "../models/products.server";
import { setNoReorder } from "../models/reorder.server";
import { NoReorderConfirm, OrderByCell } from "../components/order-plan";
import { activeLocations, listPlanningLocations } from "../models/locations.server";
import { LocationSwitcher } from "../components/location-switcher";
import { AppPage, DaysLeft, EmptyState, HeaderLabel, ProductThumb, Toolbar } from "../components/ui";
import { productsHelp } from "../components/help";
import { SelectField, flag, useLinkProps, val } from "../components/wc";
import { UpgradeBanner, planName, planTag } from "../components/plan";
import { requiredPlan } from "../lib/plan-shared";
import { fill, useLocale } from "../lib/i18n";
import { formatCount } from "../lib/dashboard-shared";
import {
  STATUS_ORDER,
  filtersToParams,
  formatRate,
  parseFilters,
  parsePage,
  statusLabel,
  statusTone,
  variantName,
  type PageInfo,
  type ProductFilters,
  type ProductRow,
} from "../lib/products-shared";
import { locationNumericId, parseLocationParam, resolveScope, type PlanningLocation } from "../lib/locations-shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  const url = new URL(request.url);
  const filters = parseFilters(url.searchParams);
  // Location view (Pro): ?location is ignored below Pro and for anything but a warehouse / store.
  // The store's location count decides whether the switcher shows at all (one location: no).
  const [locations, active] = await Promise.all([
    features.locations ? listPlanningLocations(shop) : Promise.resolve([]),
    activeLocations(shop),
  ]);
  const view = resolveScope(parseLocationParam(url.searchParams.get("location")), features.locations, locations);
  const [page, options, suppliers] = await Promise.all([
    listProducts(shop, filters, parsePage(url.searchParams), features.forecast, view.scope),
    productFilterOptions(shop),
    supplierFilterOptions(shop),
  ]);
  return {
    ...page,
    filters,
    options: { ...options, suppliers },
    forecast: features.forecast,
    csv: features.csvExport,
    locationsEnabled: features.locations,
    locations,
    location: view.location,
    locationCount: active.length,
  };
};

const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

export type ProductsAction = { ok: true; count: number } | { ok: false };

/** "Don't reorder" / "Reorder again" for a variant or its whole product (confirmed in the UI; our database only). */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticateApp(request);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  if (body.intent !== "noReorder") throw new Response("Bad request", { status: 400 });
  const target =
    typeof body.productId === "string" && PRODUCT_GID.test(body.productId)
      ? { productId: body.productId }
      : typeof body.variantId === "string" && VARIANT_GID.test(body.variantId)
        ? { variantId: body.variantId }
        : null;
  if (!target) throw new Response("Bad request", { status: 400 });
  return (await setNoReorder(shop, target, body.value !== false)) satisfies ProductsAction;
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export type ProductsData = {
  rows: ProductRow[];
  total: number;
  info: PageInfo;
  filters: ProductFilters;
  options: { vendors: string[]; collections: string[]; productTypes?: string[]; suppliers?: { id: string; name: string }[] };
  forecast: boolean;
  csv: boolean;
  /** Pro `locations`: the switcher works (otherwise shown locked). */
  locationsEnabled: boolean;
  /** Active warehouses and stores (empty below Pro). */
  locations: PlanningLocation[];
  /** The location shown; null = the online stock pool. */
  location: PlanningLocation | null;
  /** Active locations in the store (any role): fewer than 2 hides the switcher. */
  locationCount: number;
};

type FilterKey = "status" | "collection" | "vendor" | "type" | "q" | "supplier" | "sort";

export default function Products() {
  const { t, locale } = useLocale();
  const data = useLoaderData<typeof loader>() as ProductsData;
  const [params, setParams] = useSearchParams();
  const navigation = useNavigation();
  const { rows, info, total, filters, options, forecast, location } = data;
  // What "On hand" / "Incoming" cover: the stock counted in supplier orders, or the one location shown.
  const stockScope = location
    ? fill(t("Stock at {location} only."), { location: location.name })
    : t("Stock included in purchase orders: every active location unless you left it out in Settings → Locations.");

  const apply = (patch: Partial<Record<FilterKey, string>>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete("page");
    setParams(next);
  };
  const goPage = (page: number) => {
    const next = new URLSearchParams(params);
    if (page <= 1) next.delete("page");
    else next.set("page", String(page));
    setParams(next);
  };
  const anyFilter = !!(filters.status || filters.collection || filters.vendor || filters.productType || filters.q || filters.supplier);
  const suppliers = options.suppliers ?? [];
  const productTypes = options.productTypes ?? [];
  const locked = !forecast;

  // Forecast columns on Free: the short label plus a compact lock badge with the plan name.
  const lockBadge = locked ? (
    <s-badge icon="lock" tone="info">
      {planName(requiredPlan("forecast"), t)}
    </s-badge>
  ) : undefined;

  return (
    <AppPage
      heading={t("Products")}
      help={productsHelp(t)}
      intro={
        location
          ? location.role === "warehouse" && location.inPool
            ? `${t("One row per variant this warehouse carries. Shopify doesn't report which warehouse shipped an online order, so its sales per day are its share of online sales by the stock it holds. Purchase orders are planned once for every included warehouse.")} ${stockScope}`
            : `${t("One row per variant this location carries. Sales per day are this location's own sales, counted only on the days it had the variant in stock.")} ${stockScope}`
          : `${t("One row per variant. Sales per day count only the days the variant was in stock.")} ${stockScope}`
      }
      secondaryActions={[<CsvButton key="csv" enabled={data.csv} filters={filters} location={location} />]}
    >
      {locked && <UpgradeBanner feature="forecast" />}

      <s-section padding="none" accessibilityLabel={t("Products")}>
        <s-table
          paginate={flag(info.pageCount > 1)}
          hasPreviousPage={flag(info.hasPrev)}
          hasNextPage={flag(info.hasNext)}
          onPreviousPage={() => goPage(info.page - 1)}
          onNextPage={() => goPage(info.page + 1)}
          loading={flag(navigation.state === "loading")}
        >
          <Toolbar
            slot="filters"
            search={
              <s-search-field
                label={t("Search")}
                labelAccessibilityVisibility="exclusive"
                placeholder={t("Product, variant or SKU")}
                value={filters.q ?? ""}
                onChange={(e) => apply({ q: val(e).trim() })}
              />
            }
            filters={
              <>
                <LocationSwitcher
                  enabled={data.locationsEnabled}
                  locations={data.locations}
                  current={location}
                  locationCount={data.locationCount}
                />
                <SelectField
                  label={t("Status")}
                  labelHidden
                  value={filters.status ?? ""}
                  options={[
                    { value: "", label: t("All statuses") },
                    ...STATUS_ORDER.map((s) => ({ value: s, label: statusLabel(s, t) })),
                  ]}
                  onChange={(v) => apply({ status: v })}
                />
                {options.collections.length > 0 && (
                  <SelectField
                    label={t("Collection")}
                    labelHidden
                    value={filters.collection ?? ""}
                    options={[{ value: "", label: t("All collections") }, ...options.collections.map((c) => ({ value: c, label: c }))]}
                    onChange={(v) => apply({ collection: v })}
                  />
                )}
                {options.vendors.length > 0 && (
                  <SelectField
                    label={t("Vendor")}
                    labelHidden
                    value={filters.vendor ?? ""}
                    options={[{ value: "", label: t("All vendors") }, ...options.vendors.map((v) => ({ value: v, label: v }))]}
                    onChange={(v) => apply({ vendor: v })}
                  />
                )}
                {productTypes.length > 0 && (
                  <SelectField
                    label={t("Product type")}
                    labelHidden
                    value={filters.productType ?? ""}
                    options={[{ value: "", label: t("All product types") }, ...productTypes.map((v) => ({ value: v, label: v }))]}
                    onChange={(v) => apply({ type: v })}
                  />
                )}
                {suppliers.length > 0 && (
                  <SelectField
                    label={t("Supplier")}
                    labelHidden
                    value={filters.supplier ?? ""}
                    options={[
                      { value: "", label: t("All suppliers") },
                      ...suppliers.map((x) => ({ value: x.id, label: x.name })),
                      { value: "none", label: t("No supplier") },
                    ]}
                    onChange={(v) => apply({ supplier: v })}
                  />
                )}
                {forecast && (
                  <SelectField
                    label={t("Sort")}
                    labelHidden
                    value={filters.sort === "title" ? "title" : "orderBy"}
                    options={[
                      { value: "orderBy", label: t("Sort: order-by date") },
                      { value: "title", label: t("Sort: product name") },
                    ]}
                    onChange={(v) => apply({ sort: v === "title" ? "title" : "" })}
                  />
                )}
              </>
            }
          />
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("Product")}</s-table-header>
            <s-table-header listSlot="secondary">{t("Status")}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              <HeaderLabel id="keha-pool-stock" label={t("On hand")} hint={stockScope} />
            </s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              <HeaderLabel id="keha-pool-incoming" label={t("Incoming")} hint={stockScope} />
            </s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              <HeaderLabel id="keha-col-rate" label={t("Daily sales")} hint={t("Sales per day while in stock")} />
            </s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              <HeaderLabel id="keha-col-left" label={t("Days of stock")} hint={t("How many days the stock lasts at the forecast sales")} badge={lockBadge} />
            </s-table-header>
            <s-table-header listSlot="labeled">
              <HeaderLabel id="keha-col-by" label={t("Order by")} badge={lockBadge} />
            </s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              <HeaderLabel id="keha-col-qty" label={t("Suggested qty")} hint={t("The next planned order (the same as Due now)")} badge={lockBadge} />
            </s-table-header>
            <s-table-header>
              <HeaderLabel id="keha-col-act" label={t("Actions")} />
            </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => (
              <Row key={r.id} r={r} locked={locked} locale={locale} />
            ))}
          </s-table-body>
        </s-table>
        {rows.length === 0 && (
          <EmptyState
            body={
              anyFilter
                ? t("No variants match these filters.")
                : location
                  ? t("No numbers for this location yet. They appear after the next nightly refresh, for the products it stocks.")
                  : t("Your products appear here once your catalog is read.")
            }
            action={
              anyFilter ? (
                <s-button variant="secondary" onClick={() => apply({ status: "", collection: "", vendor: "", type: "", supplier: "", q: "" })}>
                  {t("Clear filters")}
                </s-button>
              ) : undefined
            }
          />
        )}
      </s-section>

      {total > 0 && (
        <s-text color="subdued">
          {fill(t("Page {page} of {pages} · Variants: {total}"), {
            page: info.page,
            pages: info.pageCount,
            total: formatCount(total, locale),
          })}
        </s-text>
      )}
    </AppPage>
  );
}

function Row({ r, locked, locale }: { r: ProductRow; locked: boolean; locale: string }) {
  const { t } = useLocale();
  const link = useLinkProps();
  const fetcher = useFetcher<ProductsAction>();
  const [ask, setAsk] = useState<null | { scope: "product" | "variant"; value: boolean }>(null);
  const variant = variantName(r.variantTitle);
  const sub = [variant, r.sku].filter(Boolean).join(" · ");
  const name = [r.productTitle, variant].filter(Boolean).join(" — ");
  const menuId = `keha-prod-menu-${r.numericId}`;
  return (
    <s-table-row>
      <s-table-cell>
        <div className="keha-cell-product">
          <ProductThumb src={r.image} alt={r.productTitle} size={40} />
          <s-stack direction="block" gap="none">
            <s-link {...link(`/app/products/${r.numericId}`)}>{r.productTitle}</s-link>
            {sub && <s-text color="subdued">{sub}</s-text>}
          </s-stack>
        </div>
      </s-table-cell>
      <s-table-cell>{r.status ? <s-badge tone={statusTone(r.status)}>{statusLabel(r.status, t)}</s-badge> : "—"}</s-table-cell>
      <s-table-cell>{formatCount(r.onHand, locale)}</s-table-cell>
      <s-table-cell>
        {r.onOrder > 0 ? (
          <s-stack direction="block" gap="none">
            <span>{formatCount(r.incoming, locale)}</span>
            <span className="keha-nowrap">
              <s-text color="subdued">{fill(t("+{n} on order"), { n: formatCount(r.onOrder, locale) })}</s-text>
            </span>
          </s-stack>
        ) : (
          formatCount(r.incoming, locale)
        )}
      </s-table-cell>
      <s-table-cell>{formatRate(r.rate, locale)}</s-table-cell>
      <s-table-cell>
        {locked ? "" : <DaysLeft id={`keha-left-${r.numericId}`} daysLeft={r.daysLeft} neverRunsOut={r.neverRunsOut} />}
      </s-table-cell>
      <s-table-cell>
        {locked ? (
          ""
        ) : (
          <OrderByCell orderBy={r.orderBy} overdue={!!r.overdue} note={r.dueNote ?? null} />
        )}
      </s-table-cell>
      <s-table-cell>{locked ? "" : r.noReorder ? <s-badge tone="neutral">{t("Don't reorder")}</s-badge> : formatCount(r.orderQty, locale)}</s-table-cell>
      <s-table-cell>
        <s-button variant="tertiary" icon="menu-horizontal" commandFor={menuId} accessibilityLabel={`${t("More actions")}: ${name}`} />
        <s-menu id={menuId} accessibilityLabel={t("More actions")}>
          {r.noReorder ? (
            <s-button onClick={() => setAsk({ scope: "variant", value: false })}>{t("Reorder again")}</s-button>
          ) : (
            <>
              <s-button onClick={() => setAsk({ scope: "variant", value: true })}>{t("Don't reorder this variant")}</s-button>
              {r.productId && <s-button onClick={() => setAsk({ scope: "product", value: true })}>{t("Don't reorder this product")}</s-button>}
            </>
          )}
        </s-menu>
        <NoReorderConfirm
          open={!!ask}
          name={ask?.scope === "product" ? r.productTitle : name}
          value={ask?.value ?? true}
          scope={ask?.scope ?? "variant"}
          onCancel={() => setAsk(null)}
          onConfirm={() => {
            const a = ask;
            setAsk(null);
            if (!a) return;
            const target = a.scope === "product" && r.productId ? { productId: r.productId } : { variantId: r.id };
            fetcher.submit({ intent: "noReorder", ...target, value: a.value } as never, { method: "post", encType: "application/json" });
          }}
        />
      </s-table-cell>
    </s-table-row>
  );
}

/**
 * CSV export. Growth: downloads the filtered table (fetch, so App Bridge adds
 * the session token). Free: the same button names the plan and opens Plans.
 * A title-bar action: AppPage sets `slot`, which must reach the <s-button>
 * (without it the button rendered as page content, above the intro).
 */
function CsvButton({
  enabled,
  filters,
  location,
  slot,
}: {
  enabled: boolean;
  filters: ProductFilters;
  location: PlanningLocation | null;
  slot?: Lowercase<string>;
}) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!enabled) {
    return (
      <s-button slot={slot} icon="lock" {...link("/app/plans?upgrade=csvExport")}>
        {`${t("Export CSV")} · ${planTag("csvExport", t)}`}
      </s-button>
    );
  }
  const download = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const q = filtersToParams(filters);
      q.set("lang", locale);
      if (location) q.set("location", locationNumericId(location.id));
      const res = await fetch(`/app/products/csv?${q.toString()}`);
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "products.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <s-button slot={slot} icon="export" loading={flag(busy)} onClick={download} accessibilityLabel={failed ? t("The export didn't work. Try again.") : undefined}>
      {failed ? t("Try again") : t("Export CSV")}
    </s-button>
  );
}
