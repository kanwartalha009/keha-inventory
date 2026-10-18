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
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateApp } from "../services/data-scope.server";
import { enqueueJob } from "../services/jobs/queue.server";
import { AppPage, Disclosure, FormCard, FormSaveBar, sameValues } from "../components/ui";
import { settingsHelp } from "../components/help";
import { SettingsTabs } from "../components/settings-tabs";
import { ChoiceListField, SelectField, val } from "../components/wc";
import { LOCALES, LOCALE_NAMES, fill, useLocale, type Locale, plural } from "../lib/i18n";
import {
  SETTINGS_BOUNDS,
  applySettingsForm,
  settingsToForm,
  type SafetyLevel,
  type SettingsErrors,
  type SettingsForm,
  type TrendMode,
} from "../lib/settings-shared";
import { getShopSettings, hasLocationLeftOut, salesChannels, saveShopSettings, type SalesChannelRow } from "../models/settings.server";
import { storeCurrency } from "../models/suppliers.server";
import { formatCount } from "../lib/dashboard-shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await authenticateApp(request);
  const settings = await getShopSettings(shop);
  const [currency, channels, locationLeftOut] = await Promise.all([storeCurrency(shop), salesChannels(shop, settings.excludedChannels), hasLocationLeftOut(shop)]);
  return { form: settingsToForm(settings), currency, channels, locationLeftOut };
};

type ActionData = { ok: true; form: SettingsForm } | { ok: false; errors?: SettingsErrors; notReady?: boolean };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { shop } = await authenticateApp(request);
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
    // Absent (an older page): the budget stays as saved.
    ...(body.monthlyBudget !== undefined ? { monthlyBudget: String(body.monthlyBudget ?? "") } : {}),
    excludedChannels: Array.isArray(body.excludedChannels) ? body.excludedChannels.map(String) : undefined,
  };
  const current = await getShopSettings(shop);
  const r = applySettingsForm(current, form, new Date());
  if (!r.ok) return { ok: false, errors: r.errors };
  const saved = await saveShopSettings(shop, r.settings);
  if (!saved) return { ok: false, notReady: true };
  // Lead time, order days, safety stock and growth feed the stored forecast inputs: recompute now
  // so the plan uses them within minutes (audit 2026-10-18).
  await enqueueJob(shop, "compute");
  return { ok: true, form: settingsToForm(saved) };
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

type NumberKey = keyof typeof SETTINGS_BOUNDS;

export default function Settings() {
  const { t, locale, setLocale } = useLocale();
  const loaded = useLoaderData<typeof loader>() as { form: SettingsForm; currency: string; channels?: SalesChannelRow[]; locationLeftOut?: boolean };
  const initial = loaded.form;
  const currency = loaded.currency;
  const channels = loaded.channels ?? [];
  const fetcher = useFetcher<ActionData>();
  const [form, setForm] = useState<SettingsForm>(initial);
  const [saved, setSaved] = useState<SettingsForm>(initial);
  // A non-default growth assumption, a budget or a channel left out keeps More options open, so it is never a hidden surprise.
  // ?more=1: a "Change" link from an explanation (safety stock, order days) lands with the field showing.
  const [params] = useSearchParams();
  const [more, setMore] = useState(params.get("more") === "1" || initial.trendMode === "store" || !!initial.monthlyBudget || (initial.excludedChannels ?? []).length > 0);
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
  const set = (key: keyof SettingsForm, value: string | boolean | string[]) => setForm((f) => ({ ...f, [key]: value }));
  const excluded = form.excludedChannels ?? [];
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
    <AppPage heading={t("Settings")} help={settingsHelp(t, "defaults")}>
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
            t("Default lead time"),
            t("Days from placing an order to the stock arriving. Used for every product until you add suppliers."),
          )}
          <Disclosure id="settings-more" title={t("More options")} open={more} onToggle={() => setMore((m) => !m)}>
            <s-stack direction="block" gap="base">
              {numberField("cycleDays", t("Order enough for"), t("Days of stock each order should last after it arrives — usually how often you order. Suggested quantities cover the lead time plus these days. You can change it for a single order."))}
              {numberField("tooMuchDays", t("Overstock after"), t("A product is marked Overstock when its stock would last longer than this."))}
              {numberField("deadDays", t("Dead stock after"), t("A product is marked Dead stock when it hasn't sold for this long."))}
              <SelectField<SafetyLevel>
                label={t("Safety stock")}
                value={form.safetyLevel as SafetyLevel}
                options={[
                  { value: "lean", label: t("Low") },
                  { value: "balanced", label: t("Standard") },
                  { value: "safe", label: t("High") },
                ]}
                onChange={(v) => set("safetyLevel", v)}
                details={t("Extra stock for surprises in demand: High runs out less often but ties up more cash, Low the opposite.")}
              />
              <ChoiceListField<TrendMode>
                label={t("Year-over-year growth")}
                choices={[
                  { value: "off", label: t("Off (recommended)"), helpText: t("Use today's sales pace and season.") },
                  {
                    value: "store",
                    label: t("Add the store's year-over-year growth"),
                    helpText: t("Today's sales pace already includes recent growth, so adding it again usually orders too much."),
                  },
                ]}
                selected={[form.trendMode as TrendMode]}
                onChange={(v) => v[0] && set("trendMode", v[0])}
              />
              <s-number-field
                label={t("Monthly purchasing budget")}
                details={t("Optional. The Order calendar compares each month's supplier payments with it and suggests which orders could wait. Leave empty for no budget.")}
                value={form.monthlyBudget ?? ""}
                suffix={currency}
                inputMode="decimal"
                min={0}
                step={1}
                error={err("monthlyBudget")}
                onInput={(e) => set("monthlyBudget", val(e))}
              />
              {channels.length > 0 && (
                <s-stack direction="block" gap="small-200">
                  <ChoiceListField<string>
                    label={t("Sales channels in the forecast")}
                    multiple
                    choices={channels.map((c) => ({
                      value: c.name,
                      label: c.name,
                      helpText: fill(plural(c.units, t("1 unit in the last 12 months"), t("{n} units in the last 12 months")), { n: formatCount(c.units, locale) }),
                    }))}
                    selected={channels.filter((c) => !excluded.includes(c.name)).map((c) => c.name)}
                    onChange={(kept) => set("excludedChannels", channels.map((c) => c.name).filter((n) => !kept.includes(n)))}
                  />
                  <s-text color="subdued">
                    {t("Untick a channel whose stock you order separately, for example wholesale ordered to order. Its sales stop counting as demand for purchase orders. Every channel counts by default.")}
                  </s-text>
                  {loaded.locationLeftOut && excluded.length > 0 && (
                    <s-banner tone="warning">
                      {t("A location is left out of purchase orders (Settings → Locations), so the forecast uses sales by location. Shopify reports sales by location or by channel, not both, so the channels unticked here aren't applied while a location is left out.")}
                    </s-banner>
                  )}
                </s-stack>
              )}
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
