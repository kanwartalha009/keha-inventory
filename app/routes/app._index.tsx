/**
 * Home (/app). Placeholder until task 1.6 builds the real screen (spec §5.1:
 * money at stake, this week's actions, setup guide, sync progress). Shows no
 * numbers: nothing is synced yet, and the app never shows invented figures.
 */
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { AppPage } from "../components/ui";
import { useLocale } from "../lib/i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export default function Home() {
  const { t } = useLocale();
  return (
    <AppPage heading={t("Home")}>
      <s-section>
        <s-stack direction="block" gap="small">
          <s-heading>{t("Reading your store…")}</s-heading>
          <s-paragraph color="subdued">
            {t("Your money-at-stake numbers and this week's actions will appear here once your products, stock and sales are read.")}
          </s-paragraph>
        </s-stack>
      </s-section>
    </AppPage>
  );
}
