/**
 * Settings → Defaults (spec §5.5): form validation, lead time confirmed on first
 * save (setup guide step 1); SSR render. The Monday email moved to the Alerts
 * tab (tests/alerts-settings.test.tsx).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { DEFAULT_SETTINGS, SETTINGS_ERRORS, applySettingsForm, settingsToForm } from "../app/lib/settings-shared";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/models/settings.server", () => ({ getShopSettings: vi.fn(), saveShopSettings: vi.fn() }));

import Settings from "../app/routes/app.settings";
import { expectSettingsAnatomy } from "./helpers/settings-anatomy";

const now = new Date("2026-10-16T10:00:00Z");

describe("settings form", () => {
  it("round-trips the defaults and confirms the lead time on first save", () => {
    const r = applySettingsForm(DEFAULT_SETTINGS, settingsToForm(DEFAULT_SETTINGS), now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings.leadTimeDays).toBe(14);
      expect(r.settings.leadTimeConfirmedAt).toBe(now.toISOString());
    }
  });

  it("keeps the first confirmation date on later saves", () => {
    const confirmed = { ...DEFAULT_SETTINGS, leadTimeConfirmedAt: "2026-10-01T00:00:00.000Z" };
    const r = applySettingsForm(confirmed, { ...settingsToForm(confirmed), leadTimeDays: "21" }, now);
    expect(r.ok && r.settings.leadTimeConfirmedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(r.ok && r.settings.leadTimeDays).toBe(21);
  });

  it("rejects out-of-range and non-integer numbers with a translatable message", () => {
    const r = applySettingsForm(DEFAULT_SETTINGS, { ...settingsToForm(DEFAULT_SETTINGS), leadTimeDays: "400", cycleDays: "2.5", deadDays: "" }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.leadTimeDays).toBe(SETTINGS_ERRORS.range);
      expect(r.errors.cycleDays).toBe(SETTINGS_ERRORS.range);
      expect(r.errors.deadDays).toBe(SETTINGS_ERRORS.range);
    }
  });

  it("saves the safety level; an unknown value keeps the current one", () => {
    expect(settingsToForm(DEFAULT_SETTINGS).safetyLevel).toBe("balanced");
    const safe = applySettingsForm(DEFAULT_SETTINGS, { ...settingsToForm(DEFAULT_SETTINGS), safetyLevel: "safe" }, now);
    expect(safe.ok && safe.settings.safetyLevel).toBe("safe");
    const lean = { ...DEFAULT_SETTINGS, safetyLevel: "lean" as const };
    const bad = applySettingsForm(lean, { ...settingsToForm(lean), safetyLevel: "reckless" }, now);
    expect(bad.ok && bad.settings.safetyLevel).toBe("lean");
  });

  it("growth assumption: off by default, saves 'store', an unknown value keeps the current mode", () => {
    expect(settingsToForm(DEFAULT_SETTINGS).trendMode).toBe("off");
    const on = applySettingsForm(DEFAULT_SETTINGS, { ...settingsToForm(DEFAULT_SETTINGS), trendMode: "store" }, now);
    expect(on.ok && on.settings.trendMode).toBe("store");
    const store = { ...DEFAULT_SETTINGS, trendMode: "store" as const };
    const bad = applySettingsForm(store, { ...settingsToForm(store), trendMode: "double" }, now);
    expect(bad.ok && bad.settings.trendMode).toBe("store");
    const off = applySettingsForm(store, { ...settingsToForm(store), trendMode: "off" }, now);
    expect(off.ok && off.settings.trendMode).toBe("off");
  });
});

describe("Settings page", () => {
  it("renders the defaults and the language; the Monday email is on the Alerts tab", () => {
    const data = { form: settingsToForm(DEFAULT_SETTINGS) };
    const Stub = createRoutesStub([{ id: "settings", path: "/app/settings", Component: Settings, loader: () => data }]);
    const html = renderToString(<Stub initialEntries={["/app/settings"]} hydrationData={{ loaderData: { settings: data } }} />);
    expect(html).toContain("How long do your suppliers take?");
    expect(html).not.toContain("Send the Monday email");
    expect(html).toContain("More options");
    expect(html).toContain("App language");
    expect(html).toMatch(/<s-number-field[^>]*value="14"/);
    expect(html).not.toContain("Growth assumption"); // in More options, collapsed while it is off
  });

  it("a store that turned the growth assumption on sees it (More options open), with the honest note", () => {
    const data = { form: settingsToForm({ ...DEFAULT_SETTINGS, trendMode: "store" }) };
    const Stub = createRoutesStub([{ id: "settings", path: "/app/settings", Component: Settings, loader: () => data }]);
    const html = renderToString(<Stub initialEntries={["/app/settings"]} hydrationData={{ loaderData: { settings: data } }} />);
    expect(html).toContain("Growth assumption");
    expect(html).toContain("Off (recommended)");
    expect(html).toContain("Use today&#x27;s sales pace and season.");
    expect(html).toMatch(/<s-choice value="store" selected=/);
    expect(html).not.toMatch(/<s-choice value="off" selected=/);
    expect(html).toContain("adding it again usually orders too much");
  });

  it("same anatomy as every tab: cards with a heading and a one-line description, Save in the save bar", () => {
    const data = { form: settingsToForm(DEFAULT_SETTINGS) };
    const Stub = createRoutesStub([{ id: "settings", path: "/app/settings", Component: Settings, loader: () => data }]);
    const html = renderToString(<Stub initialEntries={["/app/settings"]} hydrationData={{ loaderData: { settings: data } }} />);
    expectSettingsAnatomy(html, { cards: ["Defaults", "Language"], saveBar: "keha-settings-defaults" });
    expect(html).toContain("Lead time and stock thresholds used for every product.");
    expect(html).toContain("Only changes the app for you in this browser.");
  });
});
