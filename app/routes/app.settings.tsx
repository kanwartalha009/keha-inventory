/**
 * Settings (/app/settings). Spec §5.5. Today: the app language (stored per
 * browser, the kit's manual override). Defaults, suppliers, locations and
 * alerts are added by the tasks that build them.
 */
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { AppPage } from "../components/ui";
import { SelectField } from "../components/wc";
import { LOCALES, LOCALE_NAMES, useLocale, type Locale } from "../lib/i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export default function Settings() {
  const { t, locale, setLocale } = useLocale();
  return (
    <AppPage heading={t("Settings")}>
      <s-section heading={t("Language")}>
        <SelectField<Locale>
          label={t("App language")}
          value={locale}
          options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
          onChange={setLocale}
          details={t("Only changes the app for you in this browser. Emails use your store's language.")}
        />
      </s-section>
    </AppPage>
  );
}
