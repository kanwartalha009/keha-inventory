/**
 * Variant detail (/app/products/:variantId) — spec §5.2 row detail. A page
 * rather than a drawer: simpler to reach by keyboard and screen reader, and
 * linkable. 13 months of daily sales with sold-out days shaded (inline SVG
 * with an aria-label and a month table as its text fallback), how the
 * forecast was built (VariantMetric.inputs) and the last 14 days of sales.
 */
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getEntitlements } from "../services/entitlements.server";
import { getVariantDetail } from "../models/products.server";
import { AppPage, KvRow, ProductThumb } from "../components/ui";
import { UpgradeBanner, planTag } from "../components/plan";
import { fill, useLocale } from "../lib/i18n";
import { formatCount, formatDay } from "../lib/dashboard-shared";
import {
  dailySeries,
  daysLeftView,
  formatRate,
  isNeutralMultiplier,
  monthlyTotals,
  readForecastInputs,
  recentDays,
  statusLabel,
  statusTone,
  variantGid,
  variantName,
  type ChartDay,
  type ForecastInputsView,
  type MonthTotal,
  type ProductRow,
} from "../lib/products-shared";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const gid = variantGid(params.variantId ?? "");
  if (!gid) throw new Response("Not found", { status: 404 });
  const { features } = await getEntitlements(session.shop);
  const detail = await getVariantDetail(session.shop, gid, features.forecast);
  if (!detail) throw new Response("Not found", { status: 404 });
  const series = dailySeries(detail.sales, detail.stock, detail.today);
  const inputs = readForecastInputs(detail.inputs, detail.sigma);
  return {
    row: detail.row,
    vendor: detail.variant.vendor,
    series,
    months: monthlyTotals(series),
    recent: recentDays(series, 14),
    // Lead time, safety stock and the order cycle are part of the Growth forecast.
    inputs: inputs && !features.forecast ? { ...inputs, leadTimeDays: null, leadTimeSource: null, cycleDays: null, z: null, safety: null } : inputs,
    forecast: features.forecast,
  };
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export type VariantDetailData = {
  row: ProductRow;
  vendor: string | null;
  series: ChartDay[];
  months: MonthTotal[];
  recent: ChartDay[];
  inputs: ForecastInputsView | null;
  forecast: boolean;
};

export default function VariantDetailPage() {
  const { t, locale } = useLocale();
  const data = useLoaderData<typeof loader>() as VariantDetailData;
  const { row, forecast } = data;
  const variant = variantName(row.variantTitle);
  const left = daysLeftView(row);
  const locked = planTag("forecast", t);

  return (
    <AppPage
      heading={row.productTitle}
      breadcrumb={{ label: t("Products"), to: "/app/products" }}
      meta={row.status ? <s-badge tone={statusTone(row.status)}>{statusLabel(row.status, t)}</s-badge> : undefined}
      intro={[variant, row.sku, data.vendor].filter(Boolean).join(" · ") || undefined}
    >
      {!forecast && <UpgradeBanner feature="forecast" />}

      <s-section>
        <div className="keha-cell-product">
          <ProductThumb src={row.image} alt={row.productTitle} size={48} />
          <div className="keha-kv keha-kv--flush keha-grow">
            <s-text color="subdued">{t("Online stock pool: active locations that fulfil online orders.")}</s-text>
            <KvRow label={t("Stock now")} value={formatCount(row.onHand, locale)} />
            <KvRow label={t("Incoming")} value={formatCount(row.incoming, locale)} />
            <KvRow label={t("Sales per day while in stock")} value={formatRate(row.rate, locale)} />
            <KvRow
              label={t("Days of stock left")}
              value={
                !forecast ? (
                  locked
                ) : left.kind === "never" ? (
                  <span role="img" aria-label={t("Never runs out at current sales")}>
                    ∞
                  </span>
                ) : left.kind === "days" ? (
                  formatCount(left.days, locale)
                ) : (
                  "—"
                )
              }
            />
            <KvRow label={t("Order by")} value={forecast ? formatDay(row.orderBy, locale) : locked} />
            <KvRow label={t("Suggested qty")} value={forecast ? formatCount(row.orderQty, locale) : locked} />
          </div>
        </div>
      </s-section>

      <SalesChart series={data.series} months={data.months} />
      <ForecastInputs inputs={data.inputs} forecast={forecast} />
      <RecentSales recent={data.recent} />
    </AppPage>
  );
}

const BAR_W = 2;
const CHART_H = 120;

function SalesChart({ series, months }: { series: ChartDay[]; months: MonthTotal[] }) {
  const { t, locale } = useLocale();
  const max = Math.max(1, ...series.map((d) => d.sold ?? 0));
  const outDays = series.filter((d) => d.out).length;
  const hasData = series.some((d) => d.sold !== null || d.out !== null);
  const label = fill(t("Units sold per day over the last 13 months. Sold-out days are shaded: {n}."), {
    n: formatCount(outDays, locale),
  });
  return (
    <s-section heading={t("Sales, last 13 months")}>
      <s-stack direction="block" gap="base">
        {hasData ? (
          <>
            <svg
              className="keha-chart"
              viewBox={`0 0 ${series.length * BAR_W} ${CHART_H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={label}
            >
              {series.map((d, i) =>
                d.out ? <rect key={`o${d.day}`} className="keha-chart__out" x={i * BAR_W} y={0} width={BAR_W} height={CHART_H} /> : null,
              )}
              {series.map((d, i) => {
                if (!d.sold || d.sold <= 0) return null;
                const h = Math.max(1, (d.sold / max) * (CHART_H - 4));
                return <rect key={`s${d.day}`} className="keha-chart__bar" x={i * BAR_W} y={CHART_H - h} width={BAR_W * 0.8} height={h} />;
              })}
            </svg>
            <s-stack direction="inline" gap="base">
              <span className="keha-legend">
                <span className="keha-legend__swatch keha-legend__swatch--bar" aria-hidden="true" />
                <s-text color="subdued">{t("Units sold")}</s-text>
              </span>
              <span className="keha-legend">
                <span className="keha-legend__swatch keha-legend__swatch--out" aria-hidden="true" />
                <s-text color="subdued">{t("Sold out")}</s-text>
              </span>
            </s-stack>
          </>
        ) : (
          <s-paragraph color="subdued">{t("No sales or stock history read for this variant yet.")}</s-paragraph>
        )}
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("Month")}</s-table-header>
            <s-table-header>{t("Units sold")}</s-table-header>
            <s-table-header>{t("Sold-out days")}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {months.map((m) => (
              <s-table-row key={m.month}>
                <s-table-cell>{monthName(m.month, locale)}</s-table-cell>
                <s-table-cell>{formatCount(m.sold, locale)}</s-table-cell>
                <s-table-cell>{formatCount(m.outDays, locale)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-stack>
    </s-section>
  );
}

function monthName(month: string, locale: string): string {
  try {
    return new Date(`${month}-15T12:00:00Z`).toLocaleDateString(locale, { month: "short", year: "numeric", timeZone: "UTC" });
  } catch {
    return month;
  }
}

function ForecastInputs({ inputs, forecast }: { inputs: ForecastInputsView | null; forecast: boolean }) {
  const { t, locale } = useLocale();
  const num = (v: number | null, digits = 1) =>
    v === null ? "—" : new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v);
  const locked = planTag("forecast", t);
  return (
    <s-section heading={t("How the forecast was built")}>
      {!inputs ? (
        <s-paragraph color="subdued">{t("Not enough sales yet to advise")}</s-paragraph>
      ) : (
        <s-stack direction="block" gap="base">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("Window")}</s-table-header>
              <s-table-header>{t("Days in stock")}</s-table-header>
              <s-table-header>{t("Sales per day while in stock")}</s-table-header>
              <s-table-header>{t("Weight")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {inputs.windows.map((w) => (
                <s-table-row key={w.days}>
                  <s-table-cell>{fill(t("Last {n} days"), { n: w.days })}</s-table-cell>
                  <s-table-cell>{formatCount(w.inStockDays, locale)}</s-table-cell>
                  <s-table-cell>{formatRate(w.rate, locale)}</s-table-cell>
                  <s-table-cell>
                    {w.used ? `${Math.round(w.weight * 100)}%` : t("Not used: too few days in stock")}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          <div className="keha-kv keha-kv--flush">
            <KvRow
              label={t("Days in stock")}
              value={fill(t("{n} of the last {days} days"), {
                n: num(inputs.inStockDays, 0),
                days: num(inputs.historyDays, 0),
              })}
            />
            <KvRow
              label={t("Seasonal change")}
              value={isNeutralMultiplier(inputs.seasonal) ? t("No seasonal data yet") : `× ${num(inputs.seasonal, 2)}`}
            />
            <KvRow
              label={t("Trend")}
              value={isNeutralMultiplier(inputs.trend) ? t("No seasonal data yet") : `× ${num(inputs.trend, 2)}`}
            />
            <KvRow
              label={t("Supplier lead time")}
              value={
                !forecast
                  ? locked
                  : inputs.leadTimeDays === null
                    ? "—"
                    : fill(inputs.leadTimeSource === "supplier" ? t("{n} days (supplier)") : t("{n} days (store default)"), {
                        n: num(inputs.leadTimeDays, 0),
                      })
              }
            />
            <KvRow label={t("Order cycle")} value={!forecast ? locked : inputs.cycleDays === null ? "—" : fill(t("{n} days"), { n: num(inputs.cycleDays, 0) })} />
            <KvRow label={t("Service level factor (z)")} value={!forecast ? locked : num(inputs.z, 2)} />
            <KvRow
              label={t("Safety stock")}
              value={!forecast ? locked : inputs.safety === null ? "—" : fill(t("{n} units"), { n: num(inputs.safety, 0) })}
            />
          </div>
          <s-text color="subdued">
            {t("Based on: sales per day while in stock in the windows above, weighted as shown. Days without data never count as days without sales.")}
          </s-text>
        </s-stack>
      )}
    </s-section>
  );
}

function RecentSales({ recent }: { recent: ChartDay[] }) {
  const { t, locale } = useLocale();
  return (
    <s-section heading={t("Recent sales")}>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">{t("Day")}</s-table-header>
          <s-table-header>{t("Units sold")}</s-table-header>
          <s-table-header>{t("Stock")}</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {recent.map((d) => (
            <s-table-row key={d.day}>
              <s-table-cell>{formatDay(d.day, locale)}</s-table-cell>
              <s-table-cell>{formatCount(d.sold, locale)}</s-table-cell>
              <s-table-cell>{d.out === null ? "—" : d.out ? t("Sold out") : t("In stock")}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-section>
  );
}
