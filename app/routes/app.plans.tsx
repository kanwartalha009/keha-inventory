/**
 * Plans & billing (/app/plans). Shopify App Pricing: prices, trials and plan
 * changes live on Shopify's own plan page (every "Choose plan" / "Change
 * plan" button opens it). This page shows the current plan (synced from the
 * Partner API — app-pricing.server) and Free / Growth / Pro (spec §3):
 * prices from the Nova catalog, features from app/lib/plan-shared.ts.
 */
import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppPage, FormCard, Segmented } from "../components/ui";
import { flag } from "../components/wc";
import { planName } from "../components/plan";
import { PLAN_CODES, type PlanCode } from "../lib/plan-shared";
import { INHERITS, PLAN_MATRIX, PLAN_PITCH, PLAN_POINTS, cellFor, type Cell } from "../lib/plan-matrix";

import { authenticate } from "../shopify.server";
import { useLocale } from "../lib/i18n";
import { getPlans, getPlanOverride } from "../services/plans.server";
import { forgetEntitlements, getEntitlements } from "../services/entitlements.server";
import { getBillingState } from "../services/billing.server";
import { syncPlan, pricingConfigured } from "../services/app-pricing.server";
import { planSelectionUrl } from "../lib/admin-url.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  // Fresh plan on this page (the merchant may just have changed it).
  if (pricingConfigured()) await syncPlan(admin, session.shop, { force: true });
  forgetEntitlements(session.shop);
  const { plan, checked } = await getEntitlements(session.shop);
  const [plans, billing, override] = await Promise.all([
    getPlans(),
    getBillingState(session.shop),
    getPlanOverride(session.shop),
  ]);
  return {
    plans,
    plan,
    billing,
    comped: override.type === "FREE",
    // false = the plan check is off or failed: everything stays on (fail open),
    // so don't present that as a plan the merchant is on.
    checked,
    manageUrl: planSelectionUrl(session.shop),
  };
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);

export default function PlansPage() {
  const { t } = useLocale();
  const { plans, plan, billing, comped, manageUrl, checked } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [interval, setInterval] = useState<"EVERY_30_DAYS" | "ANNUAL">("EVERY_30_DAYS");
  // Shopify's plan page is outside the app iframe: App Bridge routes "_top".
  const openPlans = () => window.open(manageUrl, "_top");
  const current: PlanCode | "none" | null = checked || comped ? plan : null;
  const onPlan = current != null && current !== "none" && current !== "free";

  return (
    <AppPage
      heading={t("Plans & billing")}
      intro={t("Start free with your 10 most urgent orders. Growth plans every order by supplier, with purchase orders and the cash per week. Pro plans each warehouse and store.")}
    >
      {comped && <s-banner tone="success">{t("Your plan is comped — no charge.")}</s-banner>}

      {/* Fail open (plan-shared effectivePlan): when Shopify hasn't confirmed a plan, everything
          is on — say exactly that instead of naming a plan the merchant may not be on. */}
      <FormCard
        title={t("Your plan")}
        sub={current == null ? t("Shopify hasn't confirmed a plan for your store yet, so every feature is on.") : undefined}
        action={
          <span className="keha-inline">
            <s-badge tone={current == null ? "info" : billing?.status === "TRIAL" ? "info" : "success"}>
              {current == null
                ? t("All features on")
                : billing?.status === "TRIAL"
                  ? `${planName(current, t)} · ${t("Free trial")}`
                  : planName(current, t)}
            </s-badge>
            <s-button variant="secondary" onClick={openPlans}>
              {onPlan ? t("Change plan") : t("Choose plan")}
            </s-button>
          </span>
        }
      />

      {plans.length === 0 ? (
        <FormCard
          title={t("Plans couldn't be loaded")}
          sub={t("This is usually a brief connection hiccup — your store and settings are unaffected. Try again in a moment.")}
        >
          <s-stack direction="inline">
            <s-button variant="primary" onClick={() => revalidator.revalidate()} loading={flag(revalidator.state !== "idle")}>
              {t("Try again")}
            </s-button>
          </s-stack>
        </FormCard>
      ) : (
        <>
          <s-stack direction="block" gap="small-200" alignItems="center">
            <Segmented
              label={t("Billing period")}
              value={interval}
              onChange={setInterval}
              options={[
                { value: "EVERY_30_DAYS", label: t("Monthly") },
                { value: "ANNUAL", label: t("Annual (2 months free)") },
              ]}
            />
            <s-text color="subdued">{t("No revenue tiers or SKU limits.")}</s-text>
          </s-stack>

          {/* One row per plan: name, price and button on the left, what it includes on the
              right — wide enough for each point to stay on one line (.keha-plan). */}
          {plans.map((p) => {
            const code = p.code as PlanCode;
            const free = p.amountMonthly === 0;
            const minor = interval === "ANNUAL" && !free ? Math.round(p.amountAnnual / 12) : p.amountMonthly;
            const isCurrent = current === code;
            return (
              <s-section key={p.code} accessibilityLabel={t(p.name)}>
                <div className="keha-plan">
                  <s-stack direction="block" gap="base">
                    <s-stack direction="block" gap="small-200">
                      <span className="keha-inline">
                        <s-heading>{t(p.name)}</s-heading>
                        {isCurrent ? (
                          <s-badge tone="success">{t("Current")}</s-badge>
                        ) : code === "growth" ? (
                          <s-badge tone="info">{t("Recommended")}</s-badge>
                        ) : null}
                      </span>
                      <s-text color="subdued">{t(PLAN_PITCH[code] ?? "")}</s-text>
                    </s-stack>
                    <s-stack direction="block" gap="none">
                      <s-text type="strong">
                        <span className="keha-num">{free ? t("Free") : `${money(minor, p.currency)} ${t("/mo")}`}</span>
                      </s-text>
                      <s-text color="subdued">
                        {free
                          ? t("Free forever")
                          : interval === "ANNUAL"
                            ? `${money(p.amountAnnual, p.currency)} ${t("billed yearly")}`
                            : p.trialDays > 0
                              ? t("{n}-day free trial").replace("{n}", String(p.trialDays))
                              : t("Billed monthly")}
                      </s-text>
                    </s-stack>
                    <s-stack direction="inline">
                      <s-button
                        variant={isCurrent ? "secondary" : code === "growth" ? "primary" : "secondary"}
                        disabled={flag(isCurrent)}
                        onClick={openPlans}
                      >
                        {isCurrent ? t("Current plan") : t("Choose plan")}
                      </s-button>
                    </s-stack>
                  </s-stack>
                  <div className="keha-plan__points">
                    {INHERITS[code] && <s-text color="subdued">{t(INHERITS[code] as string)}</s-text>}
                    {(PLAN_POINTS[code] ?? []).map((pt) => (
                      // Icon column + text column: a point that must wrap (narrow screens) wraps under its own text.
                      <div key={pt} className="keha-point">
                        <s-icon type="check" tone="success" size="small" />
                        <s-text>{t(pt)}</s-text>
                      </div>
                    ))}
                  </div>
                </div>
              </s-section>
            );
          })}
          <ComparePlans plans={plans} current={current} />
        </>
      )}

      <s-paragraph color="subdued">
        {t("Billed through Shopify. Choose, change or cancel your plan on Shopify's plan page any time. A downgrade never deletes your data.")}
      </s-paragraph>
    </AppPage>
  );
}

type CatalogPlan = { code: string; name: string };

/** Every feature, plan by plan (PLAN_MATRIX). */
function ComparePlans({ plans, current }: { plans: CatalogPlan[]; current: PlanCode | "none" | null }) {
  const { t } = useLocale();
  const byCode = new Map(plans.map((p) => [p.code, p]));
  const codes = PLAN_CODES.filter((c) => byCode.has(c));
  const cell = (c: Cell) =>
    c === true ? (
      <>
        <s-icon type="check" tone="success" size="small" />
        <s-text accessibilityVisibility="exclusive">{t("Included")}</s-text>
      </>
    ) : c === false ? (
      <>
        <s-text color="subdued" accessibilityVisibility="hidden">—</s-text>
        <s-text accessibilityVisibility="exclusive">{t("Not included")}</s-text>
      </>
    ) : (
      <s-text>{t(c)}</s-text>
    );
  // One table, so the plan columns line up from top to bottom; each group is a
  // bold row inside it.
  const groupRow = (title: string) => (
    <s-table-row key={`g-${title}`}>
      <s-table-cell>
        <s-text type="strong">{t(title)}</s-text>
      </s-table-cell>
      {codes.map((c) => (
        <s-table-cell key={c}>{""}</s-table-cell>
      ))}
    </s-table-row>
  );
  return (
    <FormCard flush title={t("Compare plans")}>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">{t("Feature")}</s-table-header>
          {codes.map((c) => (
            <s-table-header key={c}>{current === c ? `${t(byCode.get(c)!.name)} · ${t("Current")}` : t(byCode.get(c)!.name)}</s-table-header>
          ))}
        </s-table-header-row>
        <s-table-body>
          {PLAN_MATRIX.flatMap((g) => [
            groupRow(g.title),
            ...g.rows.map((r) => (
              <s-table-row key={r.label}>
                <s-table-cell>
                  <s-stack direction="block" gap="none">
                    <s-text>{t(r.label)}</s-text>
                    {r.hint && <s-text color="subdued">{t(r.hint)}</s-text>}
                  </s-stack>
                </s-table-cell>
                {codes.map((c) => (
                  <s-table-cell key={c}>{cell(cellFor(r, c))}</s-table-cell>
                ))}
              </s-table-row>
            )),
          ])}
        </s-table-body>
      </s-table>
    </FormCard>
  );
}
