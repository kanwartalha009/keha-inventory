/**
 * Settings (/app/settings), spec §5.5. The Defaults tab: lead time (with
 * order cycle, thresholds, safety level and the growth assumption under
 * "More options") and the app language. The
 * Monday email, Slack and instant alerts live on the Alerts tab
 * (app.settings_.alerts.tsx); suppliers and locations on their own tabs.
 * At most 8 visible fields per section (spec §5.5); everything has a default.
 * Saves through the contextual save bar, like every settings tab.
 */
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { AppPage, Disclosure, FormCard, FormSaveBar, sameValues } from "../components/ui";
import { SettingsTabs } from "../components/settings-tabs";
import { ChoiceListField, SelectField, val } from "../components/wc";
import { LOCALES, LOCALE_NAMES, fill, useLocale, type Locale } from "../lib/i18n";
import {
  SETTINGS_BOUNDS,
  applySettingsForm,
  settingsToForm,
  type SafetyLevel,
  type SettingsErrors,
  type SettingsForm,
  type TrendMode,
} from "../lib/settings-shared";
import { getShopSettings, saveShopSettings } from "../models/settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getShopSettings(session.shop);
  return { form: settingsToForm(settings) };
};

type ActionData = { ok: true; form: SettingsForm } | { ok: false; errors?: SettingsErrors; notReady?: boolean };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { session } = await authenticate.admin(request);
  let body: Partial<SettingsForm>;
  try {
    body = (await request.json()) as Partial<SettingsForm>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  const form: SettingsForm = {
    leadTimeDays: String(body.leadTimeDays ?? ""),
    cycleDays: String(body.cycleDays ?? ""),
    tooMuchDays: String(body.tooMuchDays ?? ""),
    deadDays: String(body.deadDays ?? ""),
    safetyLevel: String(body.safetyLevel ?? ""),
    trendMode: String(body.trendMode ?? ""),
  };
  const current = await getShopSettings(session.shop);
  const r = applySettingsForm(current, form, new Date());
  if (!r.ok) return { ok: false, errors: r.errors };
  const saved = await saveShopSettings(session.shop, r.settings);
  if (!saved) return { ok: false, notReady: true };
  return { ok: true, form: settingsToForm(saved) };
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

type NumberKey = keyof typeof SETTINGS_BOUNDS;

export default function Settings() {
  const { t, locale, setLocale } = useLocale();
  const { form: initial } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const [form, setForm] = useState<SettingsForm>(initial);
  const [saved, setSaved] = useState<SettingsForm>(initial);
  // A non-default growth assumption keeps More options open, so it is never a hidden surprise.
  const [more, setMore] = useState(initial.trendMode === "store");
  const saving = fetcher.state !== "idle";
  const result = fetcher.data;
  const errors = result && !result.ok ? (result.errors ?? {}) : {};

  useEffect(() => {
    if (result?.ok) {
      setForm(result.form);
      setSaved(result.form);
    }
  }, [result]);

  const err = (key: keyof SettingsForm) => {
    const msg = errors[key];
    if (!msg) return undefined;
    return key in SETTINGS_BOUNDS ? fill(t(msg), SETTINGS_BOUNDS[key as NumberKey]) : t(msg);
  };
  const set = (key: keyof SettingsForm, value: string | boolean) => setForm((f) => ({ ...f, [key]: value }));
  const save = () => fetcher.submit(form, { method: "post", encType: "application/json" });

  const numberField = (key: NumberKey, label: string, details: string) => (
    <s-number-field
      label={label}
      details={details}
      value={form[key]}
      min={SETTINGS_BOUNDS[key].min}
      max={SETTINGS_BOUNDS[key].max}
      step={1}
      suffix={t("days")}
      error={err(key)}
      onInput={(e) => set(key, val(e))}
    />
  );

  return (
    <AppPage heading={t("Settings")}>
      <FormSaveBar id="keha-settings-defaults" dirty={!sameValues(form, saved)} saving={saving} onSave={save} onDiscard={() => setForm(saved)} />
      <SettingsTabs current="defaults" />
      {result?.ok && <s-banner tone="success">{t("Settings saved.")}</s-banner>}
      {result && !result.ok && result.notReady && (
        <s-banner tone="info">{t("We're still reading your store. Try again in a minute.")}</s-banner>
      )}

      <FormCard title={t("Defaults")} sub={t("Lead time and stock thresholds used for every product.")}>
        <s-stack direction="block" gap="base">
          {numberField(
            "leadTimeDays",
            t("How long do your suppliers take?"),
            t("Days from placing an order to the stock arriving. Used for every product until you add suppliers."),
          )}
          <Disclosure id="settings-more" title={t("More options")} open={more} onToggle={() => setMore((m) => !m)}>
            <s-stack direction="block" gap="base">
              {numberField("cycleDays", t("Order cycle"), t("How often you place orders. Suggested quantities cover the lead time plus one cycle."))}
              {numberField("tooMuchDays", t("Too much stock after"), t("A product is marked Too much when its stock would last longer than this."))}
              {numberField("deadDays", t("Dead after"), t("A product is marked Dead when it hasn't sold for this long."))}
              <SelectField<SafetyLevel>
                label={t("Safety level")}
                value={form.safetyLevel as SafetyLevel}
                options={[
                  { value: "lean", label: t("Lean") },
                  { value: "balanced", label: t("Balanced") },
                  { value: "safe", label: t("Safe") },
                ]}
                onChange={(v) => set("safetyLevel", v)}
                details={t("Extra stock for surprises in demand: Safe runs out less often but ties up more cash, Lean the opposite.")}
              />
              <ChoiceListField<TrendMode>
                label={t("Growth assumption")}
                choices={[
                  { value: "off", label: t("Off (recommended)"), helpText: t("Use today's sales pace and season.") },
                  {
                    value: "store",
                    label: t("Add the store's year-on-year growth"),
                    helpText: t("Today's sales pace already includes recent growth, so adding it again usually orders too much."),
                  },
                ]}
                selected={[form.trendMode as TrendMode]}
                onChange={(v) => v[0] && set("trendMode", v[0])}
              />
            </s-stack>
          </Disclosure>
        </s-stack>
      </FormCard>

      <FormCard title={t("Language")} sub={t("Only changes the app for you in this browser. Emails use your store's language.")}>
        <SelectField<Locale>
          label={t("App language")}
          value={locale}
          options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
          onChange={setLocale}
        />
      </FormCard>
    </AppPage>
  );
}
