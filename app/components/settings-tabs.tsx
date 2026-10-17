/**
 * Settings tabs (spec §5.5): Defaults · Suppliers · Locations · Alerts · Import & export. Each
 * tab is its own page (`app.settings.tsx`, `app.settings_.<tab>.tsx`) so a
 * save on one never touches another; this strip links them.
 *
 * Every tab has the same anatomy (docs/DESIGN-RULES.md): this strip, then
 * banners, then cards (FormCard: heading + one-line description). Forms save
 * through the contextual save bar (FormSaveBar); a tab's title bar holds only
 * page actions such as "Add supplier". Switching tabs with unsaved changes
 * asks first (App Bridge leave confirmation).
 */
import { useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useLocale } from "../lib/i18n";
import { Tabs } from "./wc";

export const SETTINGS_TABS = [
  { id: "defaults", path: "/app/settings", label: "Defaults" },
  { id: "suppliers", path: "/app/settings/suppliers", label: "Suppliers" },
  { id: "locations", path: "/app/settings/locations", label: "Locations" },
  { id: "alerts", path: "/app/settings/alerts", label: "Alerts" },
  // Owner 2026-10-17: CSV import / export for setup at scale (Growth).
  { id: "import", path: "/app/settings/import", label: "Import & export" },
] as const;
export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

export function SettingsTabs({ current }: { current: SettingsTabId }) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const open = (i: number) => {
    const go = () => navigate(SETTINGS_TABS[i].path);
    // Resolves at once when no save bar is shown; otherwise only after the merchant
    // chooses to leave. Without App Bridge (tests, preview) navigate straight away.
    let wait: Promise<void> | undefined;
    try {
      wait = shopify?.saveBar?.leaveConfirmation?.();
    } catch {
      wait = undefined;
    }
    if (wait && typeof wait.then === "function") wait.then(go, () => undefined);
    else go();
  };
  return (
    <Tabs
      tabs={SETTINGS_TABS.map((x) => ({ id: x.id, content: t(x.label) }))}
      selected={SETTINGS_TABS.findIndex((x) => x.id === current)}
      onSelect={open}
    />
  );
}
