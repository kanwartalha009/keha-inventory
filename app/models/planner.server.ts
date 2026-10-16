/**
 * Planner page data and writes (spec §5.4, J6, §7.8; task 2.5). Database only; the store is
 * never changed. Plan rules (lib/plan-shared): the page is Growth (`planner`); Growth keeps 1
 * scenario, Pro unlimited (SCENARIO_LIMIT, canAddScenario — checked here, on the server, on
 * every create). Editing, recalculating and deleting are always allowed, so a store that
 * downgraded keeps and can still use the scenarios it has (a downgrade never switches off
 * something already there). Collection goals (`collectionGoals`) and the accuracy scorecard
 * (`accuracy`) are Growth too.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { canAddScenario, SCENARIO_LIMIT, type PlanCode } from "../lib/plan-shared";
import {
  GOAL_WINDOW_DAYS,
  firstScorecardDate,
  goalRows,
  goalsTotal,
  hasSeasonHistory,
  newScenarioForm,
  readScenarioResult,
  scenarioToForm,
  scorecardRows,
  validateGoal,
  type GoalErrorCode,
  type GoalRow,
  type ScenarioForm,
  type ScenarioInput,
  type ScenarioResult,
  type ScorecardRow,
} from "../lib/planner-shared";
import { jsonSafe } from "../lib/compute-shared";
import { METRIC_SCOPE } from "../lib/products-shared";
import { addDays } from "../lib/engine/dates-shared";
import { rankingWindow } from "../lib/engine/accuracy-shared";
import { ALL, dayDate } from "../lib/sync/facts-shared";
import { computeScenarioFor, plannerShop, type PlannerShop } from "../services/planner.server";

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const at = (day: string) => new Date(`${day}T00:00:00Z`);

export type ScenarioView = {
  id: string;
  name: string;
  event: string;
  start: string;
  end: string;
  targetType: string;
  targetValue: number;
  /** When the stored result was calculated; null = no (current-version) result yet. */
  computedAt: string | null;
};

type ScenarioRow = {
  id: string;
  name: string;
  event: string;
  start: Date;
  end: Date;
  targetType: string;
  targetValue: unknown;
  result: unknown;
};

function toView(s: ScenarioRow): ScenarioView & { result: ScenarioResult | null } {
  const result = readScenarioResult(s.result);
  return {
    id: s.id,
    name: s.name,
    event: s.event,
    start: dayOf(s.start),
    end: dayOf(s.end),
    targetType: s.targetType,
    targetValue: num(s.targetValue),
    computedAt: result?.computedAt ?? null,
    result,
  };
}

const SCENARIO_SELECT = { id: true, name: true, event: true, start: true, end: true, targetType: true, targetValue: true, result: true } as const;

export async function listScenarios(shop: string): Promise<(ScenarioView & { result: ScenarioResult | null })[]> {
  const rows = await prisma.scenario.findMany({ where: { shop }, select: SCENARIO_SELECT, orderBy: [{ start: "asc" }, { createdAt: "asc" }] });
  return rows.map(toView);
}

export type ScenarioWrite = { ok: true; id: string } | { ok: false; error: "limit" | "notFound" };

const resultJson = (r: ScenarioResult) => jsonSafe(r) as Prisma.InputJsonValue;

/** Create (checked against the plan's scenario limit) and calculate. */
export async function createScenario(shop: string, plan: PlanCode, input: ScenarioInput, now: Date = new Date()): Promise<ScenarioWrite> {
  const existing = await prisma.scenario.count({ where: { shop } });
  if (!canAddScenario(plan, existing)) return { ok: false, error: "limit" };
  const result = await computeScenarioFor(shop, input, now);
  const row = await prisma.scenario.create({
    data: {
      shop,
      name: input.name,
      event: input.event,
      start: at(input.start),
      end: at(input.end),
      targetType: input.targetType,
      targetValue: input.targetValue,
      result: resultJson(result),
    },
    select: { id: true },
  });
  return { ok: true, id: row.id };
}

/** Edit and recalculate. */
export async function updateScenario(shop: string, id: string, input: ScenarioInput, now: Date = new Date()): Promise<ScenarioWrite> {
  const found = await prisma.scenario.findFirst({ where: { id, shop }, select: { id: true } });
  if (!found) return { ok: false, error: "notFound" };
  const result = await computeScenarioFor(shop, input, now);
  const r = await prisma.scenario.updateMany({
    where: { id, shop },
    data: {
      name: input.name,
      event: input.event,
      start: at(input.start),
      end: at(input.end),
      targetType: input.targetType,
      targetValue: input.targetValue,
      result: resultJson(result),
    },
  });
  return r.count === 1 ? { ok: true, id } : { ok: false, error: "notFound" };
}

/** "Recalculate": the same scenario on today's data. */
export async function recalculateScenario(shop: string, id: string, now: Date = new Date()): Promise<ScenarioWrite> {
  const s = await prisma.scenario.findFirst({ where: { id, shop }, select: SCENARIO_SELECT });
  if (!s) return { ok: false, error: "notFound" };
  const v = toView(s);
  const result = await computeScenarioFor(
    shop,
    { start: v.start, end: v.end, targetType: scenarioToForm(v).targetType, targetValue: v.targetValue },
    now,
  );
  const r = await prisma.scenario.updateMany({ where: { id, shop }, data: { result: resultJson(result) } });
  return r.count === 1 ? { ok: true, id } : { ok: false, error: "notFound" };
}

export async function deleteScenario(shop: string, id: string): Promise<boolean> {
  return (await prisma.scenario.deleteMany({ where: { id, shop } })).count === 1;
}

// ---------------------------------------------------------------------------
// Collection goals
// ---------------------------------------------------------------------------

export type GoalsData = {
  rows: GoalRow[];
  total: number;
  window: { from: string; to: string };
};

export async function collectionOptions(shop: string): Promise<{ id: string; title: string }[]> {
  const rows = await prisma.collection.findMany({ where: { shop }, select: { id: true, title: true, handle: true } });
  return rows
    .map((c) => ({ id: c.id, title: c.title || c.handle || "" }))
    .sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1))
    .slice(0, 1000);
}

export async function loadGoals(shop: string, ctx: Pick<PlannerShop, "today" | "coverage">): Promise<GoalsData> {
  const to = addDays(ctx.today, -1);
  const from = addDays(ctx.today, -GOAL_WINDOW_DAYS);
  const goals = await prisma.collectionGoal.findMany({ where: { shop }, select: { collectionId: true, goalPct: true } });
  if (!goals.length) return { rows: [], total: 0, window: { from, to } };
  const [collections, variants, revenueG, metrics, actions] = await Promise.all([
    prisma.collection.findMany({ where: { shop, id: { in: goals.map((g) => g.collectionId) } }, select: { id: true, title: true, handle: true } }),
    prisma.variant.findMany({ where: { shop }, select: { id: true, productId: true, productTitle: true, collections: true } }),
    prisma.salesDaily.groupBy({
      by: ["variantId"],
      where: { shop, locationKey: ALL, day: { gte: dayDate(from), lte: dayDate(to) } },
      _sum: { gross: true },
    }),
    prisma.variantMetric.findMany({ where: { shop, scope: METRIC_SCOPE }, select: { variantId: true, status: true } }),
    prisma.action.findMany({ where: { shop, state: "open", kind: { in: ["reorder", "bridge"] } }, select: { productId: true, amount: true } }),
  ]);
  const revenue = new Map(revenueG.map((g) => [g.variantId, num(g._sum.gross)]));
  const store = [...revenue.values()].reduce((a, b) => a + b, 0);
  const atRisk = new Map<string, number>();
  for (const a of actions) atRisk.set(a.productId, (atRisk.get(a.productId) ?? 0) + num(a.amount));
  const sorted = [...goals].sort((a, b) => b.goalPct - a.goalPct || (a.collectionId < b.collectionId ? -1 : 1));
  return {
    rows: goalRows({
      goals: sorted,
      titles: new Map(collections.map((c) => [c.id, c.title || c.handle])),
      variants: variants.map((v) => ({ ...v, collections: v.collections ?? [] })),
      revenue,
      storeRevenue: ctx.coverage.to && revenueG.length && store > 0 ? store : null,
      status: new Map(metrics.map((m) => [m.variantId, m.status])),
      atRisk,
    }),
    total: goalsTotal(goals),
    window: { from, to },
  };
}

export type GoalWrite = { ok: true } | { ok: false; error: GoalErrorCode };

export async function saveGoal(shop: string, raw: { collectionId: unknown; goalPct: unknown }): Promise<GoalWrite> {
  const id = typeof raw.collectionId === "string" ? raw.collectionId : "";
  const [known, existing] = await Promise.all([
    id ? prisma.collection.findMany({ where: { shop, id }, select: { id: true } }) : Promise.resolve([]),
    prisma.collectionGoal.findMany({ where: { shop }, select: { collectionId: true } }),
  ]);
  const v = validateGoal(raw, { collectionIds: new Set(known.map((k) => k.id)), existing: existing.map((e) => e.collectionId) });
  if (!v.ok) return v;
  await prisma.collectionGoal.upsert({
    where: { shop_collectionId: { shop, collectionId: v.collectionId } },
    create: { shop, collectionId: v.collectionId, goalPct: v.goalPct },
    update: { goalPct: v.goalPct },
  });
  return { ok: true };
}

export async function deleteGoal(shop: string, collectionId: string): Promise<boolean> {
  return (await prisma.collectionGoal.deleteMany({ where: { shop, collectionId } })).count === 1;
}

// ---------------------------------------------------------------------------
// Accuracy scorecard
// ---------------------------------------------------------------------------

export type ScorecardData =
  | {
      kind: "graded";
      month: string;
      storeErrorPct: number | null;
      top20ErrorPct: number | null;
      graded: number;
      rows: ScorecardRow[];
    }
  | { kind: "empty"; firstDate: string };

export async function loadScorecard(shop: string, today: string): Promise<ScorecardData> {
  const latest = await prisma.accuracyMonth.findFirst({ where: { shop }, orderBy: { month: "desc" } });
  if (!latest) {
    const first = await prisma.forecastSnapshot.findFirst({ where: { shop }, orderBy: { month: "asc" }, select: { month: true } });
    return { kind: "empty", firstDate: firstScorecardDate(today, first ? dayOf(first.month) : null) };
  }
  const month = dayOf(latest.month);
  const [snapshot, revenueG] = await Promise.all([
    prisma.forecastSnapshot.findMany({ where: { shop, month: dayDate(month) }, select: { variantId: true, predicted: true, actual: true } }),
    prisma.salesDaily.groupBy({
      by: ["variantId"],
      // The ranking the accuracy job graded with: the month before (rankingWindow, no look-ahead).
      where: { shop, locationKey: ALL, day: { gte: dayDate(rankingWindow(month).from), lte: dayDate(rankingWindow(month).to) } },
      _sum: { gross: true },
    }),
  ]);
  const revenue = new Map(revenueG.map((g) => [g.variantId, num(g._sum.gross)]));
  const top = scorecardRows(snapshot, revenue, new Map());
  const variants = top.length
    ? await prisma.variant.findMany({ where: { shop, id: { in: top.map((r) => r.variantId) } }, select: { id: true, productTitle: true, variantTitle: true } })
    : [];
  const titles = new Map(variants.map((v) => [v.id, { productTitle: v.productTitle, variantTitle: v.variantTitle }]));
  return {
    kind: "graded",
    month,
    storeErrorPct: latest.storeErrorPct,
    top20ErrorPct: latest.top20ErrorPct,
    graded: latest.graded,
    rows: scorecardRows(snapshot, revenue, titles),
  };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export type PlannerData = {
  enabled: boolean;
  plan: PlanCode;
  features: { collectionGoals: boolean; accuracy: boolean };
  today: string;
  /** Store time zone (IANA). */
  timezone: string;
  currency: string;
  history: { enough: boolean; from: string | null };
  scenarios: ScenarioView[];
  selected: (ScenarioView & { result: ScenarioResult | null }) | null;
  canAdd: boolean;
  limit: number | null;
  editing: { id: string | null; form: ScenarioForm } | null;
  /** Titles of the collections the page shows (selected result + goals). */
  collectionTitles: Record<string, string>;
  collectionOptions: { id: string; title: string }[];
  goals: GoalsData | null;
  scorecard: ScorecardData | null;
};

export async function loadPlanner(
  shop: string,
  opts: {
    plan: PlanCode;
    features: { collectionGoals: boolean; accuracy: boolean };
    selectedId: string | null;
    edit: string | null;
    now?: Date;
  },
): Promise<PlannerData> {
  const ctx = await plannerShop(shop, opts.now ?? new Date());
  const [all, options, goals, scorecard] = await Promise.all([
    listScenarios(shop),
    opts.features.collectionGoals ? collectionOptions(shop) : Promise.resolve([]),
    opts.features.collectionGoals ? loadGoals(shop, ctx) : Promise.resolve(null),
    opts.features.accuracy ? loadScorecard(shop, ctx.today) : Promise.resolve(null),
  ]);
  const selected = all.find((s) => s.id === opts.selectedId) ?? all[0] ?? null;
  const canAdd = canAddScenario(opts.plan, all.length);
  let editing: PlannerData["editing"] = null;
  if (opts.edit === "new" && canAdd) editing = { id: null, form: newScenarioForm(ctx.today) };
  else if (opts.edit) {
    const s = all.find((x) => x.id === opts.edit);
    if (s) editing = { id: s.id, form: scenarioToForm(s) };
  }
  const titles: Record<string, string> = {};
  for (const o of options) titles[o.id] = o.title;
  const needed = (selected?.result?.collections ?? []).map((c) => c.collectionId).filter((id) => !(id in titles));
  if (needed.length) {
    const rows = await prisma.collection.findMany({ where: { shop, id: { in: needed } }, select: { id: true, title: true, handle: true } });
    for (const r of rows) titles[r.id] = r.title || r.handle;
  }
  return {
    enabled: true,
    plan: opts.plan,
    features: opts.features,
    today: ctx.today,
    timezone: ctx.timezone,
    currency: ctx.currency,
    history: { enough: hasSeasonHistory(ctx.coverage, ctx.today), from: ctx.coverage.from },
    scenarios: all.map(({ result: _r, ...v }) => v),
    selected,
    canAdd,
    limit: SCENARIO_LIMIT[opts.plan],
    editing,
    collectionTitles: titles,
    collectionOptions: options,
    goals,
    scorecard,
  };
}
