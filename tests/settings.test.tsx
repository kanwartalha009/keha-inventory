/**
 * Settings (spec §5.5): form validation, lead time confirmed on first save
 * (setup guide step 1), Monday email recipients; SSR render.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { DEFAULT_SETTINGS, SETTINGS_ERRORS, applySettingsForm, settingsToForm } from "../app/lib/settings-shared";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/models/settings.server", () => ({ getShopSettings: vi.fn(), saveShopSettings: vi.fn() }));

import Settings from "../app/routes/app.settings";

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

  it("parses, lowercases and de-duplicates recipients; rejects bad addresses", () => {
    const ok = applySettingsForm(DEFAULT_SETTINGS, { ...settingsToForm(DEFAULT_SETTINGS), recipients: "Ann@Shop.com, ann@shop.com\nbob@shop.com" }, now);
    expect(ok.ok && ok.settings.mondayEmail.recipients).toEqual(["ann@shop.com", "bob@shop.com"]);
    const bad = applySettingsForm(DEFAULT_SETTINGS, { ...settingsToForm(DEFAULT_SETTINGS), recipients: "not-an-email" }, now);
    expect(!bad.ok && bad.errors.recipients).toBe(SETTINGS_ERRORS.emails);
  });

  it("saves the safety level; an unknown value keeps the current one", () => {
    expect(settingsToForm(DEFAULT_SETTINGS).safetyLevel).toBe("balanced");
    const safe = applySettingsForm(DEFAULT_SETTINGS, { ...settingsToForm(DEFAULT_SETTINGS), safetyLevel: "safe" }, now);
    expect(safe.ok && safe.settings.safetyLevel).toBe("safe");
    const lean = { ...DEFAULT_SETTINGS, safetyLevel: "lean" as const };
    const bad = applySettingsForm(lean, { ...settingsToForm(lean), safetyLevel: "reckless" }, now);
    expect(bad.ok && bad.settings.safetyLevel).toBe("lean");
  });

  it("can turn the Monday email off", () => {
    const r = applySettingsForm(DEFAULT_SETTINGS, { ...settingsToForm(DEFAULT_SETTINGS), mondayEnabled: false }, now);
    expect(r.ok && r.settings.mondayEmail.enabled).toBe(false);
  });
});

describe("Settings page", () => {
  it("renders the defaults, the Monday email and the language", () => {
    const data = { form: settingsToForm(DEFAULT_SETTINGS) };
    const Stub = createRoutesStub([{ id: "settings", path: "/app/settings", Component: Settings, loader: () => data }]);
    const html = renderToString(<Stub initialEntries={["/app/settings"]} hydrationData={{ loaderData: { settings: data } }} />);
    expect(html).toContain("How long do your suppliers take?");
    expect(html).toContain("Send the Monday email");
    expect(html).toContain("More options");
    expect(html).toContain("App language");
    expect(html).toMatch(/<s-number-field[^>]*value="14"/);
  });
});
