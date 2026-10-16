/**
 * Settings tabs (spec §5.5): Defaults · Suppliers · Locations · Alerts. Each
 * tab is its own page (`app.settings.tsx`, `app.settings_.<tab>.tsx`) so a
 * save on one never touches another; this strip links them.
 */
import { useNavigate } from "react-router";
import { useLocale } from "../lib/i18n";
import { Tabs } from "./wc";

export const SETTINGS_TABS = [
  { id: "defaults", path: "/app/settings", label: "Defaults" },
  { id: "suppliers", path: "/app/settings/suppliers", label: "Suppliers" },
  { id: "locations", path: "/app/settings/locations", label: "Locations" },
  { id: "alerts", path: "/app/settings/alerts", label: "Alerts" },
] as const;
export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

export function SettingsTabs({ current }: { current: SettingsTabId }) {
  const { t } = useLocale();
  const navigate = useNavigate();
  return (
    <Tabs
      tabs={SETTINGS_TABS.map((x) => ({ id: x.id, content: t(x.label) }))}
      selected={SETTINGS_TABS.findIndex((x) => x.id === current)}
      onSelect={(i) => navigate(SETTINGS_TABS[i].path)}
    />
  );
}
