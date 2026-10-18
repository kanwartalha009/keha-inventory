/**
 * Settings → Alerts (/app/settings/alerts), spec §5.5, §11, task 2.6: the Monday
 * email (on/off + recipients, moved here from Defaults), instant alerts on/off,
 * and Slack (Growth): paste an incoming-webhook link, stored encrypted and never
 * shown back — the page only knows "Connected", with Disconnect and "Send a test
 * message". A link Slack stopped accepting stays saved and its error shows here.
 * Five visible fields (spec §5.5: at most 8).
 *
 * No email provider (owner decision 2026-10-18, the default): the Monday email and the email part of
 * instant alerts can't be sent by Keha, so their switches and the recipients field are not shown
 * (the saved values stay as they are). Instead the page says how to get them by email with Shopify
 * Flow — the "Weekly order plan ready" trigger (every plan) and "Product needs reorder" (Growth) —
 * with a button to the Flow app. Slack works as before.
 */
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { authenticateApp } from "../services/data-scope.server";
import { SampleOffNote, useSample } from "../components/sample";
import { AppPage, FormCard, FormSaveBar, sameValues } from "../components/ui";
import { SettingsTabs } from "../components/settings-tabs";
import { UpgradeBanner, planTag } from "../components/plan";
import { flag, isChecked, val } from "../components/wc";
import { useLocale } from "../lib/i18n";
import { encryptSecret, secretsWritable } from "../lib/crypto.server";
import {
  SETTINGS_ERRORS,
  alertsToForm,
  applyAlertsForm,
  type AlertsErrors,
  type AlertsForm,
} from "../lib/settings-shared";
import { buildSlackTest, normalizeSlackWebhook, slackErrorGroup } from "../lib/slack-shared";
import { getShopSettings, saveShopSettings } from "../models/settings.server";
import { setSlackWebhook } from "../models/alerts.server";
import { getEntitlements } from "../services/entitlements.server";
import { deliverSlack } from "../services/slack.server";
import { ownerContact } from "../services/owner-email.server";
import { emailTransportConfigured } from "../services/email.server";
import { SHOPIFY_FLOW_ADMIN } from "../lib/flow-shared";

export type AlertsLoaderData = {
  form: AlertsForm;
  slack: { connected: boolean; error: { code: string; at: string } | null };
  /** The plan includes Slack (Growth). */
  canSlack: boolean;
  /** An email provider is configured (INVENTORY_EMAIL_API_KEY / _FROM); else email goes through Shopify Flow. Absent = configured. */
  emailProvider?: boolean;
  /** The plan includes the product Flow triggers ("Product needs reorder", Growth). */
  canFlow?: boolean;
};

export const loader = async ({ request }: LoaderFunctionArgs): Promise<AlertsLoaderData> => {
  const { session } = await authenticate.admin(request);
  const [settings, ent] = await Promise.all([getShopSettings(session.shop), getEntitlements(session.shop)]);
  return {
    form: alertsToForm(settings),
    slack: { connected: Boolean(settings.alerts.slackWebhook), error: settings.alerts.slackError },
    canSlack: ent.features.slack,
    emailProvider: emailTransportConfigured(),
    canFlow: ent.features.flowTriggers,
  };
};

type Intent = "save" | "test" | "disconnect";

export type AlertsActionData =
  | { ok: true; intent: Intent; form?: AlertsForm }
  | { ok: false; errors?: AlertsErrors; notReady?: boolean; upgrade?: boolean; slackFailed?: { code: string; permanent: boolean }; sample?: boolean };

export const action = async ({ request }: ActionFunctionArgs): Promise<AlertsActionData> => {
  // Always the store's own settings (never the sample data's); nothing changes while sample data is on.
  const { session, sample } = await authenticateApp(request);
  const shop = session.shop;
  if (sample) return { ok: false, sample: true };
  let body: Partial<AlertsForm> & { intent?: string };
  try {
    body = (await request.json()) as Partial<AlertsForm> & { intent?: string };
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  const intent: Intent = body.intent === "test" || body.intent === "disconnect" ? body.intent : "save";
  const current = await getShopSettings(shop);

  if (intent === "disconnect") {
    const saved = await setSlackWebhook(shop, null);
    return saved ? { ok: true, intent } : { ok: false, notReady: true };
  }

  const { features } = await getEntitlements(shop);

  if (intent === "test") {
    if (!features.slack) return { ok: false, upgrade: true };
    if (!current.alerts.slackWebhook) return { ok: false, slackFailed: { code: "not_connected", permanent: true } };
    const contact = await ownerContact(shop, null);
    const r = await deliverSlack(shop, current, buildSlackTest(contact?.locale ?? "en", contact?.name || shop));
    if (r === "skipped") return { ok: false, slackFailed: { code: "not_connected", permanent: true } };
    return r.ok ? { ok: true, intent } : { ok: false, slackFailed: { code: r.code, permanent: r.permanent } };
  }

  const form: AlertsForm = {
    mondayEnabled: body.mondayEnabled === true,
    recipients: String(body.recipients ?? ""),
    instant: body.instant === true,
    slackMonday: body.slackMonday === true,
    slackWebhook: String(body.slackWebhook ?? ""),
  };
  const r = applyAlertsForm(current, form, normalizeSlackWebhook);
  if (!r.ok) return { ok: false, errors: r.errors };
  // Plan check where something is created (plan-shared rules): connecting Slack needs Growth.
  if (r.webhook && !features.slack) return { ok: false, upgrade: true };
  // The webhook is stored encrypted only; never in the clear (lib/crypto.server).
  if (r.webhook && !secretsWritable()) return { ok: false, errors: { slackWebhook: SETTINGS_ERRORS.secretStorage } };
  const next = r.webhook
    ? { ...r.settings, alerts: { ...r.settings.alerts, slackWebhook: encryptSecret(r.webhook), slackError: null } }
    : r.settings;
  const saved = await saveShopSettings(shop, next);
  if (!saved) return { ok: false, notReady: true };
  return { ok: true, intent, form: alertsToForm(saved) };
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export default function AlertsSettings() {
  const { t } = useLocale();
  const { form: initial, slack, canSlack, emailProvider = true, canFlow = false } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<AlertsActionData>();
  const [form, setForm] = useState<AlertsForm>(initial);
  const [saved, setSaved] = useState<AlertsForm>(initial);
  const busy = fetcher.state !== "idle";
  const pending = (fetcher.json as { intent?: string } | undefined)?.intent ?? "save";
  const result = fetcher.data;
  const errors = result && !result.ok ? (result.errors ?? {}) : {};

  useEffect(() => {
    if (result?.ok && result.form) {
      setForm(result.form);
      setSaved(result.form);
    }
  }, [result]);
  useEffect(() => {
    if (slack.connected) setForm((f) => ({ ...f, slackWebhook: "" }));
  }, [slack.connected]);
  // Sample data: these are the store's own alerts — shown, not changed (components/sample).
  const sample = useSample().on;
  const dirty = !sample && !sameValues(form, saved);

  const set = <K extends keyof AlertsForm>(key: K, value: AlertsForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const submit = (intent: Intent) => {
    if (sample) return;
    fetcher.submit(intent === "save" ? { ...form, intent } : { intent }, { method: "post", encType: "application/json" });
  };
  const err = (key: keyof AlertsForm) => (errors[key] ? t(errors[key] as string) : undefined);

  const slackMessage = (code: string) => {
    switch (slackErrorGroup(code)) {
      case "link":
        return t("Slack no longer accepts this webhook link. Create a new incoming webhook in Slack and connect it again.");
      case "channel":
        return t("Slack can't post to the channel this link belongs to. It may have been deleted or archived. Create a webhook for another channel.");
      case "unreadable":
        return t("We can't read the saved link any more. Disconnect and connect Slack again.");
      default:
        return t("Slack refused the last message. Send a test message, or connect Slack again.");
    }
  };

  return (
    <AppPage heading={t("Settings")}>
      <FormSaveBar
        id="keha-settings-alerts"
        dirty={dirty}
        saving={busy && pending === "save"}
        onSave={() => submit("save")}
        onDiscard={() => setForm(saved)}
      />
      <SettingsTabs current="alerts" />
      <SampleOffNote>{t("Alerts, Slack and the Monday email always use your own store. Switch to your store to change them.")}</SampleOffNote>
      {result?.ok && result.intent === "save" && <s-banner tone="success">{t("Settings saved.")}</s-banner>}
      {result?.ok && result.intent === "test" && (
        <s-banner tone="success">{t("Test message sent. Check your Slack channel.")}</s-banner>
      )}
      {result?.ok && result.intent === "disconnect" && <s-banner tone="info">{t("Slack is disconnected.")}</s-banner>}
      {result && !result.ok && result.notReady && (
        <s-banner tone="info">{t("We're still reading your store. Try again in a minute.")}</s-banner>
      )}
      {result && !result.ok && result.upgrade && <UpgradeBanner feature="slack" />}
      {result && !result.ok && result.slackFailed && !result.slackFailed.permanent && (
        <s-banner tone="warning">{t("Slack didn't answer. Try again in a minute.")}</s-banner>
      )}

      {emailProvider ? (
        <FormCard title={t("Monday email")} sub={t("Every Monday at 08:00 in your store's time zone: the money at stake and what to do this week.")}>
          <s-stack direction="block" gap="base">
            <s-checkbox
              label={t("Send the Monday email")}
              checked={flag(form.mondayEnabled)}
              onChange={(e) => set("mondayEnabled", isChecked(e))}
            />
            <s-text-field
              label={t("Send to")}
              details={t("Leave empty to send it to the store owner. Separate several addresses with commas.")}
              value={form.recipients}
              error={err("recipients")}
              onInput={(e) => set("recipients", val(e))}
            />
          </s-stack>
        </FormCard>
      ) : (
        <FormCard
          title={t("Monday summary")}
          sub={t("Every Monday at 08:00 in your store's time zone: the money at stake and what to do this week.")}
          action={
            <s-button href={SHOPIFY_FLOW_ADMIN} target="_top">
              {t("Open Shopify Flow")}
            </s-button>
          }
        >
          <s-stack direction="block" gap="small-200">
            <s-text fontWeight="medium">{t("Get it by email with Shopify Flow")}</s-text>
            <s-paragraph color="subdued">
              {t("Every Monday Keha sends this summary to Shopify Flow as “Weekly order plan ready”. In Flow, turn on a workflow with the “Send internal email” action and type who should get it.")}
            </s-paragraph>
            <s-paragraph color="subdued">{t("Your first order plan is announced the same way, as “First order plan ready”.")}</s-paragraph>
          </s-stack>
        </FormCard>
      )}

      <FormCard title={t("Instant alerts")} sub={t("When a best seller will run out before new stock can arrive, or a busy product sells out.")}>
        <s-stack direction="block" gap="base">
          <s-checkbox
            label={t("Send instant alerts")}
            details={
              emailProvider
                ? t("By email to the addresses above, and to Slack when it's connected. At most once per product per week.")
                : t("To Slack when it's connected. At most once per product per week.")
            }
            checked={flag(form.instant)}
            onChange={(e) => set("instant", isChecked(e))}
          />
          {!emailProvider && (
            <s-text color="subdued">
              {canFlow
                ? t("By email: in Shopify Flow, add the “Send internal email” action to the “Product needs reorder” trigger.")
                : `${t("By email with Shopify Flow, on the “Product needs reorder” trigger")} · ${planTag("flowTriggers", t)}`}
            </s-text>
          )}
        </s-stack>
      </FormCard>

      {/* Below Growth the Upgrade banner says what Slack does; no second copy of it as the description. */}
      <FormCard title={t("Slack")} sub={canSlack ? t("Get the Monday summary and urgent alerts in Slack.") : undefined}>
        <s-stack direction="block" gap="base">
          {!canSlack && <UpgradeBanner feature="slack" />}
          {slack.connected && slack.error && (
            <s-banner tone="critical" heading={t("Slack stopped accepting our messages")}>
              <s-paragraph>{slackMessage(slack.error.code)}</s-paragraph>
            </s-banner>
          )}
          {slack.connected ? (
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={slack.error ? "critical" : "success"}>{slack.error ? t("Not working") : t("Connected")}</s-badge>
              <s-button
                onClick={() => submit("test")}
                disabled={flag(!canSlack || sample)}
                loading={flag(busy && pending === "test")}
              >
                {t("Send a test message")}
              </s-button>
              <s-button tone="critical" variant="tertiary" onClick={() => submit("disconnect")} disabled={flag(sample)} loading={flag(busy && pending === "disconnect")}>
                {t("Disconnect")}
              </s-button>
            </s-stack>
          ) : (
            <s-text-field
              label={t("Slack webhook link")}
              details={t("In Slack, add an incoming webhook for the channel you want, then paste its link here and save. We store it encrypted.")}
              placeholder="https://hooks.slack.com/services/…"
              value={form.slackWebhook}
              error={err("slackWebhook")}
              disabled={flag(!canSlack)}
              onInput={(e) => set("slackWebhook", val(e))}
            />
          )}
          <s-checkbox
            label={t("Send the Monday summary to Slack")}
            details={canSlack ? t("The same numbers and top actions as the email, shorter.") : planTag("slack", t)}
            checked={flag(form.slackMonday)}
            disabled={flag(!canSlack)}
            onChange={(e) => set("slackMonday", isChecked(e))}
          />
        </s-stack>
      </FormCard>
    </AppPage>
  );
}
