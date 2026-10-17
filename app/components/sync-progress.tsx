/**
 * The first-sync screen on the Dashboard (owner 2026-10-17): replaces the old "Reading your
 * store…" bars. Pure view over SyncView (lib/sync-progress-shared) — five stages with their own
 * progress, the ETA measured from this store's read, what to do meanwhile, and errors in plain
 * words. Kept as its own component so other Dashboard cards (sample data) can sit beside it.
 *
 *  - mode "full": while the store is being read for the first time (Dashboard state "syncing").
 *  - mode "compact": numbers already show (from the newest months) or the store is waiting for
 *    sales / tracked stock, and older months are still loading.
 */
import { useLocale, fill } from "../lib/i18n";
import { formatCount, formatPercent } from "../lib/dashboard-shared";
import {
  etaBasisText,
  etaText,
  partialText,
  salesSpanText,
  sizeText,
  stageErrorText,
  stageLabel,
  stageStatusText,
  type SalesSpan,
  type SyncStage,
  type SyncView,
} from "../lib/sync-progress-shared";
import { FormCard } from "./ui";
import { useLinkProps } from "./wc";
import { planTag } from "./plan";

export type SyncSetup = {
  leadTimeDone: boolean;
  suppliersDone: boolean;
  importEnabled?: boolean;
};

function StageRow({ stage }: { stage: SyncStage }) {
  const { t, locale } = useLocale();
  const count = (n: number) => formatCount(n, locale);
  const pct = (r: number) => formatPercent(r, locale);
  const label = stageLabel(stage.key, t);
  const error = stageErrorText(stage, t, locale);
  const finished = stage.status === "done" || stage.status === "gaps";
  const icon = finished ? "check-circle-filled" : stage.status === "retrying" ? "alert-circle" : "circle";
  const tone = finished ? "success" : stage.status === "retrying" ? "warning" : "neutral";
  const bar = (stage.status === "running" || stage.status === "retrying") && stage.percent !== null;
  return (
    <div className="keha-sync-stage" data-stage={stage.key} data-status={stage.status}>
      <s-icon type={icon} tone={tone} />
      <s-stack direction="block" gap="small-200">
        <div className="keha-row-between">
          <s-text type={stage.status === "running" ? "strong" : undefined}>{label}</s-text>
          <s-text color="subdued">
            <span className="keha-nowrap keha-num">{stageStatusText(stage, t, count, pct)}</span>
          </s-text>
        </div>
        {bar && <s-progress value={stage.percent ?? 0} max={100} accessibilityLabel={label} tone={stage.status === "retrying" ? "critical" : "auto"} />}
        {error && <s-text color="subdued">{error}</s-text>}
      </s-stack>
    </div>
  );
}

function Eta({ view }: { view: SyncView }) {
  const { t, locale } = useLocale();
  const count = (n: number) => formatCount(n, locale);
  const basis = etaBasisText(view.eta, view.variants, t, count);
  return (
    <s-stack direction="block" gap="small-200">
      <div className="keha-row-between">
        <s-text type="strong">{etaText(view.eta, t, count)}</s-text>
        <s-text color="subdued">
          <span className="keha-num">{formatPercent(view.percent / 100, locale)}</span>
        </s-text>
      </div>
      <s-progress value={view.percent} max={100} accessibilityLabel={fill(t("Still reading your store: {pct}."), { pct: formatPercent(view.percent / 100, locale) })} />
      {basis && <s-text color="subdued">{basis}</s-text>}
    </s-stack>
  );
}

/**
 * What to do while we read. The setup guide (shown right below while incomplete) holds lead time
 * and suppliers, so this points at it instead of repeating its buttons, and offers the CSV import
 * for stores with many products.
 */
function Meanwhile({ setup }: { setup: SyncSetup }) {
  const { t } = useLocale();
  const link = useLinkProps();
  const guideBelow = !(setup.leadTimeDone && setup.suppliersDone);
  return (
    <s-stack direction="block" gap="small-200">
      <s-text type="strong">{t("While you wait")}</s-text>
      <s-text color="subdued">
        {guideBelow
          ? t("Set your lead times and suppliers in the setup guide below so your first order plan is right from the start — or import them from a CSV.")
          : t("Many products? Set case packs, suppliers and Don't reorder for all of them at once from a CSV.")}
      </s-text>
      <s-stack direction="inline" gap="small-200">
        {setup.importEnabled ? (
          <s-button variant="secondary" icon="import" {...link("/app/settings/import")}>
            {t("Import from a CSV")}
          </s-button>
        ) : (
          <s-button variant="secondary" icon="lock" {...link("/app/settings/import")}>
            {`${t("Import from a CSV")} · ${planTag("csvImport", t)}`}
          </s-button>
        )}
      </s-stack>
    </s-stack>
  );
}

export function SyncProgress({ view, mode, setup }: { view: SyncView; mode: "full" | "compact"; setup?: SyncSetup }) {
  const { t, locale } = useLocale();
  const count = (n: number) => formatCount(n, locale);
  if (mode === "compact") {
    return (
      <FormCard
        title={view.partial ? t("Still reading older months") : t("Reading your store…")}
        sub={view.partial ? `${partialText(view.monthsRead, t, count)}. ${t("Older months are added as they are read.")}` : undefined}
      >
        <s-stack direction="block" gap="base">
          <Eta view={view} />
          {view.stages.map((s) => (
            <StageRow key={s.key} stage={s} />
          ))}
        </s-stack>
      </FormCard>
    );
  }
  return (
    <FormCard
      title={t("Setting up your order plan")}
      sub={fill(t("We're reading up to {n} months of sales, so the plan can reflect your seasons."), { n: count(view.months) })}
    >
      <s-stack direction="block" gap="base">
        <s-paragraph>
          {`${sizeText(view.size, t)} ${view.emailOnReady ? t("We'll email you when your order plan is ready.") : t("Your order plan appears here when it's ready.")}`}
        </s-paragraph>
        <Eta view={view} />
        <s-divider />
        {view.stages.map((s) => (
          <StageRow key={s.key} stage={s} />
        ))}
        {setup && (
          <>
            <s-divider />
            <Meanwhile setup={setup} />
          </>
        )}
      </s-stack>
    </FormCard>
  );
}

/** "Your order plan is ready" — once the first full read is in (shown for a few days). */
export function ReadyNotice({ span }: { span: SalesSpan }) {
  const { t, locale } = useLocale();
  return (
    <s-banner tone="success" heading={t("Your order plan is ready")} dismissible>
      {salesSpanText(span, t, (n) => formatCount(n, locale))}
    </s-banner>
  );
}
