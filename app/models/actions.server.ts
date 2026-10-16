/**
 * Action list (spec §5.1, §7.7) and clearances (spec §4 J5). Database only —
 * no Shopify calls on Home load (spec §15); the one exception, whether Keha
 * Preorder is installed, is passed in as a cached callback and asked only when
 * a visible Bridge row could use it. Mapping lives in app/lib/action-list-shared.ts.
 *
 * Stock values use the online stock pool (active locations that fulfil online
 * orders), the same pool as compute and the Products screen.
 */
import prisma from "../db.server";
import { decimalToNumber } from "./dashboard.server";
import { POOL_LOCATION_SELECT, poolLocationIds } from "../lib/compute-shared";
import { storeLabel, todayIn } from "../lib/dashboard-shared";
import {
  ACTION_FETCH_LIMIT,
  CLEARANCE_LIST_LIMIT,
  DOUBLED_CANDIDATE_WHERE,
  buildActionList,
  doubledIds,
  dueActionWhere,
  mergeVisibleActionRows,
  needsPreorderCheck,
  stateChange,
  type ActionListView,
  type ActionOp,
  type ActionRowIn,
  type ClearanceRowIn,
  type VariantInfo,
} from "../lib/action-list-shared";
import { cashInStock, type ClearValue } from "../lib/clearance-shared";
import type { PlanCode } from "../lib/plan-shared";

type Decimalish = Parameters<typeof decimalToNumber>[0];

const LIVE_STATES = ["open", "snoozed", "dismissed"];

async function poolIds(shop: string): Promise<string[]> {
  const locations = await prisma.location.findMany({ where: { shop }, select: POOL_LOCATION_SELECT });
  return poolLocationIds(locations);
}

/** Cash and units in stock now for these variants (online pool). */
export async function stockValue(
  shop: string,
  variantIds: string[],
  pool?: string[],
): Promise<{ cash: number | null; units: number | null; retail: boolean }> {
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return { cash: null, units: null, retail: false };
  const locs = pool ?? (await poolIds(shop));
  if (locs.length === 0) return { cash: null, units: null, retail: false };
  const [variants, stock] = await Promise.all([
    prisma.variant.findMany({ where: { shop, id: { in: ids } }, select: { id: true, cost: true, price: true } }),
    prisma.stockNow.groupBy({
      by: ["variantId"],
      where: { shop, variantId: { in: ids }, locationId: { in: locs } },
      _sum: { onHand: true },
    }),
  ]);
  const onHand = new Map(stock.map((s) => [s.variantId, s._sum.onHand ?? null]));
  return cashInStock(
    variants.map((v) => ({
      onHand: onHand.get(v.id) ?? null,
      cost: decimalToNumber(v.cost),
      price: decimalToNumber(v.price),
    })),
  );
}

function toRowIn(a: {
  id: string;
  kind: string;
  productId: string;
  variantIds: string[];
  amount: Decimalish;
  currency: string;
  reason: unknown;
  state: string;
  snoozeUntil: Date | null;
  stateAmount: Decimalish;
}): ActionRowIn {
  return {
    id: a.id,
    kind: a.kind,
    productId: a.productId,
    variantIds: a.variantIds,
    amount: decimalToNumber(a.amount) ?? NaN,
    currency: a.currency,
    reason: a.reason,
    state: a.state,
    snoozeUntil: a.snoozeUntil,
    stateAmount: decimalToNumber(a.stateAmount),
  };
}

/**
 * Home's action list. `preorderInstalled` is only called when the plan has
 * the bridge and a Bridge row is visible.
 */
export async function getActionList(
  shop: string,
  plan: PlanCode,
  now: Date,
  opts: { preorderInstalled?: () => Promise<boolean> } = {},
): Promise<ActionListView | null> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { currency: true, timezone: true } });
  if (!row) return null;
  // Only rows that can show (review fix): dismissed rows never fill the fetch limit.
  const [dueRows, candidates, clearanceRows, pool] = await Promise.all([
    prisma.action.findMany({
      where: { shop, ...dueActionWhere(now) },
      orderBy: [{ amount: "desc" }, { id: "asc" }],
      take: ACTION_FETCH_LIMIT,
    }),
    prisma.action.findMany({
      where: { shop, ...DOUBLED_CANDIDATE_WHERE },
      select: { id: true, state: true, amount: true, stateAmount: true, snoozeUntil: true },
    }),
    prisma.clearance.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: CLEARANCE_LIST_LIMIT }),
    poolIds(shop),
  ]);
  const backIds = doubledIds(
    candidates.map((c) => ({ ...c, amount: decimalToNumber(c.amount) ?? NaN, stateAmount: decimalToNumber(c.stateAmount) })),
    now,
  );
  const doubledRows = backIds.length ? await prisma.action.findMany({ where: { shop, id: { in: backIds } } }) : [];
  const actions = mergeVisibleActionRows(dueRows.map(toRowIn), doubledRows.map(toRowIn), now);
  const productIds = [...new Set([...actions.map((a) => a.productId), ...clearanceRows.flatMap((c) => c.productIds)])];
  const variants: VariantInfo[] = productIds.length
    ? await prisma.variant.findMany({
        where: { shop, productId: { in: productIds } },
        select: { id: true, productId: true, productTitle: true, variantTitle: true, image: true },
        orderBy: [{ productId: "asc" }, { id: "asc" }],
      })
    : [];
  const titles = new Map(variants.map((v) => [v.productId, v.productTitle]));

  const clearances: ClearanceRowIn[] = await Promise.all(
    clearanceRows.map(async (c) => {
      const now_ = await stockValue(shop, c.variantIds, pool);
      return {
        id: c.id,
        kind: c.kind,
        code: c.code,
        percent: c.percent,
        productIds: c.productIds,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        baselineCash: decimalToNumber(c.baselineCash),
        currency: c.currency,
        currentCash: now_.cash,
        retail: now_.retail,
        productTitle: titles.get(c.productIds[0] ?? "") ?? null,
      };
    }),
  );

  let preorderInstalled = false;
  if (opts.preorderInstalled && needsPreorderCheck(actions, plan, now)) {
    try {
      preorderInstalled = await opts.preorderInstalled();
    } catch {
      preorderInstalled = false;
    }
  }

  return buildActionList({
    actions,
    variants,
    clearances,
    plan,
    now,
    today: todayIn(row.timezone, now),
    storeHandle: storeLabel(shop),
    preorderInstalled,
    currency: row.currency,
  });
}

/** Snooze / dismiss / done / undo one of this shop's actions. Null when it isn't this shop's. */
export async function updateActionState(shop: string, id: string, op: ActionOp, now: Date): Promise<{ id: string; state: string } | null> {
  const found = await prisma.action.findFirst({ where: { id, shop }, select: { id: true, amount: true } });
  if (!found) return null;
  const change = stateChange(op, decimalToNumber(found.amount) ?? 0, now);
  await prisma.action.update({ where: { id: found.id }, data: change });
  return { id: found.id, state: change.state };
}

export type ClearTarget = {
  id: string;
  productId: string;
  variantIds: string[];
  currency: string;
  timezone: string | null;
  /** The action's state before the claim (put back if Shopify refuses). */
  prev: { state: string; snoozeUntil: Date | null; stateAmount: unknown; doneAt: Date | null };
};

/** The Clear action to discount: this shop's, kind "clear", not done yet. */
export async function getClearTarget(shop: string, id: string): Promise<ClearTarget | null> {
  const [a, s] = await Promise.all([
    prisma.action.findFirst({
      where: { id, shop, kind: "clear", state: { in: LIVE_STATES } },
      select: { id: true, productId: true, variantIds: true, currency: true, state: true, snoozeUntil: true, stateAmount: true, doneAt: true },
    }),
    prisma.shop.findUnique({ where: { domain: shop }, select: { timezone: true, currency: true } }),
  ]);
  if (!a) return null;
  const { state, snoozeUntil, stateAmount, doneAt, ...rest } = a;
  return {
    ...rest,
    currency: a.currency || s?.currency || "USD",
    timezone: s?.timezone ?? null,
    prev: { state, snoozeUntil: snoozeUntil ?? null, stateAmount: stateAmount ?? null, doneAt: doneAt ?? null },
  };
}

/**
 * Claims the Clear action BEFORE Shopify is asked for a discount (review fix
 * 2026-10-17): a conditional update from a live state to "done" that only one
 * request can win, so a double submit can't create two discounts. false =
 * another request (or tab) already took it.
 */
export async function claimClearAction(shop: string, id: string, now: Date): Promise<boolean> {
  const r = await prisma.action.updateMany({
    where: { id, shop, kind: "clear", state: { in: LIVE_STATES } },
    data: { state: "done", snoozeUntil: null, stateAmount: null, doneAt: now },
  });
  return r.count === 1;
}

/** Shopify refused or failed: the action goes back to the state it had (only if it is still this claim). */
export async function releaseClearAction(shop: string, target: ClearTarget, now: Date): Promise<void> {
  await prisma.action.updateMany({
    where: { id: target.id, shop, state: "done", doneAt: now },
    data: {
      state: target.prev.state,
      snoozeUntil: target.prev.snoozeUntil,
      stateAmount: target.prev.stateAmount as never,
      doneAt: target.prev.doneAt,
    },
  });
}

/**
 * After Shopify created the discount: record the Clearance with its baseline
 * (cash and units in those variants now) and mark the action done, together.
 * A baseline that can't be computed is stored as 0 and shown as "—".
 */
export async function recordClearance(
  shop: string,
  target: ClearTarget,
  value: ClearValue,
  discount: { id: string; startsAt: Date; endsAt: Date | null },
  now: Date,
): Promise<string> {
  const baseline = await stockValue(shop, target.variantIds);
  const [created] = await prisma.$transaction([
    prisma.clearance.create({
      data: {
        shop,
        actionId: target.id,
        discountId: discount.id,
        kind: value.kind,
        code: value.code,
        percent: value.percent,
        productIds: [target.productId],
        variantIds: target.variantIds,
        startsAt: discount.startsAt,
        endsAt: discount.endsAt,
        baselineCash: baseline.cash ?? 0,
        baselineUnits: baseline.units ?? 0,
        currency: target.currency,
      },
      select: { id: true },
    }),
    prisma.action.update({ where: { id: target.id }, data: stateChange("done", 0, now) }),
  ]);
  return created.id;
}
