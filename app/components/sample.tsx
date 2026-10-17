/**
 * Sample data mode in the admin (lib/sample-mode-shared): the context every screen reads (set by
 * the app layout, app/routes/app.tsx), the persistent banner, the Dashboard's offer card and the
 * note shown where a store-changing action is switched off (I-1: in sample data nothing reaches
 * the store). The switch itself is POST /app/sample (app/routes/app.sample.tsx).
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";
import ConfirmModal from "./ConfirmModal";
import { flag } from "./wc";
import { fill, useLocale } from "../lib/i18n";
import { formatDay } from "../lib/dashboard-shared";

export type SampleView = {
  on: boolean;
  /** When the sample store was generated (ISO). */
  loadedAt?: string | null;
  /** The store's own data is ready: offer to switch. */
  realReady?: boolean;
  /** The store's own plan is below Growth: sample data shows Growth's features. */
  planLifted?: boolean;
  /** Generated a few days ago: its dates drift from today, so a refresh is offered. */
  stale?: boolean;
};

const SampleContext = createContext<SampleView>({ on: false });

export function SampleProvider({ value, children }: { value: SampleView; children: ReactNode }) {
  return <SampleContext.Provider value={value}>{children}</SampleContext.Provider>;
}

/** Is the admin showing sample data? */
export function useSample(): SampleView {
  return useContext(SampleContext);
}

export const SAMPLE_ENDPOINT = "/app/sample";

export type SampleActionResult = { ok: true; on: boolean } | { ok: false; error: "notInstalled" | "failed" | "bad_request" };

/** Turns sample data on or off; every loader re-runs after the action (React Router revalidation). */
function useSampleSwitch() {
  const fetcher = useFetcher<SampleActionResult>();
  return {
    submit: (on: boolean) => fetcher.submit({ intent: on ? "on" : "off" }, { method: "post", action: SAMPLE_ENDPOINT, encType: "application/json" }),
    busy: fetcher.state !== "idle",
    failed: !!fetcher.data && !fetcher.data.ok,
  };
}

/** "Switch to my store" with its confirm. */
function SwitchToStore({ variant = "secondary" }: { variant?: "primary" | "secondary" }) {
  const { t } = useLocale();
  const sw = useSampleSwitch();
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <s-button variant={variant} loading={flag(sw.busy)} onClick={() => setConfirm(true)}>
        {t("Switch to my store")}
      </s-button>
      <ConfirmModal
        open={confirm}
        destructive={false}
        title={t("Switch to your store?")}
        message={t("The sample data is deleted and every screen shows your own store again.")}
        confirmLabel={t("Switch to my store")}
        onConfirm={() => {
          setConfirm(false);
          sw.submit(false);
        }}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

/** A new sample store for today (its dates drift from today after a few days). */
function RefreshSample() {
  const { t } = useLocale();
  const sw = useSampleSwitch();
  return (
    <s-button variant="tertiary" loading={flag(sw.busy)} onClick={() => sw.submit(true)}>
      {t("Refresh sample data")}
    </s-button>
  );
}

/** The banner on every admin screen while sample data is shown (app layout). */
export function SampleBanner() {
  const { t, locale } = useLocale();
  const s = useSample();
  if (!s.on) return null;
  return (
    <s-banner tone="warning" heading={t("You're viewing sample data — nothing here is from your store.")}>
        <s-stack direction="block" gap="small">
          <s-paragraph>
            {t("It's a simulated clothing store, so you can try every screen before your own data is ready. Actions that would change your store are switched off.")}
            {s.planLifted ? ` ${t("Sample data shows every Growth feature, whatever your plan.")}` : ""}
            {s.loadedAt ? ` ${fill(t("Generated on {date}."), { date: formatDay(s.loadedAt.slice(0, 10), locale) })}` : ""}
          </s-paragraph>
          {s.realReady && <s-paragraph>{t("Your store is ready — your own order plan is waiting.")}</s-paragraph>}
          <s-stack direction="inline" gap="small">
            <SwitchToStore variant={s.realReady ? "primary" : "secondary"} />
            {s.stale && <RefreshSample />}
          </s-stack>
        </s-stack>
    </s-banner>
  );
}

/** Dashboard, while the store isn't ready: try the app on sample data. */
export function SampleOfferCard() {
  const { t } = useLocale();
  const sw = useSampleSwitch();
  const [confirm, setConfirm] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(sw.failed), [sw.failed]);
  return (
    <s-section heading={t("Explore Keha with sample data")}>
      <s-stack direction="block" gap="base">
        {failed && <s-banner tone="critical">{t("Sample data couldn't be loaded. Please try again in a minute.")}</s-banner>}
        <s-paragraph>
          {t("While we read your store, try every screen on a simulated clothing store: 60 products, 14 months of sales, suppliers and purchase orders. Nothing is added to your Shopify store, and you can switch back at any time.")}
        </s-paragraph>
        <s-stack direction="inline" gap="small">
          <s-button variant="primary" loading={flag(sw.busy)} onClick={() => setConfirm(true)}>
            {t("Explore with sample data")}
          </s-button>
        </s-stack>
      </s-stack>
      <ConfirmModal
        open={confirm}
        destructive={false}
        title={t("Explore with sample data?")}
        message={t("We'll load a simulated store so you can try the order plan, products and purchase orders. Your own data keeps loading in the background, and nothing changes in your Shopify store.")}
        confirmLabel={t("Load sample data")}
        onConfirm={() => {
          setConfirm(false);
          sw.submit(true);
        }}
        onCancel={() => setConfirm(false)}
      />
    </s-section>
  );
}

/** Where an action would change the store: why it's off in sample data. */
export function SampleOffNote({ children }: { children?: ReactNode }) {
  const { t } = useLocale();
  if (!useSample().on) return null;
  return <s-banner tone="info">{children ?? t("Not available in sample data — nothing here changes your store.")}</s-banner>;
}
