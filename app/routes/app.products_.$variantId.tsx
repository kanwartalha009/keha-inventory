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
 *
 * Forecast choices (R4 forecast quality): "Don't cap" unusual days for this product, and "Plan
 * like…" a similar product (or the median of its product type, suggested) while it has fewer
 * than 28 days in stock. Our database only; the next compute (queued at once) uses them.
 */
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateApp } from "../services/data-scope.server";
import { getEntitlements } from "../services/entitlements.server";
import { getVariantDetail, setProductCaseSize, setProductSupplierCode } from "../models/products.server";
import { SUPPLIER_CODE_MAX, readSupplierCode } from "../lib/po-grid-shared";
import { setNoReorder } from "../models/reorder.server";
import { forecastChoiceFor, likeTargetExists, setNoCap, setPlanLike, type ForecastChoice, type LikeCandidate } from "../models/forecast-overrides.server";
import { enqueueJob } from "../services/jobs/queue.server";
import { PLAN_LIKE_DAYS, PLAN_LIKE_PCT, parsePlanLike, type LikeKind } from "../lib/forecast-override-shared";
import type { LikeSearchData } from "./app.products_.$variantId_.like";
import { AppPage, DaysLeft, FormCard, FormSaveBar, HeaderLabel, KvRow, ProductThumb } from "../components/ui";
import ConfirmModal from "../components/ConfirmModal";
import { NoReorderConfirm, OrderByCell } from "../components/order-plan";
import { flag, val } from "../components/wc";
import type { TrendMode } from "../lib/settings-shared";
import { UpgradeBanner, planTag } from "../components/plan";
import { fill, useLocale, plural } from "../lib/i18n";
import { inStockTargetPct } from "../lib/service-level-shared";
import { formatCount, formatDay, formatPercent } from "../lib/dashboard-shared";
import { shortDay } from "../lib/order-plan-shared";
import {
  dailySeries,
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
  type SeasonSourceView,
} from "../lib/products-shared";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await authenticateApp(request);
  const gid = variantGid(params.variantId ?? "");
  if (!gid) throw new Response("Not found", { status: 404 });
  const { features } = await getEntitlements(shop);
  const detail = await getVariantDetail(shop, gid, features.forecast);
  if (!detail) throw new Response("Not found", { status: 404 });
  const series = dailySeries(detail.sales, detail.stock, detail.today);
  const inputs = readForecastInputs(detail.inputs, detail.sigma);
  const choice = await forecastChoiceFor(shop, { productId: detail.variant.productId, productType: detail.variant.productType ?? null }, ownInStockDays(inputs));
  return {
    row: detail.row,
    productId: detail.variant.productId,
    noReorder: detail.variant.noReorder,
    productNoReorder: detail.siblings.length > 0 && detail.siblings.every((v) => v.noReorder),
    variantCount: detail.siblings.length,
    caseQty: detail.caseQty,
    supplierCode: detail.supplierCode ?? null,
    trendMode: detail.trendMode,
    vendor: detail.variant.vendor,
    series,
    months: monthlyTotals(series),
    recent: recentDays(series, 14),
    // Lead time, safety stock and the order cycle are part of the Growth forecast.
    inputs: inputs && !features.forecast ? { ...inputs, leadTimeDays: null, leadTimeSource: null, cycleDays: null, z: null, safety: null, leadSigma: null } : inputs,
    seasonCollection: detail.seasonCollection,
    forecast: features.forecast,
    choice,
  };
};

/** The variant's own in-stock days (before any "Plan like"); null without a metric. */
function ownInStockDays(inputs: ForecastInputsView | null): number | null {
  if (!inputs) return null;
  return inputs.planLike ? inputs.planLike.ownDays : inputs.inStockDays;
}

export type VariantDetailAction = { ok: true; count: number } | { ok: false; error?: "caseQty" | "supplierCode" | "planLike" };

/** "Don't reorder" (product or variant) and the product's case size — confirmed in the UI; our database only. */
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await authenticateApp(request);
  const gid = variantGid(params.variantId ?? "");
  if (!gid) throw new Response("Not found", { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  const { features } = await getEntitlements(shop);
  const detail = await getVariantDetail(shop, gid, features.forecast);
  if (!detail) throw new Response("Not found", { status: 404 });
  if (body.intent === "noReorder") {
    const target = body.scope === "product" ? { productId: detail.variant.productId } : { variantId: gid };
    return (await setNoReorder(shop, target, body.value !== false)) satisfies VariantDetailAction;
  }
  if (body.intent === "supplierCode") {
    const code = readSupplierCode(body.supplierCode);
    if (!code.ok) return { ok: false, error: "supplierCode" } satisfies VariantDetailAction;
    return (await setProductSupplierCode(shop, detail.variant.productId, code.code)) satisfies VariantDetailAction;
  }
  if (body.intent === "caseQty") {
    // The supplier code can be saved with it (one save bar for the card).
    if ("supplierCode" in body) {
      const code = readSupplierCode(body.supplierCode);
      if (!code.ok) return { ok: false, error: "supplierCode" } satisfies VariantDetailAction;
      await setProductSupplierCode(shop, detail.variant.productId, code.code);
    }
    const raw = body.caseQty;
    const n = raw === null || raw === "" ? null : Number(raw);
    if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 10_000)) return { ok: false, error: "caseQty" } satisfies VariantDetailAction;
    // 1 = no case size (single units): stored as none, so the supplier's case pack applies again.
    return (await setProductCaseSize(shop, detail.variant.productId, n === null || n <= 1 ? null : n)) satisfies VariantDetailAction;
  }
  // Forecast choices (R4): our database only; the next compute is queued so the advice follows.
  if (body.intent === "noCap") {
    await setNoCap(shop, detail.variant.productId, body.value !== false);
    await enqueueJob(shop, "compute");
    return { ok: true, count: 1 } satisfies VariantDetailAction;
  }
  if (body.intent === "planLike") {
    const like = parsePlanLike(body, detail.variant.productId);
    if (!like || !(await likeTargetExists(shop, like))) return { ok: false, error: "planLike" } satisfies VariantDetailAction;
    await setPlanLike(shop, detail.variant.productId, like);
    await enqueueJob(shop, "compute");
    return { ok: true, count: 1 } satisfies VariantDetailAction;
  }
  if (body.intent === "planLikeOff") {
    await setPlanLike(shop, detail.variant.productId, null);
    await enqueueJob(shop, "compute");
    return { ok: true, count: 1 } satisfies VariantDetailAction;
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
  /** The supplier's article / style code (purchase orders); null = none. */
  supplierCode?: string | null;
  trendMode?: TrendMode;
  vendor: string | null;
  series: ChartDay[];
  months: MonthTotal[];
  recent: ChartDay[];
  inputs: ForecastInputsView | null;
  /** Title of the collection the seasonal pattern came from (null: not a collection, or gone). */
  seasonCollection?: string | null;
  forecast: boolean;
  /** R4: "Don't cap" and "Plan like…" (absent in older fixtures: the card isn't shown). */
  choice?: ForecastChoice;
};

export default function VariantDetailPage() {
  const { t, locale } = useLocale();
  const data = useLoaderData<typeof loader>() as VariantDetailData;
  const { row, forecast } = data;
  const variant = variantName(row.variantTitle);
  const locked = planTag("forecast", t);

  return (
    <AppPage
      heading={row.productTitle}
      breadcrumb={{ label: t("Products"), to: "/app/products" }}
      meta={row.status ? <s-badge tone={statusTone(row.status)}>{statusLabel(row.status, t)}</s-badge> : undefined}
      intro={[variant, row.sku, data.vendor].filter(Boolean).join(" · ") || undefined}
    >
      {!forecast && <UpgradeBanner feature="forecast" />}

      <FormCard title={t("Stock")} sub={t("Stock counted in supplier orders: every active location unless you left it out in Settings → Locations.")}>
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
                !forecast ? locked : <DaysLeft id="keha-detail-left" daysLeft={row.daysLeft} neverRunsOut={row.neverRunsOut} />
              }
            />
            <KvRow
              label={t("Order by")}
              value={
                !forecast ? (
                  locked
                ) : (
                  <OrderByCell orderBy={row.orderBy} overdue={!!row.overdue} note={row.dueNote ?? null} />
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
      {data.choice && <ForecastChoicesCard data={data} choice={data.choice} />}

      <SalesChart series={data.series} months={data.months} />
      <ForecastInputs inputs={data.inputs} forecast={forecast} trendMode={data.trendMode ?? "off"} seasonCollection={data.seasonCollection ?? null} />
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

/** "Season from": the collection, product type or whole store the seasonal pattern came from. */
function seasonSourceLabel(source: SeasonSourceView, collection: string | null, t: (s: string) => string): string {
  if (source.level === "collection") return collection ? fill(t("Collection “{name}”"), { name: collection }) : t("One of its collections");
  if (source.level === "productType") return fill(t("Product type “{name}”"), { name: source.productType });
  return t("Your whole store");
}

function ForecastInputs({
  inputs,
  forecast,
  trendMode,
  seasonCollection,
}: {
  inputs: ForecastInputsView | null;
  forecast: boolean;
  trendMode: TrendMode;
  seasonCollection: string | null;
}) {
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
            {inputs.seasonSource && <KvRow label={t("Season from")} value={seasonSourceLabel(inputs.seasonSource, seasonCollection, t)} />}
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
                    : fill(inputs.leadTimeSource === "supplier" ? plural(inputs.leadTimeDays, t("1 day (supplier)"), t("{n} days (supplier)")) : plural(inputs.leadTimeDays, t("1 day (store default)"), t("{n} days (store default)")), { n: num(inputs.leadTimeDays, 0) })
              }
            />
            <KvRow label={t("Order cycle")} value={!forecast ? locked : inputs.cycleDays === null ? "—" : fill(plural(inputs.cycleDays, t("1 day"), t("{n} days")), { n: num(inputs.cycleDays, 0) })} />
            <KvRow
              label={t("Safety level")}
              value={
                !forecast ? (
                  locked
                ) : inStockTargetPct(inputs.z) === null ? (
                  "—"
                ) : (
                  // Merchant audit 2026-10-18: the in-stock target, not the raw z (1.65).
                  <span className="keha-inline">
                    <span>{fill(t("{pct}% in-stock target"), { pct: num(inStockTargetPct(inputs.z), 0) })}</span>
                    <s-text color="subdued">{t("the chance it doesn't run out before the next delivery")}</s-text>
                  </span>
                )
              }
            />
            <KvRow
              label={t("Safety stock")}
              value={
                !forecast ? (
                  locked
                ) : inputs.safety === null ? (
                  "—"
                ) : inputs.leadSigma ? (
                  // Supplier module: the measured spread of the supplier's deliveries is in it.
                  <span className="keha-inline">
                    <span>{fill(plural(Math.round(inputs.safety), t("1 unit"), t("{n} units")), { n: num(inputs.safety, 0) })}</span>
                    <s-text color="subdued">{fill(t("incl. late deliveries (± {n} days)"), { n: num(inputs.leadSigma, 1) })}</s-text>
                  </span>
                ) : (
                  fill(plural(Math.round(inputs.safety), t("1 unit"), t("{n} units")), { n: num(inputs.safety, 0) })
                )
              }
            />
            {forecast && inputs.error && (
              <>
                <KvRow label={t("Fill target")} value={`${num(inputs.error.fill * 100, 0)} %`} />
                <KvRow
                  label={fill(t("Forecast error over {n} days"), { n: num(inputs.error.horizonDays, 0) })}
                  value={
                    <span className="keha-inline">
                      <span>{fill(t("± {n} units"), { n: num(inputs.error.sigma, 0) })}</span>
                      {inputs.error.ratio !== null && (
                        <s-text color="subdued">{fill(t("last 13 weeks: {x}× the expected error"), { x: num(inputs.error.ratio, 1) })}</s-text>
                      )}
                    </span>
                  }
                />
              </>
            )}
            {inputs.levelShift && (
              <KvRow
                label={t("Sales level")}
                value={fill(inputs.levelShift.ratio >= 1 ? t("Sales stepped up on {date}; using the recent level.") : t("Sales dropped on {date}; using the recent level."), { date: formatDay(inputs.levelShift.day, locale) })}
              />
            )}
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
  const savedCode = data.supplierCode ?? "";
  const [code, setCode] = useState(savedCode);
  useEffect(() => setCode(savedCode), [savedCode]);
  const codeInvalid = !readSupplierCode(code).ok;
  const caseChanged = caseQty !== saved;
  const codeChanged = code.trim() !== savedCode;
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
          dirty={caseChanged || codeChanged}
          saving={saving}
          onSave={() => {
            if (invalid || codeInvalid) return;
            // A new case size changes order quantities: it asks first. The code alone saves at once.
            if (caseChanged) setConfirmCase(true);
            else fetcher.submit({ intent: "supplierCode", supplierCode: code } as never, { method: "post", encType: "application/json" });
          }}
          onDiscard={() => {
            setCaseQty(saved);
            setCode(savedCode);
          }}
        />
        <s-number-field
          label={t("Case size")}
          details={t("Units per case for this product, used for all its variants. It wins over the supplier's case pack. Leave empty to use the supplier's.")}
          value={caseQty}
          min={1}
          step={1}
          error={invalid || (fetcher.data && !fetcher.data.ok && fetcher.data.error === "caseQty") ? t("Enter a whole number from 1 to 10,000.") : undefined}
          disabled={flag(saving)}
          onInput={(e) => setCaseQty(val(e))}
        />
        <s-text-field
          label={t("Supplier code")}
          details={t("The supplier's article or style number for this product. Shown on purchase orders. Leave empty to use the start of the SKUs.")}
          value={code}
          maxLength={SUPPLIER_CODE_MAX}
          error={codeInvalid || (fetcher.data && !fetcher.data.ok && fetcher.data.error === "supplierCode") ? t("Use up to 64 characters.") : undefined}
          disabled={flag(saving)}
          onInput={(e) => setCode(val(e))}
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
          fetcher.submit({ intent: "caseQty", caseQty: n, ...(codeChanged ? { supplierCode: code } : {}) } as never, { method: "post", encType: "application/json" });
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

/**
 * Forecast choices (R4): "Don't cap" one-off spikes for this product, and "Plan like…" a similar
 * product or its type's median while it has too few days in stock. Our database only.
 */
function ForecastChoicesCard({ data, choice }: { data: VariantDetailData; choice: ForecastChoice }) {
  const { t, locale } = useLocale();
  const params = useParams();
  const fetcher = useFetcher<VariantDetailAction>();
  const search = useFetcher<LikeSearchData>();
  const [q, setQ] = useState("");
  const [pct, setPct] = useState("100");
  const [pick, setPick] = useState<null | { kind: LikeKind; ref: string; name: string }>(null);
  const saving = fetcher.state !== "idle";
  const spikes = data.inputs?.spikes ?? null;
  const largest = spikes?.days.length ? spikes.days.reduce((a, d) => (d.sold > a.sold ? d : a)) : null;
  const nf = (v: number, digits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v);
  const pctN = Number(pct);
  const pctBad = !(Number.isInteger(pctN) && pctN >= PLAN_LIKE_PCT.min && pctN <= PLAN_LIKE_PCT.max);
  const ownDays = data.inputs?.planLike?.ownDays ?? data.inputs?.inStockDays ?? 0;
  const submit = (body: Record<string, unknown>) => fetcher.submit(body as never, { method: "post", encType: "application/json" });
  const find = (text: string) => {
    setQ(text);
    if (!params.variantId) return;
    if (text.trim()) search.load(`/app/products/${params.variantId}/like?${new URLSearchParams({ q: text.trim() }).toString()}`);
  };
  const likeLine = (kind: LikeKind, name: string, p: number) =>
    fill(
      kind === "product"
        ? t("Based on {name} at {pct} % until this product has 28 days in stock (now {days}).")
        : t("Based on the median {name} product at {pct} % until this product has 28 days in stock (now {days})."),
      { name, pct: nf(p), days: nf(ownDays) },
    );

  let capText: string;
  if (choice.noCap) capText = t("Unusual days are not capped for this product: every day counts at what it sold.");
  else if (spikes && spikes.count > 0 && largest)
    capText = fill(spikes.count === 1 ? t("1 unusual day capped ({date}: {units} units, counted as {cap})") : t("{n} unusual days capped (largest {date}: {units} units, counted as {cap})"), {
      n: nf(spikes.count),
      date: shortDay(largest.day, locale),
      units: nf(largest.sold),
      cap: nf(largest.cap),
    });
  else capText = t("No unusual days in the last 90 days.");

  return (
    <FormCard title={t("Forecast choices")} sub={t("Our database only: nothing changes in your store. The forecast is updated within a few minutes.")}>
      <s-stack direction="block" gap="large">
        <s-stack direction="block" gap="small-200">
          <s-heading>{t("Unusual days")}</s-heading>
          <s-text color="subdued">
            {t("A day far above this product's usual sales, for example one large wholesale order, counts as a busy normal day, so one order doesn't raise every future order.")}
          </s-text>
          <s-text>{capText}</s-text>
          {(choice.noCap || (spikes?.count ?? 0) > 0) && (
            <s-stack direction="inline" gap="small-200">
              <s-button disabled={flag(saving)} onClick={() => submit({ intent: "noCap", value: !choice.noCap })}>
                {choice.noCap ? t("Cap unusual days again") : t("Don't cap this product")}
              </s-button>
            </s-stack>
          )}
        </s-stack>

        {(choice.like || choice.offer) && (
          <s-stack direction="block" gap="small-200">
            <s-heading>{t("New product")}</s-heading>
            {choice.like ? (
              <>
                <s-text>{likeLine(choice.like.kind, choice.like.name, choice.like.pct)}</s-text>
                {choice.like.rate === null && (
                  <s-text color="subdued">{fill(t("{name} has no sales pace yet, so this product is planned on its own sales."), { name: choice.like.name })}</s-text>
                )}
                <s-stack direction="inline" gap="small-200">
                  <s-button disabled={flag(saving)} onClick={() => submit({ intent: "planLikeOff" })}>
                    {fill(t("Stop planning like {name}"), { name: choice.like.name })}
                  </s-button>
                </s-stack>
              </>
            ) : (
              <>
                <s-text>
                  {fill(t("Only {n} days in stock so far: too few to measure its own pace. Plan it like a similar product until it has {days} days in stock."), {
                    n: nf(ownDays),
                    days: nf(PLAN_LIKE_DAYS),
                  })}
                </s-text>
                {choice.offer?.productType && choice.offer.suggestion && (
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-text>
                      {fill(t("Suggested: the median {type} product sells {rate} a day."), {
                        type: choice.offer.productType,
                        rate: formatRate(choice.offer.suggestion.rate, locale),
                      })}
                    </s-text>
                    <s-button variant="secondary" disabled={flag(saving)} onClick={() => setPick({ kind: "productType", ref: choice.offer!.productType!, name: choice.offer!.productType! })}>
                      {t("Use this suggestion")}
                    </s-button>
                  </s-stack>
                )}
                <s-search-field label={t("Similar product")} placeholder={t("Product title")} value={q} onChange={(e) => find(val(e))} />
                {q.trim() !== "" && search.data?.ok && search.data.products.length === 0 && (
                  <s-text color="subdued">{t("No product with its own sales pace matches.")}</s-text>
                )}
                {q.trim() !== "" && search.data?.ok && search.data.products.length > 0 && (
                  <s-table>
                    <s-table-header-row>
                      <s-table-header listSlot="primary">{t("Product")}</s-table-header>
                      <s-table-header listSlot="labeled" format="numeric">
                        <HeaderLabel id="keha-like-rate" label={t("Sales/day")} hint={t("Sales per day while in stock")} />
                      </s-table-header>
                      <s-table-header>
                        <HeaderLabel id="keha-like-act" label={t("Actions")} />
                      </s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {search.data.products.map((p: LikeCandidate) => (
                        <s-table-row key={p.productId}>
                          <s-table-cell>{p.title}</s-table-cell>
                          <s-table-cell>{formatRate(p.rate, locale)}</s-table-cell>
                          <s-table-cell>
                            <s-button variant="secondary" onClick={() => setPick({ kind: "product", ref: p.productId, name: p.title })} accessibilityLabel={`${t("Plan like this")}: ${p.title}`}>
                              {t("Plan like this")}
                            </s-button>
                          </s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                )}
              </>
            )}
            {fetcher.data && !fetcher.data.ok && fetcher.data.error === "planLike" && (
              <s-text tone="critical">{t("This product can't be used. Reload the page and try again.")}</s-text>
            )}
          </s-stack>
        )}
      </s-stack>
      <ConfirmModal
        open={!!pick}
        destructive={false}
        title={fill(t("Plan like {name}?"), { name: pick?.name ?? "" })}
        message={fill(t("Until this product has {days} days in stock, its forecast uses this pace, moving onto its own sales day by day. Our database only: nothing changes in your store."), {
          days: nf(PLAN_LIKE_DAYS),
        })}
        confirmLabel={t("Plan like this")}
        onCancel={() => setPick(null)}
        onConfirm={() => {
          const p = pick;
          if (!p || pctBad) return;
          setPick(null);
          submit({ intent: "planLike", kind: p.kind, ref: p.ref, pct: pctN });
        }}
      >
        <s-number-field
          label={t("Percent of its pace")}
          details={t("For example 50 if you expect half its sales.")}
          value={pct}
          min={PLAN_LIKE_PCT.min}
          max={PLAN_LIKE_PCT.max}
          step={1}
          suffix="%"
          error={pctBad ? fill(t("Enter a whole number from {min} to {max}."), { min: PLAN_LIKE_PCT.min, max: PLAN_LIKE_PCT.max }) : undefined}
          onInput={(e) => setPct(val(e))}
        />
      </ConfirmModal>
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
