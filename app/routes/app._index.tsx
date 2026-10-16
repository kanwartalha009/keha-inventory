/**
 * Home (/app) — spec §5.1, §4 J1. Money at stake (4 cards, each with "How we
 * got this"), the setup guide (ticked from real state), sync progress per
 * dataset and the empty states. The loader reads only the database
 * (models/dashboard.server.ts); "This week's actions" arrive in phase 2.
 */
import type { ReactNode } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { planFor } from "../services/entitlements.server";
import { getHomeData } from "../models/dashboard.server";
import { AppPage } from "../components/ui";
import { useLinkProps } from "../components/wc";
import { fill, useLocale } from "../lib/i18n";
import { MONEY_CARDS, type MoneyCardKey } from "../lib/money-shared";
import {
  basisLines,
  datasetLabel,
  formatAmount,
  formatCount,
  formatDay,
  formatPercent,
  formatUpdatedAt,
  moneyCardTitle,
  type Fmt,
  type HomeData,
} from "../lib/dashboard-shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const plan = await planFor(session.shop);
  return getHomeData(session.shop, plan);
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

/** Shopify's own product list (cost per item lives there); outside the app iframe. */
const SHOPIFY_PRODUCTS = "shopify://admin/products";

export default function Home() {
  const { t, locale } = useLocale();
  const data = useLoaderData<typeof loader>() as HomeData;
  const updated = formatUpdatedAt(data.lastNightlyAt, data.timezone, locale);

  return (
    <AppPage heading={data.storeName || t("Home")} intro={fill(t("Data updated {time}"), { time: updated })}>
      {data.dataLate && <s-banner tone="warning">{t("Data is late — no action needed, we're retrying.")}</s-banner>}

      {data.state === "ready" && <MoneyAtStake data={data} />}

      {data.state === "noSales" && (
        <s-section heading={t("Not enough sales yet to advise")}>
          <s-paragraph>{t("We need at least 14 days of sales to give advice.")}</s-paragraph>
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

      {!data.sync.done && <SyncProgress data={data} />}

      {!data.setup.allDone && <SetupGuide data={data} />}
    </AppPage>
  );
}

function useFmt(currency: string): Fmt {
  const { locale } = useLocale();
  return {
    money: (v) => formatAmount(v, currency, locale),
    count: (v) => formatCount(v, locale),
    percent: (v) => formatPercent(v, locale),
    day: (v) => formatDay(v, locale),
  };
}

function MoneyAtStake({ data }: { data: HomeData }) {
  const { t } = useLocale();
  const link = useLinkProps();
  const money = data.money;
  const fmt = useFmt(money?.currency ?? "USD");
  return (
    <s-section heading={t("Money at stake")}>
      <s-stack direction="block" gap="base">
        {money ? (
          <>
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
              {MONEY_CARDS.map((key) => (
                <MoneyCard key={key} cardKey={key} data={data} fmt={fmt} />
              ))}
            </s-grid>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text color="subdued">{fill(t("Numbers from {day}"), { day: fmt.day(money.day) })}</s-text>
              {data.refresh === "monthly" && (
                <>
                  <s-text color="subdued">· {t("Refreshed monthly on Free")}</s-text>
                  <s-link {...link("/app/plans")}>{t("Upgrade")}</s-link>
                </>
              )}
            </s-stack>
          </>
        ) : (
          <s-paragraph color="subdued">{t("Your first numbers are being calculated.")}</s-paragraph>
        )}
      </s-stack>
    </s-section>
  );
}

function MoneyCard({ cardKey, data, fmt }: { cardKey: MoneyCardKey; data: HomeData; fmt: Fmt }) {
  const { t } = useLocale();
  const value = data.money?.values[cardKey] ?? null;
  const lines = basisLines(cardKey, data.money?.basis ?? null, t, fmt);
  const title = moneyCardTitle(cardKey, t);
  const popId = `keha-how-${cardKey}`;
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{title}</s-text>
        <span className="keha-money__value">{fmt.money(value)}</span>
        {value === null && <s-text color="subdued">{t("Not enough sales yet to advise")}</s-text>}
        <s-stack direction="inline">
          <s-button variant="tertiary" icon="info" commandFor={popId} accessibilityLabel={`${t("How we got this")}: ${title}`}>
            {t("How we got this")}
          </s-button>
        </s-stack>
        <s-popover id={popId}>
          <s-box padding="base" maxInlineSize="360px">
            <s-stack direction="block" gap="small-200">
              <s-heading>{title}</s-heading>
              {lines.length > 0 ? (
                lines.map((l, i) => (
                  <s-text key={i} color={i === lines.length - 1 ? "subdued" : "base"}>
                    {l}
                  </s-text>
                ))
              ) : (
                <s-text color="subdued">{t("The details appear after the next calculation.")}</s-text>
              )}
            </s-stack>
          </s-box>
        </s-popover>
      </s-stack>
    </s-box>
  );
}

function SyncProgress({ data }: { data: HomeData }) {
  const { t } = useLocale();
  const partial = data.state === "ready" || data.sync.first90Ready;
  return (
    <s-section heading={t("Reading your store…")}>
      <s-stack direction="block" gap="base">
        <s-paragraph color="subdued">
          {partial
            ? t("Your numbers use the last 90 days. Older months are still loading.")
            : t("Your money-at-stake numbers and this week's actions will appear here once your products, stock and sales are read.")}
        </s-paragraph>
        {data.sync.datasets.map((d) => {
          const label = datasetLabel(d.key, t);
          return (
            <s-stack key={d.key} direction="block" gap="small-200">
              <div className="keha-row-between">
                <s-text>{label}</s-text>
                <s-text color="subdued">{d.percent}%</s-text>
              </div>
              <s-progress value={d.percent} max={100} accessibilityLabel={label} tone={d.failed ? "critical" : "auto"} />
              {d.failed && <s-text color="subdued">{t("We hit a problem reading this. We're retrying automatically.")}</s-text>}
            </s-stack>
          );
        })}
      </s-stack>
    </s-section>
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
  const { t } = useLocale();
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
        <SetupStep
          done={s.mondayEnabled}
          title={t("Monday email")}
          sub={
            s.mondayEnabled
              ? fill(t("Every Monday at 08:00 to {to}"), { to })
              : t("Off. Turn it on to get your numbers and actions every Monday.")
          }
          action={
            <s-button variant="secondary" {...link("/app/settings")}>
              {t("Change")}
            </s-button>
          }
        />
      </s-stack>
    </s-section>
  );
}
