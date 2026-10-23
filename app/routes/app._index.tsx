/**
 * Dashboard (/app) — spec §5.1, §4 J1; led by the order plan (Kanwar 2026-10-17).
 *
 *  1. "Due this week" from the forward order plan (models/order-plan.server): per supplier
 *     the products, units, cash and earliest order-by date, with "Review order" (Order now with
 *     those lines at the planned quantities, that supplier only); then a 13-week cash strip
 *     linking to Order plan · Next 13 weeks. Free: the read-only top-10 preview and the teaching
 *     lock instead (suppliers, purchase orders and the calendar are Growth).
 *  0. "This week" (components/briefing): the 30-second report, its 4 tiles and the money at stake
 *     as one compact strip (each figure with "How we got this") — one card since 0286.
 *  2. (merged into 0.)
 *  3. The setup guide while incomplete (Lead times, Suppliers, Product costs, Monday email),
 *     the first-sync screen and the empty states. While the store is read for the first time
 *     (owner 2026-10-17) the sync screen leads: stages with their own progress, an ETA measured
 *     from this store's read, plain error copy, what to do meanwhile (lead time, suppliers, CSV
 *     import) and "we'll email you when your order plan is ready" (components/sync-progress);
 *     the setup guide follows. Once numbers show from the newest months, they say "Based on the
 *     last 90 days so far" and a compact sync card sits at the bottom; when the read finishes,
 *     "Your order plan is ready" for a few days.
 *  4. The top 5 of "This week's actions" (task 2.3) once the store is ready; the whole list, with
 *     its tabs, is the Actions page (/app/actions, 0286).
 * The loader reads only the database; the only Shopify call is the cached, time-boxed "is Keha
 * Preorder installed?" check, made only when a Growth store has a Bridge row to show.
 */
import { useEffect, type ReactNode } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateApp } from "../services/data-scope.server";
import { planFor } from "../services/entitlements.server";
import { getHomeData, reviewAskDue } from "../models/dashboard.server";
import { recordReviewAsk } from "../models/settings.server";
import { REVIEW_ASK_DELAY_MS, isFinalReviewCode, type ReviewMoment } from "../lib/review-ask-shared";
import { loadOrderPlan } from "../models/order-plan.server";
import { CantPlan, PreviewLock, PreviewTable, SupplierDueCell } from "../components/order-plan";
import { hasFeature } from "../lib/plan-shared";
import { cashTotals } from "../lib/engine/forward-plan-shared";
import {
  lockTeaser,
  orderLink,
  paidSummary,
  previewRows,
  supplierName,
  thisWeek,
  type LockTeaser,
  type OrderPlanData,
  type PreviewRow,
} from "../lib/order-plan-shared";
import { getActionList } from "../models/actions.server";
import { kehaPreorderInstalled } from "../services/keha-preorder.server";
import { ActionList } from "../components/action-list";
import { BriefingSentences } from "../components/briefing";
import { recordActivation } from "../models/activation.server";
import { MoneyFigure, useFmt } from "../components/money";
import { outcomeCounts, type OutcomeCounts } from "../models/products.server";
import { outcomeLabel, outcomeMeaning, outcomeTone, type OutcomeKey } from "../lib/outcome-shared";
import { salesSpanText } from "../lib/sync-progress-shared";
import { dashboardHelp } from "../components/help";
import { buildBriefing, type Briefing } from "../lib/briefing-shared";
import { SampleOfferCard } from "../components/sample";
import { offerSample } from "../lib/sample-mode-shared";
import type { ActionListView } from "../lib/action-list-shared";
import { AppPage, FormCard, HeaderLabel } from "../components/ui";
import { ReadyNotice, SyncProgress } from "../components/sync-progress";
import { partialText } from "../lib/sync-progress-shared";
import { useLinkProps } from "../components/wc";
import { planTag } from "../components/plan";
import { fill, useLocale, plural } from "../lib/i18n";
import { DASHBOARD_MONEY } from "../lib/money-shared";
import { recheckNoticeText } from "../lib/sync/weekly-recheck-shared";
import {
  formatAmount,
  formatCount,
  formatDay,
  seasonsLearningText,
  updatedLabel,
  type HomeData,
} from "../lib/dashboard-shared";

/** Growth / Pro: the whole forward plan; Free: only the read-only top 10 (nothing more is sent). */
export type DashboardOrderPlan =
  | { kind: "full"; plan: OrderPlanData }
  // Free: the top 10 and the teaching lock with the merchant's own totals (worked out on the server).
  | { kind: "preview"; rows: PreviewRow[]; teaser?: LockTeaser | null; currency?: string; cantPlan?: OrderPlanData["cantPlan"] };

export type HomeLoaderData = HomeData & {
  actions?: ActionListView | null;
  orderPlan?: DashboardOrderPlan | null;
  /** Server clock for the "Updated … today" line. */
  renderedAt?: string;
  /** Ask for an App Store review on this open (after a success moment; lib/review-ask-shared). */
  reviewAsk?: ReviewMoment | null;
  /** The store isn't ready yet: offer "Explore Keha with sample data" (components/sample). */
  sampleOffer?: boolean;
  /** "This week" sentences (lib/briefing-shared); null until the plan is ready. */
  briefing?: Briefing | null;
  /** "Your stock today": products per status word (models/products.server outcomeCounts). */
  stock?: OutcomeCounts | null;
};

export const loader = async ({ request }: LoaderFunctionArgs): Promise<HomeLoaderData> => {
  const { admin, shop, sample } = await authenticateApp(request);
  const plan = await planFor(shop);
  const now = new Date();
  const home = await getHomeData(shop, plan, now);
  // Sample data (components/sample): never "late" (it has no nightly run), never a review ask,
  // and no Shopify call for the preorder app.
  if (sample) home.dataLate = false;
  const ready = home.state === "ready";
  const [actions, forward, reviewAsk, stock] = await Promise.all([
    ready ? getActionList(shop, plan, now, { preorderInstalled: sample ? async () => false : () => kehaPreorderInstalled(admin, shop) }) : null,
    ready ? loadOrderPlan(shop, now) : null,
    ready && !sample ? reviewAskDue(shop, now).catch(() => null) : null,
    // "Your stock today" (clarity pass): how many products carry each status word.
    ready ? outcomeCounts(shop, now, hasFeature(plan, "forecast")).catch(() => null) : null,
  ]);
  // First-session measurement: the first time this shop saw its plan (never on sample data).
  if (ready && !sample) void recordActivation(shop, "plan_seen", now);
  const orderPlan: DashboardOrderPlan | null = forward
    ? hasFeature(plan, "reorderPlan")
      ? { kind: "full", plan: forward }
      : { kind: "preview", rows: previewRows(forward), teaser: lockTeaser(forward), currency: forward.currency, cantPlan: forward.cantPlan }
    : null;
  const briefing = forward
    ? buildBriefing({ currency: forward.currency, week: thisWeek(forward), counts: actions?.counts ?? null, cashStuck: home.money?.values.cashStuck ?? null })
    : null;
  return { ...home, actions, orderPlan, briefing, stock, renderedAt: now.toISOString(), reviewAsk, sampleOffer: !sample && offerSample(home.state) };
};

/** POST { intent: "reviewAsked", code }: remember Shopify's answer so we never ask twice. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, sample } = await authenticateApp(request);
  if (sample) return { ok: false };
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return { ok: false };
  }
  if (body.intent !== "reviewAsked" || !isFinalReviewCode(body.code)) return { ok: false };
  return { ok: await recordReviewAsk(shop, String(body.code), new Date()) };
};

/** Recording the review answer never reloads the Dashboard. */
export const shouldRevalidate: ShouldRevalidateFunction = ({ json, defaultShouldRevalidate }) =>
  json && typeof json === "object" && (json as Record<string, unknown>).intent === "reviewAsked" ? false : defaultShouldRevalidate;

export const headers: HeadersFunction = (h) => boundary.headers(h);

/** Shopify's own product list (cost per item lives there); outside the app iframe. */
const SHOPIFY_PRODUCTS = "shopify://admin/products";

export default function Home() {
  const { t, locale } = useLocale();
  const data = useLoaderData<typeof loader>() as HomeLoaderData;
  // The real update time as soon as any computation finished (the first one runs before the first nightly).
  const updated = updatedLabel(data.updatedAt ?? data.lastNightlyAt, data.timezone, locale, data.renderedAt ? new Date(data.renderedAt) : new Date(), t);
  const ready = data.state === "ready";

  return (
    <AppPage
      heading={t("Dashboard")}
      intro={updated}
      help={dashboardHelp(t, locale, {
        leadTimeDays: data.setup.leadTimeDays,
        cycleDays: data.setup.cycleDays ?? null,
        costPercent: data.setup.costPercent,
        supplierCount: data.setup.supplierCount,
      })}
    >
      {data.reviewAsk && <ReviewAsk />}
      {data.dataLate && <s-banner tone="warning">{t("Data is late — no action needed, we're retrying.")}</s-banner>}

      {data.readyNotice && <ReadyNotice span={data.salesSpan} />}

      {/* First read: the sync screen (with what to do meanwhile) leads, then the setup guide. */}
      {data.state === "syncing" && (
        <SyncProgress
          view={data.syncView}
          mode="full"
          setup={{
            leadTimeDone: data.setup.leadTimeDone,
            suppliersDone: data.setup.suppliersDone,
            importEnabled: data.setup.importEnabled,
          }}
        />
      )}

      {/* Not ready yet: try the app on a simulated store meanwhile (owner 2026-10-17). */}
      {data.sampleOffer && <SampleOfferCard />}

      {data.state === "syncing" && !data.setup.allDone && <SetupGuide data={data} />}

      {/* Clarity pass (2026-10-23): first the diagnosis — what the app read and how the stock stands
          — then what to do this week, then the top actions. */}
      {ready && <StockToday data={data} />}
      <OrderThisWeek data={data} />

      {ready && data.actions && <ActionList list={data.actions} timezone={data.timezone} mode="preview" />}

      {data.state === "noSales" && (
        <s-section heading={t("Not enough sales yet to advise")}>
          <s-paragraph>
            {data.noSalesReadyOn
              ? fill(t("Your first order plan needs 14 days of sales — expected on {date}."), {
                  date: formatDay(data.noSalesReadyOn, locale),
                })
              : t("Your first order plan needs 14 days of sales.")}
          </s-paragraph>
        </s-section>
      )}

      {data.state === "noTracked" && (
        <s-section heading={t("No stock tracked yet")}>
          <s-stack direction="block" gap="small">
            <s-paragraph>{t("Turn on 'Track quantity' for your products in Shopify.")}</s-paragraph>
            <s-stack direction="inline">
              <s-button href={SHOPIFY_PRODUCTS} target="_top">
                {t("Open products in Shopify")}
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}

      {/* Not enough sales / nothing tracked: the setup guide BEFORE the sync progress, as while
          syncing (2026-10-17 click-through: it sat at the bottom, under the progress). */}
      {(data.state === "noSales" || data.state === "noTracked") && !data.setup.allDone && <SetupGuide data={data} />}

      {/* Numbers show while older months load ("Based on …" only when there are numbers to qualify). */}
      {data.state !== "syncing" && !data.sync.done && (
        <SyncProgress view={{ ...data.syncView, partial: ready && data.syncView.partial }} mode="compact" />
      )}

      {ready && !data.setup.allDone && <SetupGuide data={data} />}
    </AppPage>
  );
}

/**
 * Shopify's review modal, once, a few seconds after the Dashboard settles — never on a click,
 * never from Sidekick. Shopify decides whether it shows (24 h after install, 60-day cooldown,
 * 3 a year); the answer is recorded so we don't ask again.
 */
function ReviewAsk() {
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  useEffect(() => {
    let done = false;
    const timer = setTimeout(async () => {
      try {
        const r = await shopify.reviews.request();
        if (!done && isFinalReviewCode(r.code))
          fetcher.submit({ intent: "reviewAsked", code: r.code }, { method: "post", action: "/app?index", encType: "application/json" });
      } catch {
        /* App Bridge without the reviews API (old admin, tests): nothing to do */
      }
    }, REVIEW_ASK_DELAY_MS);
    return () => {
      done = true;
      clearTimeout(timer);
    };
    // Once per page view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/** The lead block: what to order this week, by supplier, and the cash needed over the next 13 weeks. */
function OrderThisWeek({ data }: { data: HomeLoaderData }) {
  const { t, locale } = useLocale();
  const heading = t("This week");
  // The plain sentences lead the card (they say what the table below details).
  const lead = data.briefing ? <BriefingSentences briefing={data.briefing} /> : null;
  if (data.state === "syncing") {
    // Not ready: what will appear here, never "nothing to order" (2026-10-17 click-through); how
    // far the reading is lives in the sync screen above.
    return <FormCard title={heading} sub={t("Your order plan appears here once your products, stock and sales are read.")} />;
  }
  const op = data.orderPlan;
  if (data.state !== "ready" || !op) return null;
  // Numbers from the newest months while older ones load: say so (owner 2026-10-17).
  // Data quality, quietly: older months still loading; under 13 months of sales, seasons still learning.
  const partial =
    data.syncView.partial || data.seasonsLearning != null ? (
      <s-stack direction="inline" gap="small-200">
        {data.syncView.partial && <PartialBadge monthsRead={data.syncView.monthsRead} />}
        {data.seasonsLearning != null && <SeasonsLearningBadge months={data.seasonsLearning} />}
      </s-stack>
    ) : null;
  if (op.kind === "preview") {
    return (
      <FormCard title={heading} sub={t("Your 10 most urgent products: how many days of stock are left, the date to order by and how many to order.")}>
        {lead}
        {partial}
        <PreviewTable rows={op.rows} />
        {op.cantPlan && <CantPlan plan={{ cantPlan: op.cantPlan }} />}
        <PreviewLock teaser={op.teaser} currency={op.currency} />
      </FormCard>
    );
  }
  return <OrderPlanBlock plan={op.plan} heading={heading} partial={partial} lead={lead} />;
}

/** "Based on the last 90 days so far" — on every number shown before the whole history is read. */
/** Under 13 months of sales: the seasons are still being learned (a status, not a warning). */
function SeasonsLearningBadge({ months }: { months: number }) {
  const { t, locale } = useLocale();
  return (
    <s-badge tone="neutral" icon="calendar">
      {seasonsLearningText(months, t, (n) => formatCount(n, locale))}
    </s-badge>
  );
}

function PartialBadge({ monthsRead }: { monthsRead: number }) {
  const { t, locale } = useLocale();
  return (
    <s-stack direction="inline">
      <s-badge tone="info" icon="clock">
        {partialText(monthsRead, t, (n) => formatCount(n, locale))}
      </s-badge>
    </s-stack>
  );
}

function OrderPlanBlock({ plan, heading, partial, lead }: { plan: OrderPlanData; heading: string; partial?: ReactNode; lead?: ReactNode }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const week = thisWeek(plan);
  // One cash horizon (merchant #2): the same 13 weeks and the same total as Next 13 weeks — each
  // payment in the week it is paid (supplier payment terms), open orders' balances included.
  const cashOut = paidSummary(plan);
  const strip = cashTotals(plan.events);
  const money = (v: number | null) => formatAmount(v, plan.currency, locale);
  return (
    <FormCard
      title={heading}
      action={
        // A link like "See the order calendar" below it (a bare tertiary button read as plain text).
        <s-link {...link("/app/reorder")}>{t("Order plan")}</s-link>
      }
    >
      <s-stack direction="block" gap="base">
        {lead}
        {partial}
        {week.suppliers.length === 0 ? (
          // The sentences already say there is nothing to order; without them, say it here.
          lead ? null : (
            <s-paragraph>
              {week.next
                ? fill(t("Nothing to order this week. Next order: {supplier} by {date}."), {
                    supplier: supplierName(plan, week.next.supplierKey, t),
                    date: formatDay(week.next.orderBy, locale),
                  })
                : t("No orders needed in the next 13 weeks.")}
            </s-paragraph>
          )
        ) : (
          <>
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">{t("Supplier")}</s-table-header>
                <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ow-products" label={t("Products")} /></s-table-header>
                <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ow-units" label={t("Units")} /></s-table-header>
                <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ow-cash" label={t("Cash")} hint={t("Cash needed")} /></s-table-header>
                <s-table-header listSlot="labeled"><HeaderLabel id="keha-ow-by" label={t("Order by")} /></s-table-header>
                <s-table-header><HeaderLabel id="keha-ow-order" label={t("Order")} /></s-table-header>
              </s-table-header-row>
              <s-table-body>
                {week.suppliers.map((s) => (
                  <s-table-row key={s.supplierKey}>
                    <s-table-cell>
                      <s-text fontWeight="medium">{supplierName(plan, s.supplierKey, t)}</s-text>
                    </s-table-cell>
                    <s-table-cell>{formatCount(s.products, locale)}</s-table-cell>
                    <s-table-cell>{formatCount(s.units, locale)}</s-table-cell>
                    <s-table-cell>
                      {/* Right-aligned like its numeric header (live 2026-10-18: the amount sat left of "Cash"). */}
                      <s-stack direction="block" gap="none" alignItems="end">
                        <span>{money(s.cash)}</span>
                        {s.missingCost > 0 && (
                          <s-text color="subdued">{fill(plural(s.missingCost, t("1 line without a cost price"), t("{n} lines without a cost price")), { n: formatCount(s.missingCost, locale) })}</s-text>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      {/* The supplier's order-by date, as Order now, Sidekick and the Monday email show it (M2). */}
                      <SupplierDueCell events={s.events} today={plan.today} />
                    </s-table-cell>
                    <s-table-cell>
                      <span className="keha-nowrap">
                        <s-button variant="secondary" {...link(orderLink(s.events, s.supplierKey))}>
                          {t("Review order")}
                        </s-button>
                      </span>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </>
        )}
        {!plan.suppliersSetUp && (
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text color="subdued">{t("Grouped by vendor until you add your suppliers.")}</s-text>
            <s-link {...link("/app/settings/suppliers")}>{t("Add suppliers")}</s-link>
          </s-stack>
        )}
        <CantPlan plan={plan} />
        {/* One line on the Dashboard (0286): the 13 weekly bars and the breakdown live on Order plan ·
            Next 13 weeks — the Dashboard answers "what now", the calendar "what's coming". */}
        {(strip.lines > 0 || cashOut.committed > 0) && (
          <s-stack direction="block" gap="small-200">
            <div className="keha-row-between">
              <s-text fontWeight="medium">{fill(t("Cash needed, next 13 weeks: {cash}"), { cash: money(cashOut.any ? cashOut.total : null) })}</s-text>
              <s-link {...link("/app/reorder/calendar")}>{t("See the order calendar")}</s-link>
            </div>
            {strip.missingCost > 0 && (
              <s-text color="subdued">
                {fill(plural(strip.missingCost, t("1 line without a cost price is not in the cash totals."), t("{n} lines without a cost price are not in the cash totals.")), { n: formatCount(strip.missingCost, locale) })}
              </s-text>
            )}
          </s-stack>
        )}
      </s-stack>
    </FormCard>
  );
}

/**
 * The money at stake as one compact strip inside "Your stock today": two figures over the same
 * window (clarity pass 2026-10-23 — four figures over four periods couldn't be compared; lost sales
 * and sold-out page visits are on the Actions page). Each keeps "How we got this".
 */
/** The status words shown as counts, in order (Too much, Not selling and Learning only when there are any). */
const STOCK_BOXES: readonly OutcomeKey[] = ["orderNow", "orderSoon", "ok", "tooMuch", "notSelling", "learning"];
const ALWAYS: ReadonlySet<OutcomeKey> = new Set(["orderNow", "orderSoon", "ok"]);

/**
 * "Your stock today" (clarity pass 2026-10-23): what the app read, how the stock stands in the
 * status words (each count opens Products filtered), and the money at stake — the diagnosis a
 * merchant gets on first open, before any to-do list.
 */
function StockToday({ data }: { data: HomeLoaderData }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const count = (n: number) => formatCount(n, locale);
  const stock = data.stock;
  const trust = [
    // A ready store has sales: "We didn't find any sales yet" would contradict the numbers below.
    data.salesSpan.kind === "none" ? null : salesSpanText(data.salesSpan, t, count),
    stock && stock.total > 0
      ? fill(plural(stock.total, t("1 product is planned from the days it was in stock."), t("{n} products are planned, each from the days it was in stock.")), { n: count(stock.total) })
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <s-section heading={t("Your stock today")}>
      <s-stack direction="block" gap="base">
        <s-text color="subdued">{trust}</s-text>
        {stock && stock.total > 0 && (
          <div className="keha-stats">
            {STOCK_BOXES.filter((k) => ALWAYS.has(k) || stock[k] > 0).map((k) => {
              const to = link(`/app/products?outcome=${k}`);
              return (
                <a key={k} className="keha-stat" href={to.href} onClick={(e) => to.onClick(e.nativeEvent)}>
                  <span className="keha-stat__count">{count(stock[k])}</span>
                  <s-badge tone={outcomeTone(k)}>{outcomeLabel(k, t)}</s-badge>
                  <s-text color="subdued">{outcomeMeaning(k, t)}</s-text>
                </a>
              );
            })}
          </div>
        )}
        <MoneyStrip data={data} />
      </s-stack>
    </s-section>
  );
}

function MoneyStrip({ data }: { data: HomeData }) {
  const { t } = useLocale();
  const link = useLinkProps();
  const money = data.money;
  const fmt = useFmt(money?.currency ?? "USD");
  if (!money) return <s-paragraph color="subdued">{t("Your first numbers are being calculated.")}</s-paragraph>;
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text type="strong">{t("Money at stake")}</s-text>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
          {DASHBOARD_MONEY.map((key) => (
            <MoneyFigure key={key} cardKey={key} money={money} fmt={fmt} />
          ))}
        </s-grid>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text color="subdued">{fill(t("Numbers from {day}"), { day: fmt.day(money.day) })}</s-text>
          {data.syncView.partial && <s-text color="subdued">· {partialText(data.syncView.monthsRead, t, fmt.count)}</s-text>}
          {data.refresh !== "daily" && (
            <>
              <s-text color="subdued">· {t("Refreshed weekly on Free")}</s-text>
              <s-link {...link("/app/plans")}>{t("Upgrade")}</s-link>
            </>
          )}
        </s-stack>
        {data.recheckNotice && <s-text color="subdued">{recheckNoticeText(data.recheckNotice.corrected, t, fmt.count)}</s-text>}
      </s-stack>
    </s-box>
  );
}

function SetupStep({
  done,
  title,
  sub,
  action,
}: {
  done: boolean;
  title: string;
  sub: string;
  action: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <div className="keha-setup-step">
      <s-icon type={done ? "check-circle-filled" : "circle"} tone={done ? "success" : "neutral"} />
      <s-stack direction="block" gap="small-100">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text type="strong">{title}</s-text>
          {done ? <s-badge tone="success">{t("Done")}</s-badge> : <s-badge>{t("To do")}</s-badge>}
        </s-stack>
        <s-text color="subdued">{sub}</s-text>
      </s-stack>
      <div>{action}</div>
    </div>
  );
}

function SetupGuide({ data }: { data: HomeData }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const s = data.setup;
  const to = s.mondayRecipients.length > 0 ? s.mondayRecipients.join(", ") : t("the store owner");
  return (
    <s-section heading={t("Setup guide")}>
      <s-stack direction="block" gap="base">
        <SetupStep
          done={s.leadTimeDone}
          title={t("Lead times")}
          sub={
            s.leadTimeDone
              ? fill(t("Your suppliers take {n} days by default."), { n: s.leadTimeDays })
              : t("How long do your suppliers take?")
          }
          action={
            <s-button variant="secondary" {...link("/app/settings")}>
              {s.leadTimeDone ? t("Change") : t("Set lead time")}
            </s-button>
          }
        />
        <s-divider />
        <SetupStep
          done={s.suppliersDone}
          title={t("Suppliers")}
          sub={
            s.suppliersEnabled
              ? s.supplierCount > 0
                ? fill(s.supplierCount === 1 ? t("1 supplier set up.") : t("{n} suppliers set up."), { n: formatCount(s.supplierCount, locale) })
                : t("Add your suppliers' lead times and case packs — they set every order-by date.")
              : s.vendorCount === null
                ? t("We'll group your orders by vendor once your products are read.")
                : fill(t("Vendors found: {n}"), { n: formatCount(s.vendorCount, locale) })
          }
          action={
            s.suppliersEnabled ? (
              <s-button variant="secondary" {...link("/app/settings/suppliers")}>
                {s.supplierCount > 0 ? t("Change") : t("Add suppliers")}
              </s-button>
            ) : (
              <s-button variant="secondary" icon="lock" {...link("/app/plans?upgrade=suppliers")}>
                {`${t("Add suppliers")} · ${planTag("suppliers", t)}`}
              </s-button>
            )
          }
        />
        <s-divider />
        <SetupStep
          done={s.costsDone}
          title={t("Product costs")}
          sub={
            s.costPercent === null
              ? t("We'll check your product costs once your products are read.")
              : fill(t("Product costs found for {pct}% of products"), { pct: s.costPercent })
          }
          action={
            <s-button variant="secondary" href={SHOPIFY_PRODUCTS} target="_top">
              {t("Add costs in Shopify")}
            </s-button>
          }
        />
        <s-divider />
        {s.mondayViaFlow ? (
          // No email provider: the summary reaches the inbox through Shopify Flow (Settings → Alerts explains it).
          <SetupStep
            done
            title={t("Weekly summary")}
            sub={t("Get it by email with Shopify Flow: “Weekly order plan ready”.")}
            action={
              <s-button variant="secondary" {...link("/app/settings/alerts")}>
                {t("How it works")}
              </s-button>
            }
          />
        ) : (
          <SetupStep
            done={s.mondayEnabled}
            title={t("Weekly summary email")}
            sub={
              s.mondayEnabled
                ? fill(t("Every Monday at 08:00 to {to}"), { to })
                : t("Off. Turn it on to get your numbers and actions every Monday.")
            }
            action={
              <s-button variant="secondary" {...link("/app/settings/alerts")}>
                {t("Change")}
              </s-button>
            }
          />
        )}
      </s-stack>
    </s-section>
  );
}
