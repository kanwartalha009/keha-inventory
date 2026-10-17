/**
 * Plan UI (Free / Growth / Pro — app/lib/plan-shared.ts): the "on the Growth
 * plan" notes, the Upgrade banner an action returns, and the page shown in
 * place of a page the plan doesn't include. Paid features stay visible with
 * one line on what they do (progressive disclosure, nothing hidden).
 */
import { useSearchParams } from "react-router";
import { useLocale } from "../lib/i18n";
import { useLinkProps } from "./wc";
import { FEATURE_PLAN, PLAN_LABEL, requiredPlan, type Feature, type PlanCode } from "../lib/plan-shared";

type T = (s: string) => string;

/** What each paid feature does, in one line (shown on locked controls and pages). */
export function featureCopy(feature: Feature, t: T): { title: string; body: string } {
  switch (feature) {
    case "dailyRefresh":
      return { title: t("Daily numbers"), body: t("Your money-at-stake numbers refresh every night instead of once a week.") };
    case "fullActionList":
      return { title: t("Every action, every week"), body: t("See the whole ranked list of what to reorder, promote, fix and clear, not just the top 10.") };
    case "forecast":
      return { title: t("Days of stock left"), body: t("See how many days each variant will last and how many to order.") };
    case "reorderPlan":
      return { title: t("Order plan"), body: t("Know what to order from each supplier, how much, and by which date.") };
    case "orderCalendar":
      return { title: t("13-week order calendar"), body: t("Every order for the next 13 weeks, by week and supplier, with the cash you need each week.") };
    case "suppliers":
      return { title: t("Suppliers"), body: t("Keep lead times, minimum orders and case packs for each supplier.") };
    case "poExport":
      return { title: t("Purchase orders"), body: t("Send your supplier a purchase order as PDF, CSV or email.") };
    case "supplierConfirm":
      return { title: t("Supplier confirmation"), body: t("Your supplier confirms the ship date through a link, with no login.") };
    case "bridge":
      return { title: t("What to do while a best seller is sold out"), body: t("Until its stock arrives: how to collect back-in-stock sign-ups on the product page.") };
    case "clearance":
      return { title: t("Clear dead stock"), body: t("Create a Shopify discount for products that don't sell, and see the cash it frees.") };
    case "fixDetails":
      return { title: t("Fix what's holding sales back"), body: t("Missing sizes, weak product pages, high returns and falling best sellers, product by product.") };
    case "planner":
      return { title: t("Season plan"), body: t("Plan a season or a growth target: what to order, by when, and the cash you need each week.") };
    case "collectionGoals":
      return { title: t("Collection goals"), body: t("Set a revenue share per collection and see which products hold it back.") };
    case "accuracy":
      return { title: t("Forecast accuracy"), body: t("Every month, see how close our forecasts were to what you actually sold.") };
    case "slack":
      return { title: t("Slack"), body: t("Get the Monday summary and urgent alerts in Slack.") };
    case "flowTriggers":
      return { title: t("Shopify Flow"), body: t("Start your own Flow automations when a product needs reordering or goes dead.") };
    case "csvExport":
      return { title: t("CSV export"), body: t("Download the products table to work with it in a spreadsheet.") };
    case "locations":
      return { title: t("Locations and stores"), body: t("Plan stock per warehouse and per POS store, each with its own sales.") };
    case "transfers":
      return { title: t("Transfers"), body: t("Plan which stock to move from your warehouse to your stores, and create the transfer in Shopify.") };
  }
}

export const planName = (plan: PlanCode | "none", t: T) => (plan === "none" ? t("No plan") : t(PLAN_LABEL[plan]));

/** "Growth plan" / "Pro plan" label for a feature. */
export function planTag(feature: Feature, t: T): string {
  return t(`${PLAN_LABEL[requiredPlan(feature)]} plan`);
}

/** Banner with an Upgrade button (actions return { error, upgrade: { feature, plan } }). */
export function UpgradeBanner({
  feature,
  message,
  onDismiss,
}: {
  feature: Feature;
  message?: string;
  onDismiss?: () => void;
}) {
  const { t } = useLocale();
  const link = useLinkProps();
  const copy = featureCopy(feature, t);
  return (
    <s-banner tone="info" heading={message ? t(message) : copy.title} dismissible={onDismiss ? true : undefined} onDismiss={onDismiss}>
      <s-paragraph>{copy.body}</s-paragraph>
      <s-button slot="secondary-actions" variant="primary" {...link("/app/plans")}>
        {t("See plans")}
      </s-button>
    </s-banner>
  );
}

/** Banner for `?upgrade=<feature>` (set by a bulk action that hit the plan). */
export function UpgradeFromQuery() {
  const [params, setParams] = useSearchParams();
  const f = params.get("upgrade") as Feature | null;
  if (!f || !(f in FEATURE_PLAN)) return null;
  return (
    <UpgradeBanner
      feature={f}
      onDismiss={() => {
        const next = new URLSearchParams(params);
        next.delete("upgrade");
        setParams(next, { replace: true });
      }}
    />
  );
}

/** Shown instead of a page the store's plan doesn't include. */
export function LockedPage({ feature }: { feature: Feature }) {
  const { t } = useLocale();
  const link = useLinkProps();
  const copy = featureCopy(feature, t);
  return (
    <s-page heading={copy.title}>
      <s-section>
        <s-empty-state heading={`${copy.title} · ${planTag(feature, t)}`}>
          <s-paragraph slot="subheading">{copy.body}</s-paragraph>
          <s-button slot="primary-action" variant="primary" {...link("/app/plans")}>
            {t("See plans")}
          </s-button>
        </s-empty-state>
      </s-section>
    </s-page>
  );
}
