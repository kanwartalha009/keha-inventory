/**
 * Order plan · Season plan (/app/reorder/season) — spec §4 J6, §5.4, §7.8; task 2.5. Growth (`planner`;
 * every action checks the plan on the server too). One of the Order plan tabs (Kanwar
 * 2026-10-17): below Growth the tab bar stays and the tab shows what it does (ORDER_PLAN_PATHS).
 *
 *  - Scenarios: an event (Black Friday, Christmas, custom dates), a period and a target (grow
 *    X %, a revenue target, or keep pace). Growth keeps 1 scenario, Pro unlimited — checked on
 *    the server on create; at the limit the create button becomes the teaching state.
 *    Results are calculated on save and stored with the scenario; "Recalculate" refreshes them.
 *  - Output: demand per collection, an order list with order-by dates grouped by supplier,
 *    cash needed per week (bar chart + table), last year's same period, and a warning with
 *    fewer than 13 months of history. Every number has a "How we got this" popover.
 *  - Collection goals (`collectionGoals`) and "How accurate we were" (`accuracy`).
 * Nothing here changes the store: the planner only reads.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateApp } from "../services/data-scope.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import {
  createScenario,
  deleteGoal,
  deleteScenario,
  loadPlanner,
  recalculateScenario,
  saveGoal,
  updateScenario,
  type GoalsData,
  type PlannerData,
  type ScorecardData,
  type ScenarioView,
} from "../models/planner.server";
import { plannerShop } from "../services/planner.server";
import { AppPage, FormCard, HeaderLabel, ProductThumb } from "../components/ui";
import ConfirmModal from "../components/ConfirmModal";
import { featureCopy, planTag } from "../components/plan";
import { OrderPlanTabs } from "../components/order-plan-tabs";
import { TabLock } from "../components/order-plan";
import { SelectField, flag, useLinkProps, val } from "../components/wc";
import { fill, plural, useLocale } from "../lib/i18n";
import { formatAmount, formatCount, formatDay, formatPercent, formatUpdatedAt } from "../lib/dashboard-shared";
import { variantName } from "../lib/products-shared";
import type { Feature, PlanCode } from "../lib/plan-shared";
import {
  SCENARIO_EVENTS,
  TARGET_TYPES,
  cashBars,
  eventLabel,
  eventPeriod,
  goalErrorText,
  isScenarioEvent,
  isTargetType,
  readScenarioForm,
  reorderLink,
  scenarioErrorText,
  targetTypeLabel,
  validateScenario,
  type CashWeek,
  type GoalErrorCode,
  type PlannerGroup,
  type ScenarioErrors,
  type ScenarioForm,
  type ScenarioResult,
} from "../lib/planner-shared";

type T = (s: string) => string;

const LOCKED: PlannerData = {
  enabled: false,
  plan: "free",
  features: { collectionGoals: false, accuracy: false },
  today: "",
  timezone: "UTC",
  currency: "USD",
  history: { enough: false, from: null },
  scenarios: [],
  selected: null,
  canAdd: false,
  limit: 0,
  editing: null,
  collectionTitles: {},
  collectionOptions: [],
  goals: null,
  scorecard: null,
};

const planOf = (p: PlanCode | "none"): PlanCode => (p === "none" ? "free" : p);

export const loader = async ({ request }: LoaderFunctionArgs): Promise<PlannerData> => {
  const { shop } = await authenticateApp(request);
  const { plan, features } = await getEntitlements(shop);
  // Locked page (app.tsx shows the plan page): send nothing.
  if (!features.planner) return { ...LOCKED, plan: planOf(plan) };
  const url = new URL(request.url);
  return loadPlanner(shop, {
    plan: planOf(plan),
    features: { collectionGoals: features.collectionGoals, accuracy: features.accuracy },
    selectedId: url.searchParams.get("scenario"),
    edit: url.searchParams.get("edit"),
  });
};

export type PlannerAction =
  | { ok: true; intent: "save" | "delete" | "recalculate" | "goal_save" | "goal_delete"; id?: string }
  | { ok: false; errors?: ScenarioErrors; error?: "limit" | "notFound" | GoalErrorCode };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticateApp(request);
  const { plan, features } = await getEntitlements(shop);
  if (!features.planner) return upgradeResponse("planner", "The planner is on the Growth plan.");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  const id = typeof body.id === "string" && body.id ? body.id : null;
  switch (body.intent) {
    case "save": {
      const { today } = await plannerShop(shop);
      const v = validateScenario(readScenarioForm(body.form), today);
      if (!v.ok) return { ok: false, errors: v.errors } satisfies PlannerAction;
      const r = id ? await updateScenario(shop, id, v.input) : await createScenario(shop, planOf(plan), v.input);
      if (!r.ok) return { ok: false, error: r.error } satisfies PlannerAction;
      return { ok: true, intent: "save", id: r.id } satisfies PlannerAction;
    }
    case "delete": {
      if (!id || !(await deleteScenario(shop, id))) return { ok: false, error: "notFound" } satisfies PlannerAction;
      return { ok: true, intent: "delete" } satisfies PlannerAction;
    }
    case "recalculate": {
      const r = id ? await recalculateScenario(shop, id) : ({ ok: false, error: "notFound" } as const);
      if (!r.ok) return { ok: false, error: r.error } satisfies PlannerAction;
      return { ok: true, intent: "recalculate", id: r.id } satisfies PlannerAction;
    }
    case "goal_save": {
      if (!features.collectionGoals) return upgradeResponse("collectionGoals", "Collection goals are on the Growth plan.");
      const r = await saveGoal(shop, { collectionId: body.collectionId, goalPct: body.goalPct });
      if (!r.ok) return { ok: false, error: r.error } satisfies PlannerAction;
      return { ok: true, intent: "goal_save" } satisfies PlannerAction;
    }
    case "goal_delete": {
      if (!features.collectionGoals) return upgradeResponse("collectionGoals", "Collection goals are on the Growth plan.");
      const cid = typeof body.collectionId === "string" ? body.collectionId : "";
      if (!(await deleteGoal(shop, cid))) return { ok: false, error: "notFound" } satisfies PlannerAction;
      return { ok: true, intent: "goal_delete" } satisfies PlannerAction;
    }
    default:
      throw new Response("Bad request", { status: 400 });
  }
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Planner() {
  const { t } = useLocale();
  const data = useLoaderData<typeof loader>() as PlannerData;
  const navigate = useNavigate();
  if (!data.enabled) {
    return (
      <AppPage heading={t("Order plan")}>
        <OrderPlanTabs current="season" />
        <TabLock feature="planner" />
      </AppPage>
    );
  }
  const selected = data.selected;
  return (
    <AppPage
      heading={t("Order plan")}
      intro={t("Plan a season or a growth target: what to order, by when, and the cash you need each week.")}
      primaryAction={
        data.canAdd && !data.editing ? (
          <s-button variant="primary" onClick={() => navigate("/app/reorder/season?edit=new")}>
            {t("New scenario")}
          </s-button>
        ) : undefined
      }
    >
      <OrderPlanTabs current="season" />
      {!data.history.enough && <s-banner tone="warning">{t("Based on the last 90 days only; we don't have last year's sales yet.")}</s-banner>}
      {data.editing && <ScenarioEditor key={data.editing.id ?? "new"} editing={data.editing} today={data.today} />}
      <Scenarios data={data} />
      {selected && <ScenarioOutput scenario={selected} result={selected.result} titles={data.collectionTitles} timezone={data.timezone} />}
      {data.features.collectionGoals ? (
        <CollectionGoals goals={data.goals} options={data.collectionOptions} currency={data.currency} />
      ) : (
        <LockedSection feature="collectionGoals" />
      )}
      {data.features.accuracy ? <Scorecard data={data.scorecard} /> : <LockedSection feature="accuracy" />}
    </AppPage>
  );
}

/** A paid section on a plan without it: what it does and an Upgrade button (plan locks teach). */
function LockedSection({ feature }: { feature: Feature }) {
  const { t } = useLocale();
  const link = useLinkProps();
  const copy = featureCopy(feature, t);
  return (
    <FormCard title={copy.title}>
      <s-stack direction="block" gap="small-200">
        <s-badge tone="info">{planTag(feature, t)}</s-badge>
        <s-paragraph color="subdued">{copy.body}</s-paragraph>
        <s-stack direction="inline">
          <s-button variant="primary" {...link("/app/plans")}>
            {t("See plans")}
          </s-button>
        </s-stack>
      </s-stack>
    </FormCard>
  );
}

/** "How we got this": an info button and a popover whose last line is "Based on: …". */
function HowWeGotThis({ id, title, lines }: { id: string; title: string; lines: string[] }) {
  const { t } = useLocale();
  return (
    <>
      <s-stack direction="inline">
        <s-button variant="tertiary" icon="info" commandFor={id} accessibilityLabel={`${t("How we got this")}: ${title}`}>
          {t("How we got this")}
        </s-button>
      </s-stack>
      <s-popover id={id}>
        <s-box padding="base" maxInlineSize="360px">
          <s-stack direction="block" gap="small-200">
            <s-heading>{title}</s-heading>
            {lines.map((l, i) => (
              <s-text key={i} color={i === lines.length - 1 ? "subdued" : "base"}>
                {l}
              </s-text>
            ))}
          </s-stack>
        </s-box>
      </s-popover>
    </>
  );
}

const periodText = (start: string, end: string, t: T, locale: string) => fill(t("{from} to {to}"), { from: formatDay(start, locale), to: formatDay(end, locale) });

function targetText(s: Pick<ScenarioView, "targetType" | "targetValue">, currency: string, t: T, locale: string): string {
  if (s.targetType === "growth") return fill(t("Grow {pct}"), { pct: formatPercent(s.targetValue / 100, locale) });
  if (s.targetType === "revenue") return fill(t("Revenue target {amount}"), { amount: formatAmount(s.targetValue, currency, locale) });
  return t("Keep pace");
}

// ---------------------------------------------------------------------------
// Scenarios list
// ---------------------------------------------------------------------------

function Scenarios({ data }: { data: PlannerData }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const navigate = useNavigate();
  const fetcher = useFetcher<PlannerAction>();
  const [confirm, setConfirm] = useState<ScenarioView | null>(null);
  const atLimit = !data.canAdd;
  return (
    <FormCard title={t("Scenarios")}>
      <s-stack direction="block" gap="base">
        {data.scenarios.length === 0 ? (
          <s-stack direction="block" gap="small-200">
            <s-heading>{t("Plan your next season")}</s-heading>
            <s-paragraph color="subdued">
              {t("Pick Black Friday, Christmas or your own dates and a target. We work out what to order, by when, and the cash you need each week.")}
            </s-paragraph>
          </s-stack>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary"><HeaderLabel id="keha-ph-scenario-name" label={t("Scenario name")} /></s-table-header>
              <s-table-header listSlot="labeled"><HeaderLabel id="keha-ph-period" label={t("Period")} /></s-table-header>
              <s-table-header listSlot="labeled"><HeaderLabel id="keha-ph-target" label={t("Target")} /></s-table-header>
              <s-table-header><HeaderLabel id="keha-ph-manage" label={t("Manage")} /></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.scenarios.map((s) => (
                <s-table-row key={s.id}>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-link {...link(`/app/reorder/season?scenario=${encodeURIComponent(s.id)}`)}>{s.name}</s-link>
                      <s-text color="subdued">{isScenarioEvent(s.event) ? eventLabel(s.event, t) : eventLabel("custom", t)}</s-text>
                      {data.selected?.id === s.id && <s-badge tone="info">{t("Showing")}</s-badge>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{periodText(s.start, s.end, t, locale)}</s-table-cell>
                  <s-table-cell>{targetText(s, data.currency, t, locale)}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      <s-button variant="tertiary" onClick={() => navigate(`/app/reorder/season?edit=${encodeURIComponent(s.id)}&scenario=${encodeURIComponent(s.id)}`)}>
                        {t("Edit")}
                      </s-button>
                      <s-button variant="tertiary" tone="critical" onClick={() => setConfirm(s)}>
                        {t("Delete")}
                      </s-button>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {atLimit ? (
          <s-banner tone="info" heading={t("Your plan keeps 1 scenario")}>
            <s-paragraph>{t("Edit or replace the scenario you have, or move to Pro to plan as many seasons as you like.")}</s-paragraph>
            <s-button slot="secondary-actions" variant="primary" {...link("/app/plans")}>
              {t("See plans")}
            </s-button>
          </s-banner>
        ) : (
          !data.editing && (
            <s-stack direction="inline">
              <s-button onClick={() => navigate("/app/reorder/season?edit=new")}>{t("New scenario")}</s-button>
            </s-stack>
          )
        )}
      </s-stack>
      <ConfirmModal
        open={!!confirm}
        title={fill(t("Delete the scenario {name}?"), { name: confirm?.name ?? "" })}
        message={t("Its plan and order list are removed. Nothing in your store changes.")}
        confirmLabel={t("Delete")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const id = confirm?.id;
          setConfirm(null);
          if (id) fetcher.submit({ intent: "delete", id } as never, { method: "post", encType: "application/json" });
        }}
      />
    </FormCard>
  );
}

// ---------------------------------------------------------------------------
// Scenario form
// ---------------------------------------------------------------------------

function ScenarioEditor({ editing, today }: { editing: NonNullable<PlannerData["editing"]>; today: string }) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const fetcher = useFetcher<PlannerAction>();
  const [form, setForm] = useState<ScenarioForm>(editing.form);
  const result = fetcher.data;
  useEffect(() => {
    if (result?.ok && result.intent === "save") navigate(`/app/reorder/season?scenario=${encodeURIComponent(result.id ?? "")}`, { replace: true });
  }, [result, navigate]);
  const errors: ScenarioErrors = result && !result.ok && result.errors ? result.errors : {};
  const err = (k: keyof ScenarioForm) => (errors[k] ? scenarioErrorText(errors[k]!, t) : undefined);
  const set = <K extends keyof ScenarioForm>(k: K, v: ScenarioForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const pickEvent = (e: string) => {
    if (!isScenarioEvent(e)) return;
    const p = eventPeriod(e, today);
    setForm((f) => ({ ...f, event: e, ...(p ? { start: p.start, end: p.end } : {}), name: f.name.trim() ? f.name : eventLabel(e, t) }));
  };
  const save = () => fetcher.submit({ intent: "save", id: editing.id, form } as never, { method: "post", encType: "application/json" });
  return (
    <FormCard
      title={editing.id ? t("Edit scenario") : t("New scenario")}
      sub={t("Results are calculated when you save. Nothing in your store changes.")}
    >
      <s-text-field label={t("Scenario name")} value={form.name} error={err("name")} onInput={(e) => set("name", val(e))} />
      <SelectField
        label={t("Event")}
        value={form.event}
        options={SCENARIO_EVENTS.map((e) => ({ value: e, label: eventLabel(e, t) }))}
        onChange={pickEvent}
        details={form.event === "black_friday" ? t("Thursday to Cyber Monday.") : form.event === "christmas" ? t("1 to 24 December.") : undefined}
      />
      <s-stack direction="inline" gap="base">
        <s-date-field label={t("Start date")} value={form.start} error={err("start")} onChange={(e) => set("start", val(e))} />
        <s-date-field label={t("End date")} value={form.end} error={err("end")} onChange={(e) => set("end", val(e))} />
      </s-stack>
      <SelectField
        label={t("Target")}
        value={form.targetType}
        options={TARGET_TYPES.map((tt) => ({ value: tt, label: targetTypeLabel(tt, t) }))}
        onChange={(v) => isTargetType(v) && set("targetType", v)}
      />
      {form.targetType === "growth" && (
        <s-number-field
          label={t("Growth vs. sales now")}
          value={form.targetValue}
          suffix="%"
          step={1}
          details={t("For example 20 for +20%.")}
          error={err("targetValue")}
          onInput={(e) => set("targetValue", val(e))}
        />
      )}
      {form.targetType === "revenue" && (
        <s-number-field
          label={t("Revenue target for the period")}
          value={form.targetValue}
          min={1}
          step={1}
          details={t("In your store currency.")}
          error={err("targetValue")}
          onInput={(e) => set("targetValue", val(e))}
        />
      )}
      {result && !result.ok && result.error === "limit" && (
        <s-banner tone="info">{t("Your plan keeps 1 scenario. Edit the one you have, or see plans for more.")}</s-banner>
      )}
      {result && !result.ok && result.error === "notFound" && <s-banner tone="warning">{t("This scenario was deleted. Reload the page.")}</s-banner>}
      <s-stack direction="inline" gap="base" justifyContent="end">
        <s-button onClick={() => navigate("/app/reorder/season", { replace: true })}>{t("Cancel")}</s-button>
        <s-button variant="primary" loading={flag(fetcher.state !== "idle")} onClick={save}>
          {t("Save and calculate")}
        </s-button>
      </s-stack>
    </FormCard>
  );
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function ScenarioOutput({
  scenario,
  result,
  titles,
  timezone,
}: {
  scenario: ScenarioView;
  result: ScenarioResult | null;
  titles: Record<string, string>;
  timezone: string;
}) {
  const { t, locale } = useLocale();
  const fetcher = useFetcher<PlannerAction>();
  const recalc = (
    <s-button loading={flag(fetcher.state !== "idle")} onClick={() => fetcher.submit({ intent: "recalculate", id: scenario.id } as never, { method: "post", encType: "application/json" })}>
      {t("Recalculate")}
    </s-button>
  );
  const head = (
    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
      <s-stack direction="block" gap="none">
        <s-heading>{scenario.name}</s-heading>
        <s-text color="subdued">
          {periodText(scenario.start, scenario.end, t, locale)}
          {result ? ` · ${fill(t("Calculated {date}"), { date: formatUpdatedAt(result.computedAt, timezone, locale) })}` : ""}
        </s-text>
      </s-stack>
      {recalc}
    </s-stack>
  );
  if (!result) {
    return (
      <s-section>
        <s-stack direction="block" gap="base">
          {head}
          <s-paragraph color="subdued">{t("This scenario has no results yet. Recalculate to see them.")}</s-paragraph>
        </s-stack>
      </s-section>
    );
  }
  return (
    <>
      <s-section>
        <s-stack direction="block" gap="base">
          {head}
          {result.period.effectiveStart !== result.period.start && (
            <s-text color="subdued">{fill(t("This period has started: planned from today, {date}."), { date: formatDay(result.period.effectiveStart, locale) })}</s-text>
          )}
          {result.status === "no_data" && <s-banner tone="info">{t("Not enough sales yet to advise")}</s-banner>}
          {result.status === "no_baseline" && (
            <s-banner tone="warning">{t("We can't plan a revenue target without sales and prices yet. Try a growth percentage instead.")}</s-banner>
          )}
          {result.status === "ok" && <Summary result={result} />}
        </s-stack>
      </s-section>
      {result.status === "ok" && (
        <>
          <CashChart result={result} />
          <OrderList result={result} scenarioId={scenario.id} />
          <CollectionDemandTable result={result} titles={titles} />
        </>
      )}
    </>
  );
}

function SummaryBox({ id, title, value, sub, lines }: { id: string; title: string; value: string; sub?: string; lines: string[] }) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{title}</s-text>
        <span className="keha-money__value">{value}</span>
        {sub && <s-text color="subdued">{sub}</s-text>}
        <HowWeGotThis id={id} title={title} lines={lines} />
      </s-stack>
    </s-box>
  );
}

const num2 = (v: number | null, locale: string) =>
  v === null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v);

function Summary({ result }: { result: ScenarioResult }) {
  const { t, locale } = useLocale();
  const r = result;
  const money = (v: number | null) => formatAmount(v, r.currency, locale);
  const range = periodText(r.period.effectiveStart, r.period.end, t, locale);
  const season = r.season;
  const seasonal = season.applied ? `× ${num2(season.value, locale)}` : t("No seasonal data yet");
  const planLine =
    r.plan.type === "revenue"
      ? fill(t("Plan: revenue target {target} ÷ expected revenue at today's pace {base} = × {x}"), {
          target: money(r.plan.value),
          base: money(r.plan.baselineRevenue),
          x: num2(r.plan.multiplier, locale),
        })
      : fill(t("Plan multiplier: × {x}"), { x: num2(r.plan.multiplier, locale) });
  const demandLines = [
    fill(t("Variants planned: {n}"), { n: formatCount(r.totals.variants, locale) }),
    ...(r.totals.noData ? [fill(t("Not enough sales yet to advise: {n} variants"), { n: formatCount(r.totals.noData, locale) })] : []),
    fill(t("Seasonal index (store): {value}"), { value: seasonal }),
    ...(season.applied
      ? [
          fill(t("{from} to {to}: {a} units a day, vs {b} a day from {c} to {d}"), {
            from: formatDay(season.spanFrom, locale),
            to: formatDay(season.spanTo, locale),
            a: num2(season.spanPerDay, locale),
            b: num2(season.basePerDay, locale),
            c: formatDay(season.baseFrom, locale),
            d: formatDay(season.baseTo, locale),
          }),
        ]
      : []),
    ...(season.collectionVariants ? [fill(t("Variants using their collection's own index: {n}"), { n: formatCount(season.collectionVariants, locale) })] : []),
    ...(season.productTypeVariants ? [fill(t("Variants using their product type's own index: {n}"), { n: formatCount(season.productTypeVariants, locale) })] : []),
    // The trend is named only when the scenario used it (growth assumption on — 2026-10-17).
    ...(season.trendApplied ? [fill(t("Trend (last 28 days vs the same weeks last year): × {x}"), { x: num2(season.trend, locale) })] : []),
    planLine,
    season.trendApplied
      ? fill(t("Based on: sales per day while in stock × seasonal index × trend × plan × {n} days, {range}"), { n: formatCount(r.period.days, locale), range })
      : fill(t("Based on: sales per day while in stock × seasonal index × plan × {n} days, {range}"), { n: formatCount(r.period.days, locale), range }),
  ];
  const revenueLines = [
    fill(t("Expected units: {n}"), { n: formatCount(Math.round(r.totals.units ?? 0), locale) }),
    ...(r.totals.missingPrice ? [fill(t("Variants without a price, not counted: {n}"), { n: formatCount(r.totals.missingPrice, locale) })] : []),
    t("Based on: expected units × each variant's price in Shopify"),
  ];
  // Merchant audit 2026-10-18: the same cash model as Next 13 weeks — cost only, payment terms, freight & duty.
  const cashLines = [
    fill(t("Order lines: {n}"), { n: formatCount(r.order.lines, locale) }),
    ...(r.order.late ? [fill(t("Overdue: {n}"), { n: formatCount(r.order.late, locale) })] : []),
    ...(r.cash.landed ? [fill(t("Of which freight & duty: {amount}"), { amount: money(r.cash.landed) })] : []),
    ...(r.cash.missing
      ? [fill(plural(r.cash.missing, t("1 line without a cost price is not in the cash totals."), t("{n} lines without a cost price are not in the cash totals.")), { n: formatCount(r.cash.missing, locale) })]
      : []),
    t("Based on: units to order × unit cost from Shopify, paid on each supplier's payment terms, plus freight & duty. Lines without a cost price are left out."),
  ];
  const ly = r.lastYear;
  const lyRange = periodText(ly.from, ly.to, t, locale);
  const lyLines =
    ly.units === null
      ? [t("Not enough sales history for these dates yet."), fill(t("Based on: units sold and sales on the same dates last year, all sales channels, {range}"), { range: lyRange })]
      : [
          fill(t("Units sold: {n}"), { n: formatCount(ly.units, locale) }),
          fill(t("Based on: units sold and sales on the same dates last year, all sales channels, {range}"), { range: lyRange }),
        ];
  return (
    <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
      <SummaryBox
        id="keha-plan-demand"
        title={t("Expected sales (units)")}
        value={formatCount(r.totals.units === null ? null : Math.round(r.totals.units), locale)}
        sub={range}
        lines={demandLines}
      />
      <SummaryBox id="keha-plan-revenue" title={t("Expected revenue")} value={money(r.totals.revenue)} lines={revenueLines} />
      <SummaryBox
        id="keha-plan-cash"
        title={t("Cash needed")}
        value={money(r.cash.total)}
        lines={cashLines}
      />
      <SummaryBox
        id="keha-plan-ly"
        title={t("Last year, same period")}
        value={money(ly.revenue)}
        sub={ly.units === null ? lyRange : `${fill(plural(ly.units, t("1 unit"), t("{n} units")), { n: formatCount(ly.units, locale) })} · ${lyRange}`}
        lines={lyLines}
      />
    </s-grid>
  );
}

const CHART_W = 640;
const CHART_H = 160;

function weekLabel(w: CashWeek, locale: string): string {
  try {
    return new Date(`${w.weekStart}T12:00:00Z`).toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  } catch {
    return w.weekStart;
  }
}

function CashChart({ result }: { result: ScenarioResult }) {
  const { t, locale } = useLocale();
  const weeks = result.cash.weeks;
  const money = (v: number | null) => formatAmount(v, result.currency, locale);
  const bars = cashBars(weeks, CHART_W, CHART_H);
  const every = Math.max(1, Math.ceil(weeks.length / 8));
  const label = weeks.length
    ? fill(t("Cash needed per week from {from} to {to}: {amount} in total."), {
        from: formatDay(weeks[0]!.weekStart, locale),
        to: formatDay(weeks[weeks.length - 1]!.weekStart, locale),
        amount: money(result.cash.total),
      })
    : "";
  return (
    <FormCard title={t("Cash needed per week")}>
      <s-stack direction="block" gap="base">
        {weeks.length === 0 ? (
          <s-paragraph color="subdued">{t("Nothing to order for this period: the stock you have covers it.")}</s-paragraph>
        ) : (
          <>
            <svg className="keha-chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={label}>
              {bars.map((b, i) => (
                <g key={b.week.weekStart}>
                  {b.height > 0 && (
                    <rect className="keha-chart__bar" x={b.x} y={b.y} width={b.width} height={b.height}>
                      <title>{`${weekLabel(b.week, locale)}: ${money(b.week.amount)}`}</title>
                    </rect>
                  )}
                  {i % every === 0 && (
                    <text x={b.x + b.width / 2} y={CHART_H - 6} textAnchor="middle" fontSize="11" fill="currentColor">
                      {weekLabel(b.week, locale)}
                    </text>
                  )}
                </g>
              ))}
            </svg>
            <HowWeGotThis
              id="keha-plan-weeks"
              title={t("Cash needed per week")}
              lines={[
                t("Each payment counts in the week it is paid: the deposit when you order, the rest on the supplier's terms, freight & duty on arrival. Late orders are ordered this week."),
                t("Based on: units to order × unit cost from Shopify, paid on each supplier's payment terms, plus freight & duty. Lines without a cost price are left out."),
              ]}
            />
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary"><HeaderLabel id="keha-ph-week-of" label={t("Week of")} /></s-table-header>
                <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-cash-needed" label={t("Cash needed")} /></s-table-header>
                <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-order-lines" label={t("Order lines")} /></s-table-header>
                <s-table-header listSlot="labeled"><HeaderLabel id="keha-ph-note" label={t("Note")} /></s-table-header>
              </s-table-header-row>
              <s-table-body>
                {weeks.map((w) => (
                  <s-table-row key={w.weekStart}>
                    <s-table-cell>{formatDay(w.weekStart, locale)}</s-table-cell>
                    <s-table-cell>{money(w.amount)}</s-table-cell>
                    <s-table-cell>{formatCount(w.lines, locale)}</s-table-cell>
                    <s-table-cell>
                      {[
                        w.late ? t("Includes late orders") : null,
                        w.missing ? fill(plural(w.missing, t("1 line without a cost price"), t("{n} lines without a cost price")), { n: formatCount(w.missing, locale) }) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </>
        )}
      </s-stack>
    </FormCard>
  );
}

function groupName(g: PlannerGroup, t: T): string {
  return g.kind === "supplier" ? g.name : g.name || t("No vendor");
}

function OrderList({ result, scenarioId }: { result: ScenarioResult; scenarioId?: string }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const all = result.groups.flatMap((g) => g.lines.map((l) => ({ variantId: l.variantId, qty: l.qty })));
  return (
    <FormCard title={t("What to order, and by when")}>
      <s-stack direction="block" gap="base">
        {result.groups.length === 0 ? (
          <s-paragraph color="subdued">{t("Nothing to order for this period: the stock you have covers it.")}</s-paragraph>
        ) : (
          <>
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-text color="subdued">
                {fill(plural(result.order.lines, t("1 product to order, {units} units."), t("{n} products to order, {units} units.")), { n: formatCount(result.order.lines, locale), units: formatCount(result.order.units, locale) })}
              </s-text>
              <s-button {...link(reorderLink(all, scenarioId ? { scenarioId } : undefined))}>{t("Add to purchase order")}</s-button>
            </s-stack>
            <HowWeGotThis
              id="keha-plan-order"
              title={t("What to order, and by when")}
              lines={[
                t("Units to order = expected sales in the period + safety stock − stock expected when the period starts, rounded up to case packs and minimum orders."),
                t("Stock expected at the start = stock now + incoming − expected sales until the period starts (never below 0)."),
                t("Order by = period start − lead time − safety days. Past dates show “Overdue”."),
                result.season.trendApplied
                  ? t("Based on: sales per day while in stock, seasonal index, trend, plan, stock now, incoming, supplier lead times, case packs and minimums")
                  : t("Based on: sales per day while in stock, seasonal index, plan, stock now, incoming, supplier lead times, case packs and minimums"),
              ]}
            />
            {result.groups.map((g) => (
              <GroupTable key={g.key} group={g} currency={result.currency} scenarioId={scenarioId} />
            ))}
          </>
        )}
      </s-stack>
    </FormCard>
  );
}

function GroupTable({ group, currency, scenarioId }: { group: PlannerGroup; currency: string; scenarioId?: string }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const lead = fill(group.leadTimeSource === "supplier" ? plural(group.leadTimeDays, t("1 day (supplier)"), t("{n} days (supplier)")) : plural(group.leadTimeDays, t("1 day (store default)"), t("{n} days (store default)")), { n: formatCount(group.leadTimeDays, locale) });
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-heading>{groupName(group, t)}</s-heading>
            {group.kind === "vendor" && <s-badge tone="neutral">{t("No supplier — grouped by vendor")}</s-badge>}
            {group.late && <s-badge tone="critical">{t("Overdue")}</s-badge>}
          </s-stack>
          <s-link {...link(reorderLink(group.lines.map((l) => ({ variantId: l.variantId, qty: l.qty })), scenarioId ? { scenarioId, groupKey: group.key } : undefined))}>{t("Add to purchase order")}</s-link>
        </s-stack>
        <s-text color="subdued">
          {`${t("Lead time")}: ${lead} · ${t("Order by")}: ${formatDay(group.orderBy, locale)} · ${fill(t("Units: {n}"), { n: formatCount(group.units, locale) })} · ${fill(t("Cost: {amount}"), {
            amount: group.missing ? "—" : formatAmount(group.value, currency, locale),
          })}`}
        </s-text>
        {group.toppedUp && (
          <s-text color="subdued">
            {fill(t("Topped up to reach {supplier}'s minimum of {min} units."), {
              supplier: groupName(group, t),
              min: formatCount(group.minOrderTotal ?? null, locale),
            })}
          </s-text>
        )}
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary"><HeaderLabel id="keha-ph-product" label={t("Product")} /></s-table-header>
            <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-expected-sales" label={t("Expected sales")} /></s-table-header>
            <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-stock-at-start" label={t("Stock at start")} /></s-table-header>
            <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-to-order" label={t("To order")} /></s-table-header>
            <s-table-header listSlot="secondary"><HeaderLabel id="keha-ph-order-by" label={t("Order by")} /></s-table-header>
            <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-line-total" label={t("Line total")} /></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {group.lines.map((l) => {
              const sub = [variantName(l.variantTitle), l.sku].filter(Boolean).join(" · ");
              const details = [
                l.pack ? fill(t("Cases of {n}"), { n: formatCount(l.pack, locale) }) : null,
                l.moq ? fill(t("Minimum {n} per item"), { n: formatCount(l.moq, locale) }) : null,
                fill(t("Safety stock {n}"), { n: formatCount(Math.round(l.safety), locale) }),
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <s-table-row key={l.variantId}>
                  <s-table-cell>
                    <div className="keha-cell-product">
                      <ProductThumb src={l.image} alt={l.productTitle} size={40} />
                      <s-stack direction="block" gap="none">
                        <s-text fontWeight="medium">{l.productTitle}</s-text>
                        {sub && <s-text color="subdued">{sub}</s-text>}
                      </s-stack>
                    </div>
                  </s-table-cell>
                  <s-table-cell>{formatCount(Math.round(l.demand), locale)}</s-table-cell>
                  <s-table-cell>{formatCount(Math.round(l.stockAtStart), locale)}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text fontWeight="medium">{formatCount(l.qty, locale)}</s-text>
                      <s-text color="subdued">{details}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <span>{formatDay(l.orderBy, locale)}</span>
                      {l.late && <s-badge tone="critical">{t("Overdue")}</s-badge>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <span>{formatAmount(l.lineValue, currency, locale)}</span>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
      </s-stack>
    </s-box>
  );
}

function CollectionDemandTable({ result, titles }: { result: ScenarioResult; titles: Record<string, string> }) {
  const { t, locale } = useLocale();
  const money = (v: number | null) => formatAmount(v, result.currency, locale);
  return (
    <FormCard title={t("Demand per collection")}>
      <s-stack direction="block" gap="base">
        <s-text color="subdued">{t("A product in several collections counts in each, so collection totals overlap. The store total counts each product once.")}</s-text>
        <HowWeGotThis
          id="keha-plan-collections"
          title={t("Demand per collection")}
          lines={[
            fill(t("Variants without a price, not counted in revenue: {n}"), { n: formatCount(result.totals.missingPrice, locale) }),
            fill(t("Based on: expected units per variant in the period × price, {range}"), { range: periodText(result.period.effectiveStart, result.period.end, t, locale) }),
          ]}
        />
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary"><HeaderLabel id="keha-ph-collection" label={t("Collection")} /></s-table-header>
            <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-expected-sales" label={t("Expected sales")} /></s-table-header>
            <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-expected-revenue" label={t("Expected revenue")} /></s-table-header>
          </s-table-header-row>
          <s-table-body>
            <s-table-row>
              <s-table-cell>
                <s-text fontWeight="medium">{t("Whole store")}</s-text>
              </s-table-cell>
              <s-table-cell>{formatCount(result.totals.units === null ? null : Math.round(result.totals.units), locale)}</s-table-cell>
              <s-table-cell>{money(result.totals.revenue)}</s-table-cell>
            </s-table-row>
            {result.collections.map((c) => (
              <s-table-row key={c.collectionId}>
                <s-table-cell>{titles[c.collectionId] || "—"}</s-table-cell>
                <s-table-cell>{formatCount(Math.round(c.units), locale)}</s-table-cell>
                <s-table-cell>{money(c.revenue)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-stack>
    </FormCard>
  );
}

// ---------------------------------------------------------------------------
// Collection goals
// ---------------------------------------------------------------------------

function CollectionGoals({ goals, options, currency }: { goals: GoalsData | null; options: { id: string; title: string }[]; currency: string }) {
  const { t, locale } = useLocale();
  const fetcher = useFetcher<PlannerAction>();
  const [collectionId, setCollectionId] = useState("");
  const [pct, setPct] = useState("");
  const result = fetcher.data;
  useEffect(() => {
    if (result?.ok && result.intent === "goal_save") {
      setCollectionId("");
      setPct("");
    }
  }, [result]);
  const post = (body: Record<string, unknown>) => fetcher.submit(body as never, { method: "post", encType: "application/json" });
  const error = result && !result.ok && result.error && result.error !== "limit" && result.error !== "notFound" ? goalErrorText(result.error, t) : undefined;
  const rows = goals?.rows ?? [];
  const range = goals ? periodText(goals.window.from, goals.window.to, t, locale) : "—";
  return (
    <FormCard title={t("Collection goals")}>
      <s-stack direction="block" gap="base">
        <s-paragraph color="subdued">{t("Set the share of revenue you want from a collection, and see which products hold it back.")}</s-paragraph>
        {rows.length > 0 && (
          <>
            {goals!.total > 100 && (
              <s-text color="subdued">
                {fill(t("Your goals add up to {pct}. That's fine: a product can be in several collections, so shares overlap."), {
                  pct: formatPercent(goals!.total / 100, locale),
                })}
              </s-text>
            )}
            <HowWeGotThis
              id="keha-goals-how"
              title={t("Collection goals")}
              lines={[
                t("Actual share = the collection's sales ÷ the whole store's sales. A product in several collections counts in each, so shares can add up to more than 100%."),
                t("Holding it back: products in the collection with the most sales at risk, or sizes out of stock or running low."),
                fill(t("Based on: gross sales in the last 90 days, all sales channels, {range}"), { range }),
              ]}
            />
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary"><HeaderLabel id="keha-ph-collection" label={t("Collection")} /></s-table-header>
                <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-goal" label={t("Goal")} /></s-table-header>
                <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-actual-last-90-days" label={t("Actual")} hint={t("Actual (last 90 days)")} /></s-table-header>
                <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-gap" label={t("Gap")} /></s-table-header>
                <s-table-header><HeaderLabel id="keha-ph-products-holding-it-back" label={t("Products holding it back")} /></s-table-header>
                <s-table-header><HeaderLabel id="keha-ph-manage" label={t("Manage")} /></s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((r) => (
                  <s-table-row key={r.collectionId}>
                    <s-table-cell>{r.title || "—"}</s-table-cell>
                    <s-table-cell>{formatPercent(r.goalPct / 100, locale)}</s-table-cell>
                    <s-table-cell>{formatPercent(r.actualShare, locale)}</s-table-cell>
                    <s-table-cell>
                      {r.gapPts === null
                        ? "—"
                        : r.gapPts > 0
                          ? fill(t("{n} points below"), { n: num2(r.gapPts, locale) })
                          : r.gapPts < 0
                            ? fill(t("{n} points above"), { n: num2(-r.gapPts, locale) })
                            : t("On goal")}
                    </s-table-cell>
                    <s-table-cell>
                      {r.holdingBack.length === 0 ? (
                        "—"
                      ) : (
                        <s-stack direction="block" gap="none">
                          {r.holdingBack.map((p) => (
                            <s-text key={p.productId}>
                              {[
                                p.title,
                                p.atRisk ? fill(t("{amount} at risk"), { amount: formatAmount(p.atRisk, currency, locale) }) : null,
                                p.out ? fill(t("{n} out of stock"), { n: formatCount(p.out, locale) }) : null,
                                p.low ? fill(t("{n} low on stock"), { n: formatCount(p.low, locale) }) : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </s-text>
                          ))}
                        </s-stack>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button variant="tertiary" tone="critical" onClick={() => post({ intent: "goal_delete", collectionId: r.collectionId })}>
                        {t("Remove")}
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </>
        )}
        {options.length === 0 ? (
          <s-paragraph color="subdued">{t("No collections found yet. They appear after the next product sync.")}</s-paragraph>
        ) : (
          <s-stack direction="inline" gap="base" alignItems="end">
            <SelectField
              label={t("Collection")}
              value={collectionId}
              options={[{ value: "", label: t("Pick a collection") }, ...options.map((o) => ({ value: o.id, label: o.title || "—" }))]}
              onChange={setCollectionId}
            />
            <s-number-field
              label={t("Goal share of revenue")}
              value={pct}
              min={0}
              max={100}
              step={1}
              suffix="%"
              error={error}
              onInput={(e) => setPct(val(e))}
            />
            <s-button loading={flag(fetcher.state !== "idle")} onClick={() => post({ intent: "goal_save", collectionId, goalPct: pct })}>
              {t("Save goal")}
            </s-button>
          </s-stack>
        )}
      </s-stack>
    </FormCard>
  );
}

// ---------------------------------------------------------------------------
// Accuracy scorecard
// ---------------------------------------------------------------------------

function monthLabel(month: string, locale: string): string {
  try {
    return new Date(`${month}T12:00:00Z`).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  } catch {
    return month.slice(0, 7);
  }
}

const pct = (v: number | null, locale: string) => (v === null || !Number.isFinite(v) ? "—" : formatPercent(v / 100, locale));

function Scorecard({ data }: { data: ScorecardData | null }) {
  const { t, locale } = useLocale();
  let body: ReactNode;
  if (!data || data.kind === "empty") {
    body = (
      <s-paragraph color="subdued">
        {fill(t("We grade our forecasts on the 1st of each month. Your first scorecard arrives on {date}."), {
          date: formatDay(data?.kind === "empty" ? data.firstDate : null, locale),
        })}
      </s-paragraph>
    );
  } else {
    body = (
      <>
        <s-text color="subdued">{fill(t("Graded month: {month}"), { month: monthLabel(data.month, locale) })}</s-text>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
          <SummaryBox
            id="keha-acc-store"
            title={t("Whole store, error")}
            value={pct(data.storeErrorPct, locale)}
            lines={[
              t("How far our forecast for the store's total units was from what you sold, as a % of what you sold."),
              t("Based on: our forecast on the 1st of the month vs units sold that month, all sales channels"),
            ]}
          />
          <SummaryBox
            id="keha-acc-top"
            title={t("Top 20 products, average error")}
            value={pct(data.top20ErrorPct, locale)}
            sub={fill(t("Graded: {n}"), { n: formatCount(data.graded, locale) })}
            lines={[
              t("The combined error over the 20 variants that sold the most the month before. Variants that sold nothing are graded too."),
              t("Based on: our forecast on the 1st of the month vs units sold that month, all sales channels"),
            ]}
          />
        </s-grid>
        {data.rows.length > 0 && (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary"><HeaderLabel id="keha-ph-product" label={t("Product")} /></s-table-header>
              <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-forecast" label={t("Forecast")} /></s-table-header>
              <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-sold" label={t("Sold")} /></s-table-header>
              <s-table-header listSlot="labeled" format="numeric"><HeaderLabel id="keha-ph-error" label={t("% error")} /></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.rows.map((r) => (
                <s-table-row key={r.variantId}>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text fontWeight="medium">{r.productTitle ?? "—"}</s-text>
                      {r.variantTitle && variantName(r.variantTitle) && <s-text color="subdued">{variantName(r.variantTitle)}</s-text>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{formatCount(Math.round(r.predicted), locale)}</s-table-cell>
                  <s-table-cell>{formatCount(r.actual, locale)}</s-table-cell>
                  <s-table-cell>{pct(r.errorPct, locale)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </>
    );
  }
  return (
    <FormCard title={t("How accurate we were")}>
      <s-stack direction="block" gap="base">
        {body}
      </s-stack>
    </FormCard>
  );
}
