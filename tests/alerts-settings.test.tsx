/**
 * Settings → Alerts (spec §5.5, §11, task 2.6): the Defaults / Alerts split
 * (each validates and saves only its own fields), Monday recipients, Slack link
 * validation, connect on Growth only, the link stored encrypted and never sent
 * back, test message and disconnect; SSR of the tab in each state.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

const { store, features, deliverSlack, ownerContact } = vi.hoisted(() => ({
  store: { settings: {} as Record<string, unknown> | null },
  features: { slack: true },
  deliverSlack: vi.fn(async (..._args: unknown[]) => ({ ok: true }) as { ok: true } | { ok: false; code: string; permanent: boolean }),
  ownerContact: vi.fn(async () => ({ name: "Acme Shoes", to: "owner@acme.test", locale: "es" })),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "acme.myshopify.com" } })) },
}));
vi.mock("../app/models/settings.server", async () => {
  const { readSettings } = await import("../app/lib/settings-shared");
  return {
    getShopSettings: async () => readSettings(store.settings),
    saveShopSettings: async (_shop: string, next: Record<string, unknown>) => {
      if (!store.settings) return null;
      store.settings = { ...store.settings, ...next };
      return readSettings(store.settings);
    },
  };
});
vi.mock("../app/models/alerts.server", async () => {
  const { readSettings } = await import("../app/lib/settings-shared");
  return {
    setSlackWebhook: async (_shop: string, sealed: string | null) => {
      if (!store.settings) return null;
      const cur = readSettings(store.settings);
      store.settings = { ...store.settings, alerts: { ...cur.alerts, slackWebhook: sealed, slackError: null } };
      return readSettings(store.settings);
    },
    setSlackError: vi.fn(),
  };
});
vi.mock("../app/services/entitlements.server", () => ({
  getEntitlements: async () => ({ plan: features.slack ? "growth" : "free", features: { slack: features.slack }, comped: false, checked: true }),
}));
vi.mock("../app/services/slack.server", () => ({ deliverSlack: (...a: unknown[]) => deliverSlack(...a) }));
vi.mock("../app/services/owner-email.server", () => ({ ownerContact: () => ownerContact() }));

import {
  DEFAULT_SETTINGS,
  SETTINGS_ERRORS,
  alertsToForm,
  applyAlertsForm,
  applySettingsForm,
  parseRecipients,
  readSettings,
  settingsToForm,
  type AlertsForm,
} from "../app/lib/settings-shared";
import { normalizeSlackWebhook } from "../app/lib/slack-shared";
import { decryptSecret } from "../app/lib/crypto.server";
import AlertsSettings, { action, loader, type AlertsLoaderData } from "../app/routes/app.settings_.alerts";
import { expectSettingsAnatomy } from "./helpers/settings-anatomy";

const HOOK = "https://hooks.slack.com/services/" + "T0ABCDEF1/B0ABCDEF2/abcdefghijklmnopqrstuvwx";
const now = new Date("2026-10-16T10:00:00Z");

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = "11".repeat(32);
});

// ---------------------------------------------------------------- pure form logic

describe("Defaults and Alerts validate separately", () => {
  const configured = readSettings({
    leadTimeDays: 30,
    mondayEmail: { enabled: false, recipients: ["ops@acme.test"] },
    alerts: { instant: false, slackWebhook: "gcm:x", slackMonday: false, slackError: null },
  });

  it("a Defaults save keeps every Alerts setting", () => {
    const r = applySettingsForm(configured, { ...settingsToForm(configured), leadTimeDays: "21" }, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings.leadTimeDays).toBe(21);
      expect(r.settings.mondayEmail).toEqual(configured.mondayEmail);
      expect(r.settings.alerts).toEqual(configured.alerts);
    }
    expect(Object.keys(settingsToForm(configured)).sort()).toEqual(["cycleDays", "deadDays", "excludedChannels", "leadTimeDays", "monthlyBudget", "safetyLevel", "tooMuchDays", "trendMode"]); // R3: the monthly budget, R4: the sales channels left out are Defaults fields.
  });

  it("an Alerts save keeps every Defaults setting and the stored Slack link", () => {
    const r = applyAlertsForm(configured, { ...alertsToForm(configured), instant: true }, normalizeSlackWebhook);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings.leadTimeDays).toBe(30);
      expect(r.settings.leadTimeConfirmedAt).toBeNull();
      expect(r.settings.alerts).toEqual({ ...configured.alerts, instant: true });
      expect(r.webhook).toBeNull();
    }
  });

  it("an invalid Alerts form never touches Defaults (and vice versa)", () => {
    const bad = applyAlertsForm(configured, { ...alertsToForm(configured), recipients: "nope" }, normalizeSlackWebhook);
    expect(bad).toEqual({ ok: false, errors: { recipients: SETTINGS_ERRORS.emails } });
    const badDefaults = applySettingsForm(configured, { ...settingsToForm(configured), deadDays: "5" }, now);
    expect(badDefaults.ok).toBe(false);
  });
});

describe("alerts form", () => {
  const form = (over: Partial<AlertsForm> = {}): AlertsForm => ({ ...alertsToForm(DEFAULT_SETTINGS), ...over });

  it("round-trips the defaults: Monday email and instant alerts on, Slack Monday on, no link", () => {
    expect(form()).toEqual({ mondayEnabled: true, recipients: "", instant: true, slackMonday: true, slackWebhook: "" });
    const r = applyAlertsForm(DEFAULT_SETTINGS, form(), normalizeSlackWebhook);
    expect(r.ok && r.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("parses, lowercases and de-duplicates recipients; rejects bad or too many addresses", () => {
    expect(parseRecipients("Ann@Shop.com, ann@shop.com\nbob@shop.com;  ")).toEqual({ ok: true, recipients: ["ann@shop.com", "bob@shop.com"] });
    expect(parseRecipients("not-an-email")).toEqual({ ok: false, error: SETTINGS_ERRORS.emails });
    const eleven = Array.from({ length: 11 }, (_, i) => `u${i}@shop.com`).join(",");
    expect(parseRecipients(eleven)).toEqual({ ok: false, error: SETTINGS_ERRORS.tooMany });
    const ten = Array.from({ length: 10 }, (_, i) => `u${i}@shop.com`).join(",");
    expect(parseRecipients(`${ten}, U0@shop.com`)).toMatchObject({ ok: true }); // duplicates don't count
    expect(parseRecipients("")).toEqual({ ok: true, recipients: [] });
  });

  it("can turn the Monday email, instant alerts and the Slack summary off", () => {
    const r = applyAlertsForm(DEFAULT_SETTINGS, form({ mondayEnabled: false, instant: false, slackMonday: false }), normalizeSlackWebhook);
    expect(r.ok && r.settings.mondayEmail.enabled).toBe(false);
    expect(r.ok && r.settings.alerts).toMatchObject({ instant: false, slackMonday: false });
  });

  it("returns a valid pasted Slack link for the server to encrypt; rejects anything else", () => {
    const ok = applyAlertsForm(DEFAULT_SETTINGS, form({ slackWebhook: `  ${HOOK} ` }), normalizeSlackWebhook);
    expect(ok.ok && ok.webhook).toBe(HOOK);
    expect(ok.ok && ok.settings.alerts.slackWebhook).toBeNull(); // the pure function never stores it
    const bad = applyAlertsForm(DEFAULT_SETTINGS, form({ slackWebhook: "https://example.com/hook" }), normalizeSlackWebhook);
    expect(bad).toEqual({ ok: false, errors: { slackWebhook: SETTINGS_ERRORS.slackUrl } });
  });

  it("reads a stored Slack error and ignores a malformed one", () => {
    expect(readSettings({ alerts: { slackError: { code: "invalid_token", at: "2026-10-16T00:00:00Z" } } }).alerts.slackError).toEqual({
      code: "invalid_token",
      at: "2026-10-16T00:00:00Z",
    });
    expect(readSettings({ alerts: { slackError: { code: 5 } } }).alerts.slackError).toBeNull();
    expect(readSettings({ alerts: { slackError: "x" } }).alerts.slackError).toBeNull();
  });
});

// ---------------------------------------------------------------- action

const post = (body: unknown) =>
  action({
    request: new Request("https://inventory.test/app/settings/alerts", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    params: {},
    context: {},
  } as never);

describe("Alerts action", () => {
  beforeEach(() => {
    store.settings = { leadTimeDays: 30 };
    features.slack = true;
    deliverSlack.mockClear();
  });

  it("connects Slack on Growth: stores the link encrypted, never returns it", async () => {
    const r = await post({ ...alertsToForm(DEFAULT_SETTINGS), slackWebhook: HOOK });
    expect(r).toMatchObject({ ok: true, intent: "save", form: { slackWebhook: "" } });
    expect(JSON.stringify(r)).not.toContain("hooks.slack.com");
    const stored = readSettings(store.settings).alerts.slackWebhook!;
    expect(stored).toMatch(/^gcm:/);
    expect(stored).not.toContain("hooks.slack.com");
    expect(decryptSecret(stored)).toBe(HOOK);
    expect((store.settings as Record<string, unknown>).leadTimeDays).toBe(30);
  });

  it("Free: connecting Slack returns the upgrade prompt and saves nothing", async () => {
    features.slack = false;
    const r = await post({ ...alertsToForm(DEFAULT_SETTINGS), mondayEnabled: false, slackWebhook: HOOK });
    expect(r).toEqual({ ok: false, upgrade: true });
    expect(store.settings).toEqual({ leadTimeDays: 30 });
    // Free can still change the Monday email and instant alerts (email alerts are on every plan).
    expect(await post({ ...alertsToForm(DEFAULT_SETTINGS), instant: false })).toMatchObject({ ok: true });
    expect(readSettings(store.settings).alerts.instant).toBe(false);
  });

  it("production without a valid APP_ENCRYPTION_KEY: refuses to store the link (translated error), nothing saved in the clear", async () => {
    const env = { key: process.env.APP_ENCRYPTION_KEY, node: process.env.NODE_ENV };
    try {
      process.env.NODE_ENV = "production";
      for (const key of ["", "z".repeat(64)]) {
        process.env.APP_ENCRYPTION_KEY = key;
        expect(await post({ ...alertsToForm(DEFAULT_SETTINGS), slackWebhook: HOOK })).toEqual({
          ok: false,
          errors: { slackWebhook: SETTINGS_ERRORS.secretStorage },
        });
        expect(store.settings).toEqual({ leadTimeDays: 30 });
      }
    } finally {
      process.env.APP_ENCRYPTION_KEY = env.key;
      process.env.NODE_ENV = env.node;
    }
  });

  it("rejects a bad link with a translatable message", async () => {
    expect(await post({ ...alertsToForm(DEFAULT_SETTINGS), slackWebhook: "http://hooks.slack.com/services/" + "T0ABCDEF1/B0ABCDEF2/abcdefghijklmnopqrstuvwx" })).toEqual({
      ok: false,
      errors: { slackWebhook: SETTINGS_ERRORS.slackUrl },
    });
  });

  it("sends a test message in the store's language; reports Slack's answer", async () => {
    await post({ ...alertsToForm(DEFAULT_SETTINGS), slackWebhook: HOOK });
    expect(await post({ intent: "test" })).toEqual({ ok: true, intent: "test" });
    const [shop, , message] = deliverSlack.mock.calls[0] as [string, unknown, { text: string }];
    expect(shop).toBe("acme.myshopify.com");
    expect(message.text).toContain("Keha Inventory Planner está conectada para Acme Shoes");
    deliverSlack.mockResolvedValueOnce({ ok: false, code: "channel_not_found", permanent: true });
    expect(await post({ intent: "test" })).toEqual({ ok: false, slackFailed: { code: "channel_not_found", permanent: true } });
  });

  it("test without a connection or plan does not call Slack", async () => {
    expect(await post({ intent: "test" })).toEqual({ ok: false, slackFailed: { code: "not_connected", permanent: true } });
    features.slack = false;
    expect(await post({ intent: "test" })).toEqual({ ok: false, upgrade: true });
    expect(deliverSlack).not.toHaveBeenCalled();
  });

  it("disconnect removes the link and any error, keeps everything else", async () => {
    store.settings = { leadTimeDays: 30, alerts: { slackWebhook: "gcm:a:b:c", slackError: { code: "invalid_token", at: "x" }, instant: false } };
    expect(await post({ intent: "disconnect" })).toEqual({ ok: true, intent: "disconnect" });
    expect(readSettings(store.settings).alerts).toMatchObject({ slackWebhook: null, slackError: null, instant: false });
    expect((store.settings as Record<string, unknown>).leadTimeDays).toBe(30);
  });

  it("before the store is read: nothing to save to", async () => {
    store.settings = null;
    expect(await post(alertsToForm(DEFAULT_SETTINGS))).toEqual({ ok: false, notReady: true });
  });
});

// ---------------------------------------------------------------- SSR

function render(data: AlertsLoaderData) {
  const Stub = createRoutesStub([{ id: "alerts", path: "/app/settings/alerts", Component: AlertsSettings, loader: () => data }]);
  return renderToString(<Stub initialEntries={["/app/settings/alerts"]} hydrationData={{ loaderData: { alerts: data } }} />);
}

describe("Alerts tab", () => {
  const base: AlertsLoaderData = { form: alertsToForm(DEFAULT_SETTINGS), slack: { connected: false, error: null }, canSlack: true };

  it("not connected (Growth): Monday email, instant alerts, the link field; at most 8 fields", () => {
    const html = render(base);
    expect(html).toContain("Send the Monday email");
    expect(html).toContain("Send to");
    expect(html).toContain("Send instant alerts");
    expect(html).toContain("Slack webhook link");
    expect(html).toContain("Send the Monday summary to Slack");
    expect(html).not.toContain("Disconnect");
    expect(html).toContain("keha-tab--active");
    const fields = (html.match(/<s-(?:checkbox|text-field|number-field|select)\b/g) ?? []).length;
    expect(fields).toBeLessThanOrEqual(8);
    expectSettingsAnatomy(html, { cards: ["Monday email", "Instant alerts", "Slack"], saveBar: "keha-settings-alerts" });
    // The long instant-alert text is split: one sentence as the card description, the rest as the checkbox details.
    expect(html).toContain("When a best seller will run out before new stock can arrive, or a busy product sells out.</s-paragraph>");
    expect(html).toContain('details="By email to the addresses above, and to Slack when it&#x27;s connected. At most once per product per week."');
  });

  it("connected: shows Connected, test and disconnect — never the link", () => {
    const html = render({ ...base, slack: { connected: true, error: null } });
    expect(html).toContain("Connected");
    expect(html).toContain("Send a test message");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("Slack webhook link");
    expect(html).not.toContain("hooks.slack.com/services/T");
  });

  it("a link Slack stopped accepting: kept, with the error explained", () => {
    const html = render({ ...base, slack: { connected: true, error: { code: "invalid_token", at: "2026-10-16T00:00:00Z" } } });
    expect(html).toContain("Slack stopped accepting our messages");
    expect(html).toContain("Slack no longer accepts this webhook link");
    expect(html).toContain("Not working");
    expect(render({ ...base, slack: { connected: true, error: { code: "channel_not_found", at: "x" } } })).toContain(
      "Slack can&#x27;t post to the channel this link belongs to",
    );
  });

  it("Free: Slack is shown with what it does and an Upgrade button, its fields disabled", () => {
    const html = render({ ...base, canSlack: false });
    expect(html).toContain("Get the Monday summary and urgent alerts in Slack.");
    expect(html).toContain("See plans");
    expect(html).toMatch(/<s-text-field[^>]*label="Slack webhook link"[^>]*disabled/);
    expect(html).toContain("Growth plan");
  });
});

describe("Alerts tab without an email provider (owner decision 2026-10-18)", () => {
  const base: AlertsLoaderData = { form: alertsToForm(DEFAULT_SETTINGS), slack: { connected: false, error: null }, canSlack: true, emailProvider: false, canFlow: true };

  it("no Monday email switch or recipients that can't work; the Monday summary by email with Shopify Flow instead", () => {
    const html = render(base);
    expect(html).not.toContain("Send the Monday email");
    expect(html).not.toContain('label="Send to"');
    expect(html).not.toContain("By email to the addresses above");
    expect(html).toContain("Monday summary");
    expect(html).toContain("Get it by email with Shopify Flow");
    expect(html).toContain("“Weekly order plan ready”");
    expect(html).toContain("“Send internal email”");
    expect(html).toContain("“First order plan ready”");
    expect(html).toMatch(/<s-button[^>]*href="shopify:\/\/admin\/apps\/flow"[^>]*target="_top"[^>]*>Open Shopify Flow/);
    expectSettingsAnatomy(html, { cards: ["Monday summary", "Instant alerts", "Slack"], saveBar: "keha-settings-alerts" });
  });

  it("instant alerts: Slack as before; by email through 'Product needs reorder' on Growth, a plan tag below it", () => {
    const html = render(base);
    expect(html).toContain("Send instant alerts");
    expect(html).toContain('details="To Slack when it&#x27;s connected. At most once per product per week."');
    expect(html).toContain("add the “Send internal email” action to the “Product needs reorder” trigger");
    expect(html).toContain("Slack webhook link");
    const free = render({ ...base, canFlow: false, canSlack: false });
    expect(free).toContain("By email with Shopify Flow, on the “Product needs reorder” trigger · Growth plan");
  });

  it("the loader says whether a provider is configured", async () => {
    const saved = { key: process.env.INVENTORY_EMAIL_API_KEY, from: process.env.INVENTORY_EMAIL_FROM };
    store.settings = {};
    const args = { request: new Request("https://app.test/app/settings/alerts"), params: {}, context: {} } as never;
    delete process.env.INVENTORY_EMAIL_API_KEY;
    delete process.env.INVENTORY_EMAIL_FROM;
    expect((await loader(args)).emailProvider).toBe(false);
    process.env.INVENTORY_EMAIL_API_KEY = "re_test";
    process.env.INVENTORY_EMAIL_FROM = "Keha <mail@keha.test>";
    expect((await loader(args)).emailProvider).toBe(true);
    if (saved.key === undefined) delete process.env.INVENTORY_EMAIL_API_KEY;
    else process.env.INVENTORY_EMAIL_API_KEY = saved.key;
    if (saved.from === undefined) delete process.env.INVENTORY_EMAIL_FROM;
    else process.env.INVENTORY_EMAIL_FROM = saved.from;
  });
});
