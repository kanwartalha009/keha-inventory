/**
 * Location switcher (spec §4 J7, §5.2 filter "location (Pro)"): the online stock pool or
 * one warehouse / store, as `?location=<numeric Location id>`. Pro only; the server ignores
 * the parameter below Pro (lib/locations-shared resolveScope).
 *
 * Free / Growth: the same control, disabled on "Online stock pool", with a Pro badge whose
 * tooltip says what it does and a link to the plans (plan locks teach, they don't hide).
 * Pro without warehouses or stores yet: a link to Settings → Locations.
 */
import { useSearchParams } from "react-router";
import { useLocale } from "../lib/i18n";
import { locationNumericId, roleLabel, type PlanningLocation } from "../lib/locations-shared";
import { featureCopy, planTag } from "./plan";
import { SelectField, useLinkProps } from "./wc";

export const POOL_VALUE = "";

export function LocationSwitcher({
  enabled,
  locations,
  current,
}: {
  /** The plan includes `locations`. */
  enabled: boolean;
  /** Active warehouses and stores (empty below Pro). */
  locations: PlanningLocation[];
  /** The location shown, or null for the online stock pool. */
  current: PlanningLocation | null;
}) {
  const { t } = useLocale();
  const link = useLinkProps();
  const [params, setParams] = useSearchParams();
  const pick = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set("location", value);
    else next.delete("location");
    next.delete("page");
    setParams(next);
  };
  const options = [
    { value: POOL_VALUE, label: t("Online stock pool") },
    ...(enabled ? locations : []).map((l) => ({ value: locationNumericId(l.id), label: `${l.name} · ${roleLabel(l.role, t)}` })),
  ];
  const select = (
    <SelectField
      label={t("Location")}
      labelHidden
      disabled={!enabled || locations.length === 0}
      value={current ? locationNumericId(current.id) : POOL_VALUE}
      options={options}
      onChange={pick}
    />
  );
  if (!enabled) {
    const copy = featureCopy("locations", t);
    return (
      <s-stack direction="inline" gap="small-200" alignItems="center">
        {select}
        <s-badge icon="lock" tone="info">
          {planTag("locations", t)}
        </s-badge>
        <s-icon type="info" interestFor="keha-locations-locked" />
        <s-tooltip id="keha-locations-locked">{copy.body}</s-tooltip>
        <s-link {...link("/app/plans?upgrade=locations")}>{t("See plans")}</s-link>
      </s-stack>
    );
  }
  if (locations.length === 0) {
    return (
      <s-stack direction="inline" gap="small-200" alignItems="center">
        {select}
        <s-link {...link("/app/settings/locations")}>{t("Set up warehouses and stores")}</s-link>
      </s-stack>
    );
  }
  return select;
}
