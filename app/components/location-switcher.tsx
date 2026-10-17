/**
 * Location switcher (spec §4 J7, §5.2 filter "location (Pro)"): the online stock pool or
 * one warehouse / store, as `?location=<numeric Location id>`. Pro only; the server ignores
 * the parameter below Pro (lib/locations-shared resolveScope).
 *
 * One rule (switcherMode, 2026-10-17 design pass):
 *  - fewer than 2 active locations: nothing (the pool IS the one location, nothing to switch);
 *  - below Pro: one compact teaching link — "Plan per location · Pro plan" — whose tooltip
 *    says what it does, to the plans (plan locks teach, they don't hide);
 *  - Pro without warehouses or stores yet: one link to Settings → Locations;
 *  - Pro: a compact select (the pool and each warehouse / store).
 * `locationCount` is optional so older callers keep working: without it the switcher can't
 * know the store has a single location and shows the link / select as before.
 */
import { useSearchParams } from "react-router";
import { useLocale } from "../lib/i18n";
import { locationNumericId, roleLabel, type PlanningLocation } from "../lib/locations-shared";
import { featureCopy, planTag } from "./plan";
import { SelectField, useLinkProps } from "./wc";

export const POOL_VALUE = "";

export type SwitcherMode = "none" | "teach" | "setup" | "select";

/** What the switcher shows (pure; tests/location-switcher.test.tsx). */
export function switcherMode({
  enabled,
  planning,
  locationCount,
  viewing,
}: {
  enabled: boolean;
  /** Active warehouses and stores (empty below Pro). */
  planning: number;
  /** Active locations in the store; undefined = unknown. */
  locationCount?: number;
  /** A location view is open (keep the way back to the pool). */
  viewing?: boolean;
}): SwitcherMode {
  if (enabled && viewing) return "select";
  if (locationCount !== undefined && locationCount < 2) return "none";
  if (!enabled) return "teach";
  return planning > 0 ? "select" : "setup";
}

export function LocationSwitcher({
  enabled,
  locations,
  current,
  locationCount,
}: {
  /** The plan includes `locations`. */
  enabled: boolean;
  /** Active warehouses and stores (empty below Pro). */
  locations: PlanningLocation[];
  /** The location shown, or null for the online stock pool. */
  current: PlanningLocation | null;
  /** Active locations in the store (any role). Optional; see the header comment. */
  locationCount?: number;
}) {
  const { t } = useLocale();
  const link = useLinkProps();
  const [params, setParams] = useSearchParams();
  const mode = switcherMode({ enabled, planning: locations.length, locationCount, viewing: !!current });
  if (mode === "none") return null;

  if (mode === "teach") {
    const copy = featureCopy("locations", t);
    return (
      <div className="keha-switcher keha-switcher--link">
        <s-icon type="lock" size="small" />
        <s-link {...link("/app/plans?upgrade=locations")} interestFor="keha-locations-locked">
          {`${t("Plan per location")} · ${planTag("locations", t)}`}
        </s-link>
        <s-tooltip id="keha-locations-locked">{copy.body}</s-tooltip>
      </div>
    );
  }

  if (mode === "setup") {
    return (
      <div className="keha-switcher keha-switcher--link">
        <s-link {...link("/app/settings/locations")}>{t("Set up warehouses and stores")}</s-link>
      </div>
    );
  }

  const pick = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set("location", value);
    else next.delete("location");
    next.delete("page");
    setParams(next);
  };
  return (
    <div className="keha-switcher">
      <SelectField
        label={t("Location")}
        labelHidden
        value={current ? locationNumericId(current.id) : POOL_VALUE}
        options={[
          { value: POOL_VALUE, label: t("Stock counted in supplier orders") },
          ...locations.map((l) => ({ value: locationNumericId(l.id), label: `${l.name} · ${roleLabel(l.role, t)}` })),
        ]}
        onChange={pick}
      />
    </div>
  );
}
