/**
 * Settings (/app/settings), spec §5.5. Phase 1: defaults (lead time, with
 * order cycle and thresholds under "More options"), the Monday email, and the
 * app language. Suppliers, locations and Slack join with their tasks.
 * At most 8 visible fields per section (spec §5.5); everything has a default.
 */
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { AppPage, Disclosure } from "../components/ui";
import { SettingsTabs } from "../components/settings-tabs";
import { SelectField, flag, isChecked, val } from "../components/wc";
import { LOCALES, LOCALE_NAMES, fill, useLocale, type Locale } from "../lib/i18n";
import {
  SETTINGS_BOUNDS,
  applySettingsForm,
  settingsToForm,
  type SafetyLevel,
  type SettingsErrors,
  type SettingsForm,
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
    mondayEnabled: body.mondayEnabled === true,
    recipients: String(body.recipients ?? ""),
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
  const [more, setMore] = useState(false);
  const saving = fetcher.state !== "idle";
  const result = fetcher.data;
  const errors = result && !result.ok ? (result.errors ?? {}) : {};

  useEffect(() => {
    if (result?.ok) setForm(result.form);
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
    <AppPage
      heading={t("Settings")}
      primaryAction={
        <s-button variant="primary" onClick={save} loading={flag(saving)}>
          {t("Save")}
        </s-button>
      }
    >
      <SettingsTabs current="defaults" />
      {result?.ok && <s-banner tone="success">{t("Settings saved.")}</s-banner>}
      {result && !result.ok && result.notReady && (
        <s-banner tone="info">{t("We're still reading your store. Try again in a minute.")}</s-banner>
      )}

      <s-section heading={t("Defaults")}>
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
            </s-stack>
          </Disclosure>
        </s-stack>
      </s-section>

      <s-section heading={t("Monday email")}>
        <s-stack direction="block" gap="base">
          <s-checkbox
            label={t("Send the Monday email")}
            details={t("Every Monday at 08:00 in your store's time zone: the money at stake and what to do this week.")}
            checked={flag(form.mondayEnabled)}
            onChange={(e) => set("mondayEnabled", isChecked(e))}
          />
          <s-text-field
            label={t("Send to")}
            details={t("Leave empty to send it to the store owner. Separate several addresses with commas.")}
            value={form.recipients}
            error={err("recipients")}
            disabled={flag(!form.mondayEnabled)}
            onInput={(e) => set("recipients", val(e))}
          />
        </s-stack>
      </s-section>

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
