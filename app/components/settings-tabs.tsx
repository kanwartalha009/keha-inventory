/**
 * Settings tabs (spec §5.5): Defaults · Suppliers · Locations · Alerts · Import & export. Each
 * tab is its own page (`app.settings.tsx`, `app.settings_.<tab>.tsx`) so a
 * save on one never touches another; this strip links them.
 *
 * Every tab has the same anatomy (docs/DESIGN-RULES.md): this strip, then
 * banners, then cards (FormCard: heading + one-line description). Forms save
 * through the contextual save bar (FormSaveBar); a tab's title bar holds only
 * page actions such as "Add supplier". Switching tabs with unsaved changes
 * asks first (components/wc useSafeNavigate → "Discard unsaved changes?").
 */

import { useLocale } from "../lib/i18n";
import { Tabs, useSafeNavigate } from "./wc";

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
  // With unsaved changes useSafeNavigate asks "Discard unsaved changes?" first (one question:
  // App Bridge's own leave confirmation as well asked twice — link audit 2026-10-20).
  const navigate = useSafeNavigate();
  return (
    <Tabs
      tabs={SETTINGS_TABS.map((x) => ({ id: x.id, content: t(x.label) }))}
      selected={SETTINGS_TABS.findIndex((x) => x.id === current)}
      onSelect={(i) => navigate(SETTINGS_TABS[i].path)}
    />
  );
}
