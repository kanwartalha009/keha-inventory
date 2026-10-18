/**
 * "Order enough for" — how many days of stock after it arrives one order covers (Kanwar
 * 2026-10-18: choose 150 or 180 days for this purchase order without changing Settings).
 * The page re-plans that supplier with the choice (the URL keeps it, so a reload or a shared link
 * shows the same quantities); "Plan default" goes back to the supplier's order cycle.
 */
import { useEffect, useState } from "react";
import { COVER_DAY_CHOICES, COVER_DAYS_MAX, COVER_DAYS_MIN, readCoverDays } from "../lib/engine/forward-plan-shared";
import { fill, plural, useLocale } from "../lib/i18n";
import { formatCount } from "../lib/dashboard-shared";
import { flag, val } from "./wc";

export function CoverDaysPicker({
  value,
  planDays,
  onChange,
  busy,
}: {
  /** The days chosen for this order; null = the plan's. */
  value: number | null;
  /** The plan's days (the supplier's order cycle); null unknown. */
  planDays: number | null;
  onChange: (days: number | null) => void;
  busy?: boolean;
}) {
  const { t, locale } = useLocale();
  const days = (n: number) => fill(plural(n, t("1 day"), t("{n} days")), { n: formatCount(n, locale) });
  const preset = value !== null && (COVER_DAY_CHOICES as readonly number[]).includes(value);
  const [custom, setCustom] = useState(value !== null && !preset);
  const [typed, setTyped] = useState(value !== null && !preset ? String(value) : "");
  useEffect(() => {
    const p = value !== null && (COVER_DAY_CHOICES as readonly number[]).includes(value);
    setCustom(value !== null && !p);
    setTyped(value !== null && !p ? String(value) : "");
  }, [value]);
  const selectValue = custom ? "custom" : value === null ? "" : String(value);
  const typedDays = readCoverDays(typed);
  return (
    <s-stack direction="inline" gap="small-200" alignItems="end">
      <s-select
        label={t("Order enough for")}
        value={selectValue}
        disabled={flag(busy)}
        details={t("Days of stock after it arrives. Only this order changes.")}
        onChange={(e) => {
          const v = val(e);
          if (v === "custom") {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(v === "" ? null : readCoverDays(v));
        }}
      >
        <s-option value="">{planDays ? fill(t("Plan default ({days})"), { days: days(planDays) }) : t("Plan default")}</s-option>
        {COVER_DAY_CHOICES.map((n) => (
          <s-option key={n} value={String(n)}>
            {days(n)}
          </s-option>
        ))}
        <s-option value="custom">{t("Custom…")}</s-option>
      </s-select>
      {custom && (
        <>
          <s-number-field
            label={t("Days")}
            value={typed}
            min={COVER_DAYS_MIN}
            max={COVER_DAYS_MAX}
            step={1}
            disabled={flag(busy)}
            error={typed !== "" && typedDays === null ? fill(t("Between {min} and {max} days."), { min: COVER_DAYS_MIN, max: COVER_DAYS_MAX }) : undefined}
            onInput={(e) => setTyped(val(e))}
          />
          <s-button disabled={flag(busy || typedDays === null)} onClick={() => onChange(typedDays)}>
            {t("Apply")}
          </s-button>
        </>
      )}
    </s-stack>
  );
}
