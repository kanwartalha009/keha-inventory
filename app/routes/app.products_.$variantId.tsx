/**
 * Variant detail (/app/products/:variantId) — spec §5.2 row detail. A page
 * rather than a drawer: simpler to reach by keyboard and screen reader, and
 * linkable. 13 months of daily sales with sold-out days shaded (inline SVG
 * with an aria-label and a month table as its text fallback), how the
 * forecast was built (VariantMetric.inputs) and the last 14 days of sales.
 *
 * Ordering (audit 2026-10-17): "Order by" and "To order" are the forward plan's (the same as
 * Order now). "Don't reorder" for the whole product or this variant, and the product's own case
 * size (written to every variant; it wins over the supplier's case pack) — each confirmed, our
 * database only.
 */
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getEntitlements } from "../services/entitlements.server";
import { getVariantDetail, setProductCaseSize } from "../models/products.server";
import { setNoReorder } from "../models/reorder.server";
import { AppPage, FormCard, FormSaveBar, HeaderLabel, KvRow, ProductThumb } from "../components/ui";
import ConfirmModal from "../components/ConfirmModal";
import { NoReorderConfirm } from "../components/order-plan";
import { flag, val } from "../components/wc";
import type { TrendMode } from "../lib/settings-shared";
import { UpgradeBanner, planTag } from "../components/plan";
import { fill, useLocale } from "../lib/i18n";
import { formatCount, formatDay, formatPercent } from "../lib/dashboard-shared";
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
    productId: detail.variant.productId,
    noReorder: detail.variant.noReorder,
    productNoReorder: detail.siblings.length > 0 && detail.siblings.every((v) => v.noReorder),
    variantCount: detail.siblings.length,
    caseQty: detail.caseQty,
    trendMode: detail.trendMode,
    vendor: detail.variant.vendor,
    series,
    months: monthlyTotals(series),
    recent: recentDays(series, 14),
    // Lead time, safety stock and the order cycle are part of the Growth forecast.
    inputs: inputs && !features.forecast ? { ...inputs, leadTimeDays: null, leadTimeSource: null, cycleDays: null, z: null, safety: null } : inputs,
    forecast: features.forecast,
  };
};

export type VariantDetailAction = { ok: true; count: number } | { ok: false; error?: "caseQty" };

/** "Don't reorder" (product or variant) and the product's case size — confirmed in the UI; our database only. */
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const gid = variantGid(params.variantId ?? "");
  if (!gid) throw new Response("Not found", { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  const { features } = await getEntitlements(session.shop);
  const detail = await getVariantDetail(session.shop, gid, features.forecast);
  if (!detail) throw new Response("Not found", { status: 404 });
  if (body.intent === "noReorder") {
    const target = body.scope === "product" ? { productId: detail.variant.productId } : { variantId: gid };
    return (await setNoReorder(session.shop, target, body.value !== false)) satisfies VariantDetailAction;
  }
  if (body.intent === "caseQty") {
    const raw = body.caseQty;
    const n = raw === null || raw === "" ? null : Number(raw);
    if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 10_000)) return { ok: false, error: "caseQty" } satisfies VariantDetailAction;
    // 1 = no case size (single units): stored as none, so the supplier's case pack applies again.
    return (await setProductCaseSize(session.shop, detail.variant.productId, n === null || n <= 1 ? null : n)) satisfies VariantDetailAction;
  }
  throw new Response("Bad request", { status: 400 });
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export type VariantDetailData = {
  row: ProductRow;
  productId?: string;
  /** This variant / every variant of the product is marked "Don't reorder". */
  noReorder?: boolean;
  productNoReorder?: boolean;
  variantCount?: number;
  /** The product's own case size (null: the supplier's case pack applies). */
  caseQty?: number | null;
  trendMode?: TrendMode;
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

      <FormCard title={t("Stock")} sub={t("Stock counted in supplier orders: the active locations that fulfil online orders.")}>
        <div className="keha-cell-product">
          <ProductThumb src={row.image} alt={row.productTitle} size={48} />
          <div className="keha-kv keha-kv--flush keha-grow">
            <KvRow label={t("Stock now")} value={formatCount(row.onHand, locale)} />
            <KvRow label={t("Incoming")} value={formatCount(row.incoming, locale)} />
            {row.onOrder > 0 && (
              <KvRow
                label={t("On order with Keha")}
                value={
                  row.onOrderArrival
                    ? fill(t("{n} · arrives {date}"), { n: formatCount(row.onOrder, locale), date: formatDay(row.onOrderArrival, locale) })
                    : formatCount(row.onOrder, locale)
                }
              />
            )}
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
            <KvRow
              label={t("Order by")}
              value={
                !forecast ? (
                  locked
                ) : (
                  <span className="keha-inline">
                    <span>{formatDay(row.orderBy, locale)}</span>
                    {row.overdue && <s-badge tone="critical">{t("Overdue")}</s-badge>}
                  </span>
                )
              }
            />
            <KvRow
              label={t("To order")}
              value={!forecast ? locked : row.noReorder ? <s-badge tone="neutral">{t("Not reordered")}</s-badge> : formatCount(row.orderQty, locale)}
            />
          </div>
        </div>
      </FormCard>

      <OrderingCard data={data} />

      <SalesChart series={data.series} months={data.months} />
      <ForecastInputs inputs={data.inputs} forecast={forecast} trendMode={data.trendMode ?? "off"} />
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
    <FormCard title={t("Sales, last 13 months")}>
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
            <s-table-header format="numeric">{t("Units sold")}</s-table-header>
            <s-table-header format="numeric">{t("Sold-out days")}</s-table-header>
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
    </FormCard>
  );
}

function monthName(month: string, locale: string): string {
  try {
    return new Date(`${month}-15T12:00:00Z`).toLocaleDateString(locale, { month: "short", year: "numeric", timeZone: "UTC" });
  } catch {
    return month;
  }
}

function ForecastInputs({ inputs, forecast, trendMode }: { inputs: ForecastInputsView | null; forecast: boolean; trendMode: TrendMode }) {
  const { t, locale } = useLocale();
  const num = (v: number | null, digits = 1) =>
    v === null ? "—" : new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v);
  const locked = planTag("forecast", t);
  return (
    <FormCard title={t("How the forecast was built")}>
      {!inputs ? (
        <s-paragraph color="subdued">{t("Not enough sales yet to advise")}</s-paragraph>
      ) : (
        <s-stack direction="block" gap="base">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("Window")}</s-table-header>
              <s-table-header format="numeric">{t("Days in stock")}</s-table-header>
              <s-table-header format="numeric">
                <HeaderLabel id="keha-window-rate" label={t("Sales/day")} hint={t("Sales per day while in stock")} />
              </s-table-header>
              <s-table-header format="numeric">{t("Weight")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {inputs.windows.map((w) => (
                <s-table-row key={w.days}>
                  <s-table-cell>{fill(t("Last {n} days"), { n: w.days })}</s-table-cell>
                  <s-table-cell>{formatCount(w.inStockDays, locale)}</s-table-cell>
                  <s-table-cell>{formatRate(w.rate, locale)}</s-table-cell>
                  <s-table-cell>
                    {w.used ? formatPercent(Math.round(w.weight * 100) / 100, locale) : t("Not used: too few days in stock")}
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
              value={
                trendMode === "off"
                  ? t("Not applied (growth assumption off)")
                  : isNeutralMultiplier(inputs.trend)
                    ? t("No change from last year")
                    : `× ${num(inputs.trend, 2)}`
              }
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
            <KvRow label={t("Safety level")} value={!forecast ? locked : num(inputs.z, 2)} />
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
    </FormCard>
  );
}

/** Ordering: "Don't reorder" for the product or this variant, and the product's own case size. */
function OrderingCard({ data }: { data: VariantDetailData }) {
  const { t, locale } = useLocale();
  const fetcher = useFetcher<VariantDetailAction>();
  const saved = data.caseQty && data.caseQty > 1 ? String(data.caseQty) : "";
  const [caseQty, setCaseQty] = useState(saved);
  const [confirmCase, setConfirmCase] = useState(false);
  const [ask, setAsk] = useState<null | { scope: "product" | "variant"; value: boolean }>(null);
  useEffect(() => setCaseQty(saved), [saved]);
  const variant = variantName(data.row.variantTitle);
  const name = [data.row.productTitle, variant].filter(Boolean).join(" — ");
  const n = caseQty.trim() === "" ? null : Number(caseQty);
  const invalid = n !== null && !(Number.isInteger(n) && n >= 1 && n <= 10_000);
  const saving = fetcher.state !== "idle";
  const count = data.variantCount ?? 1;
  const status = data.productNoReorder
    ? t("This product is set to Don't reorder: it stays in your stock numbers but is never in an order.")
    : data.noReorder
      ? t("This variant is set to Don't reorder: it stays in your stock numbers but is never in an order.")
      : t("Reordered as planned.");
  return (
    <FormCard title={t("Ordering")} sub={t("Leave a product out of every order, or set its own case size.")}>
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-200">
          <s-text>{status}</s-text>
          <s-stack direction="inline" gap="small-200">
            {data.productNoReorder || data.noReorder ? (
              <s-button onClick={() => setAsk({ scope: data.productNoReorder ? "product" : "variant", value: false })}>{t("Reorder again")}</s-button>
            ) : (
              <>
                <s-button onClick={() => setAsk({ scope: "product", value: true })}>{t("Don't reorder this product")}</s-button>
                {count > 1 && <s-button variant="tertiary" onClick={() => setAsk({ scope: "variant", value: true })}>{t("Don't reorder this variant")}</s-button>}
              </>
            )}
          </s-stack>
        </s-stack>
        <FormSaveBar
          id="keha-product-case"
          dirty={caseQty !== saved}
          saving={saving}
          onSave={() => (invalid ? undefined : setConfirmCase(true))}
          onDiscard={() => setCaseQty(saved)}
        />
        <s-number-field
          label={t("Case size")}
          details={t("Units per case for this product, used for all its variants. It wins over the supplier's case pack. Leave empty to use the supplier's.")}
          value={caseQty}
          min={1}
          step={1}
          error={invalid || (fetcher.data && !fetcher.data.ok) ? t("Enter a whole number from 1 to 10,000.") : undefined}
          disabled={flag(saving)}
          onInput={(e) => setCaseQty(val(e))}
        />
      </s-stack>
      <ConfirmModal
        open={confirmCase}
        destructive={false}
        title={n && n > 1 ? fill(t("Set the case size to {n}?"), { n: formatCount(n, locale) }) : t("Use the supplier's case pack?")}
        message={fill(count === 1 ? t("This applies to the product's only variant. Order quantities are rounded to it from now on.") : t("This applies to all {n} variants of the product. Order quantities are rounded to it from now on."), {
          n: formatCount(count, locale),
        })}
        confirmLabel={t("Save")}
        onCancel={() => setConfirmCase(false)}
        onConfirm={() => {
          setConfirmCase(false);
          fetcher.submit({ intent: "caseQty", caseQty: n } as never, { method: "post", encType: "application/json" });
        }}
      />
      <NoReorderConfirm
        open={!!ask}
        name={ask?.scope === "product" ? data.row.productTitle : name}
        value={ask?.value ?? true}
        scope={ask?.scope ?? "product"}
        onCancel={() => setAsk(null)}
        onConfirm={() => {
          const a = ask;
          setAsk(null);
          if (a) fetcher.submit({ intent: "noReorder", scope: a.scope, value: a.value } as never, { method: "post", encType: "application/json" });
        }}
      />
    </FormCard>
  );
}

function RecentSales({ recent }: { recent: ChartDay[] }) {
  const { t, locale } = useLocale();
  return (
    <FormCard title={t("Recent sales")}>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">{t("Day")}</s-table-header>
          <s-table-header format="numeric">{t("Units sold")}</s-table-header>
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
    </FormCard>
  );
}
