/**
 * Products (/app/products) — spec §5.2. One row per variant, 50 per page
 * (server-side, URL params), filters for status / collection / vendor and a
 * search. Forecast columns (days left, order by, suggested qty) are the
 * Growth `forecast` feature: on Free they stay visible but locked and empty
 * (plan locks teach, they don't hide). CSV export is Growth (`csvExport`).
 */
import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getEntitlements } from "../services/entitlements.server";
import { listProducts, productFilterOptions } from "../models/products.server";
import { listPlanningLocations } from "../models/locations.server";
import { LocationSwitcher } from "../components/location-switcher";
import { AppPage, ProductThumb } from "../components/ui";
import { SelectField, flag, useLinkProps, val } from "../components/wc";
import { UpgradeBanner, planTag } from "../components/plan";
import { fill, useLocale } from "../lib/i18n";
import { formatCount, formatDay } from "../lib/dashboard-shared";
import {
  STATUS_ORDER,
  daysLeftView,
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
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  const url = new URL(request.url);
  const filters = parseFilters(url.searchParams);
  // Location view (Pro): ?location is ignored below Pro and for anything but a warehouse / store.
  const locations = features.locations ? await listPlanningLocations(session.shop) : [];
  const view = resolveScope(parseLocationParam(url.searchParams.get("location")), features.locations, locations);
  const [page, options] = await Promise.all([
    listProducts(session.shop, filters, parsePage(url.searchParams), features.forecast, view.scope),
    productFilterOptions(session.shop),
  ]);
  return {
    ...page,
    filters,
    options,
    forecast: features.forecast,
    csv: features.csvExport,
    locationsEnabled: features.locations,
    locations,
    location: view.location,
  };
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export type ProductsData = {
  rows: ProductRow[];
  total: number;
  info: PageInfo;
  filters: ProductFilters;
  options: { vendors: string[]; collections: string[] };
  forecast: boolean;
  csv: boolean;
  /** Pro `locations`: the switcher works (otherwise shown locked). */
  locationsEnabled: boolean;
  /** Active warehouses and stores (empty below Pro). */
  locations: PlanningLocation[];
  /** The location shown; null = the online stock pool. */
  location: PlanningLocation | null;
};

type FilterKey = "status" | "collection" | "vendor" | "q";

export default function Products() {
  const { t, locale } = useLocale();
  const data = useLoaderData<typeof loader>() as ProductsData;
  const [params, setParams] = useSearchParams();
  const navigation = useNavigation();
  const { rows, info, total, filters, options, forecast, location } = data;
  // What "Stock now" / "Incoming" cover: the online stock pool, or the one location shown.
  const stockScope = location
    ? fill(t("Stock at {location} only."), { location: location.name })
    : t("Online stock pool: active locations that fulfil online orders.");

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
  const anyFilter = !!(filters.status || filters.collection || filters.vendor || filters.q);
  const locked = !forecast;

  const lockedHead = (label: string) => (
    <s-table-header>
      {locked ? (
        <s-stack direction="inline" gap="small-100" alignItems="center">
          <span>{label}</span>
          <s-badge icon="lock" tone="info">
            {planTag("forecast", t)}
          </s-badge>
        </s-stack>
      ) : (
        label
      )}
    </s-table-header>
  );

  return (
    <AppPage
      heading={t("Products")}
      intro={
        location
          ? `${t("One row per variant this location carries. Sales per day are this location's own sales, counted only on the days it had the variant in stock.")} ${stockScope}`
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
          <div slot="filters" className="keha-filters">
            <LocationSwitcher enabled={data.locationsEnabled} locations={data.locations} current={location} />
            <s-search-field
              label={t("Search")}
              labelAccessibilityVisibility="exclusive"
              placeholder={t("Search by product, variant or SKU")}
              value={filters.q ?? ""}
              onChange={(e) => apply({ q: val(e).trim() })}
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
          </div>
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("Product")}</s-table-header>
            <s-table-header listSlot="secondary">{t("Status")}</s-table-header>
            <s-table-header listSlot="labeled">
              <s-text interestFor="keha-pool-stock">{t("Stock now")}</s-text>
              <s-tooltip id="keha-pool-stock">{stockScope}</s-tooltip>
            </s-table-header>
            <s-table-header listSlot="labeled">
              <s-text interestFor="keha-pool-incoming">{t("Incoming")}</s-text>
              <s-tooltip id="keha-pool-incoming">{stockScope}</s-tooltip>
            </s-table-header>
            <s-table-header listSlot="labeled">{t("Sales per day while in stock")}</s-table-header>
            {lockedHead(t("Days of stock left"))}
            {lockedHead(t("Order by"))}
            {lockedHead(t("Suggested qty"))}
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => (
              <Row key={r.id} r={r} locked={locked} locale={locale} />
            ))}
          </s-table-body>
        </s-table>
        {rows.length === 0 && (
          <s-box padding="base">
            <s-stack direction="block" gap="small" alignItems="center">
              <s-paragraph color="subdued">
                {anyFilter
                  ? t("No variants match these filters.")
                  : location
                    ? t("No numbers for this location yet. They appear after the next nightly refresh, for the products it stocks.")
                    : t("Your products appear here once your catalog is read.")}
              </s-paragraph>
              {anyFilter && (
                <s-button variant="secondary" onClick={() => apply({ status: "", collection: "", vendor: "", q: "" })}>
                  {t("Clear filters")}
                </s-button>
              )}
            </s-stack>
          </s-box>
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
  const variant = variantName(r.variantTitle);
  const sub = [variant, r.sku].filter(Boolean).join(" · ");
  const left = daysLeftView(r);
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
            <s-text color="subdued">{fill(t("+{n} on order with Keha"), { n: formatCount(r.onOrder, locale) })}</s-text>
          </s-stack>
        ) : (
          formatCount(r.incoming, locale)
        )}
      </s-table-cell>
      <s-table-cell>{formatRate(r.rate, locale)}</s-table-cell>
      <s-table-cell>
        {locked ? (
          ""
        ) : left.kind === "never" ? (
          <span role="img" aria-label={t("Never runs out at current sales")}>
            ∞
          </span>
        ) : left.kind === "days" ? (
          formatCount(left.days, locale)
        ) : (
          "—"
        )}
      </s-table-cell>
      <s-table-cell>{locked ? "" : formatDay(r.orderBy, locale)}</s-table-cell>
      <s-table-cell>{locked ? "" : formatCount(r.orderQty, locale)}</s-table-cell>
    </s-table-row>
  );
}

/**
 * CSV export. Growth: downloads the filtered table (fetch, so App Bridge adds
 * the session token). Free: the same button names the plan and opens Plans.
 */
function CsvButton({ enabled, filters, location }: { enabled: boolean; filters: ProductFilters; location: PlanningLocation | null }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!enabled) {
    return (
      <s-button icon="lock" {...link("/app/plans?upgrade=csvExport")}>
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
    <s-button icon="export" loading={flag(busy)} onClick={download} accessibilityLabel={failed ? t("The export didn't work. Try again.") : undefined}>
      {failed ? t("Try again") : t("Export CSV")}
    </s-button>
  );
}
