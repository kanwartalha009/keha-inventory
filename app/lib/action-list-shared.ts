/**
 * Home "This week's actions" (spec §5.1, §7.7, §4 J4): pure mapping from the
 * Action rows the loader reads to the list Home shows, the button each kind
 * gets, the plan limits (spec §3) and the snooze / dismiss / done / undo state
 * changes. Client-safe, no clock access (callers pass `now` / `today`).
 *
 * Plan rules (spec §3, §2.6 "locks teach, they don't hide"):
 *  - Free sees the top ACTION_LIST_LIMIT rows (`visibleRows`).
 *  - Fix rows need `fixDetails`; on Free they are held back on the server and
 *    shown only as a count.
 *  - Bridge and Clear need `bridge` / `clearance`; on Free the row stays with a
 *    locked button and an Upgrade link, and no bridge link is built.
 *
 * Keha Preorder (Shopify rule 2.2.6): the preorder link is built only when the
 * store has Keha Preorder installed; otherwise the bridge button is the
 * back-in-stock how-to and the other app is never named.
 */
import {
  ACTION_KINDS,
  ACTION_TABS,
  SNOOZE_DAYS,
  isVisible,
  rankActions,
  tabOf,
  type ActionKind,
  type ActionState,
  type ActionTab,
  type ReasonParams,
} from "./actions-shared";
import { hasFeature, visibleRows, type PlanCode } from "./plan-shared";
import { cashFreed, type ClearanceKind } from "./clearance-shared";

/** Keha Preorder's app handle (its shopify.app.toml `handle`). */
export const KEHA_PREORDER_HANDLE = "keha-preorder";
/** Keha Preorder's new-preorder form reads at most 50 variants. */
export const BRIDGE_MAX_VARIANTS = 50;
/** Keha Preorder caps the preorder name at 120 characters. */
export const BRIDGE_NAME_MAX = 120;
/**
 * ASSUMPTION: Home reads at most this many action rows (largest € first). A
 * 5,000-variant store has at most one row per (kind, product), and rows below
 * the top 500 by € are not what a merchant acts on this week.
 */
export const ACTION_FETCH_LIMIT = 500;
/**
 * Home's read (review fix: dismissed rows used to fill the 500): (1) rows visible by state
 * alone — open, or snoozed with the snooze date passed — largest € first, at most
 * ACTION_FETCH_LIMIT; (2) snoozed / dismissed rows that came back because their € figure
 * doubled. Prisma can't compare amount with 2 × stateAmount, so (2) reads only id / amount /
 * stateAmount / state / snoozeUntil of the candidates (`DOUBLED_CANDIDATE_WHERE`), keeps the
 * doubled ones (`doubledIds`, at most ACTION_FETCH_LIMIT) and loads those rows by id.
 * `mergeVisibleActionRows` joins (1) and (2).
 */
/** Prisma `where` for query (1): visible by state alone at `now`. */
export function dueActionWhere(now: Date) {
  return { OR: [{ state: "open" }, { state: "snoozed", snoozeUntil: { lte: now } }] };
}

/** Prisma `where` for query (2): snoozed / dismissed rows with a recorded figure (may have doubled). */
export const DOUBLED_CANDIDATE_WHERE = { state: { in: ["snoozed", "dismissed"] }, stateAmount: { gt: 0 } };

/** Ids of candidate rows whose € figure doubled (visible now), largest € first, at most `limit`. */
export function doubledIds(
  rows: readonly Pick<ActionRowIn, "id" | "state" | "amount" | "stateAmount" | "snoozeUntil">[],
  now: Date,
  limit = ACTION_FETCH_LIMIT,
): string[] {
  return rows
    .filter((r) => r.state !== "open" && Number.isFinite(r.amount) && isVisible(asVisible(r), now))
    .sort((a, b) => b.amount - a.amount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit)
    .map((r) => r.id);
}

/** Joins the two reads: visible rows only, each once, largest € first, at most `limit`. */
export function mergeVisibleActionRows<T extends Pick<ActionRowIn, "id" | "state" | "amount" | "stateAmount" | "snoozeUntil">>(
  due: readonly T[],
  doubled: readonly T[],
  now: Date,
  limit = ACTION_FETCH_LIMIT,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of [...due, ...doubled]) {
    if (seen.has(r.id) || !isVisible(asVisible(r), now)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out
    .sort((a, b) => (Number.isFinite(b.amount) ? b.amount : -Infinity) - (Number.isFinite(a.amount) ? a.amount : -Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit);
}

/** Rows shown per tab before "Show more" (disclosure, nothing is dropped). */
export const TAB_PAGE_SIZE = 25;
/** Variant names listed on a row before "+N more". */
export const ROW_VARIANT_NAMES = 3;
/** Clearances listed under "Clearances running". */
export const CLEARANCE_LIST_LIMIT = 20;

export function isActionKind(v: unknown): v is ActionKind {
  return typeof v === "string" && (ACTION_KINDS as readonly string[]).includes(v);
}

export function isActionTab(v: unknown): v is ActionTab {
  return typeof v === "string" && (ACTION_TABS as readonly string[]).includes(v);
}

/** `?tab=` from the URL (the Monday email deep-links with it); anything else → "all". */
export function parseTab(v: string | null | undefined): ActionTab {
  const x = (v ?? "").trim().toLowerCase();
  return isActionTab(x) ? x : "all";
}

// ── Ids and links ───────────────────────────────────────────────────────────

/** The numeric id of a Shopify gid or a bare numeric id; null for anything else. */
export function numericId(idOrGid: string | null | undefined): string | null {
  const s = String(idOrGid ?? "").trim();
  if (/^\d{1,20}$/.test(s)) return s;
  const m = /^gid:\/\/shopify\/[A-Za-z]+\/(\d{1,20})(\?.*)?$/.exec(s);
  return m ? m[1]! : null;
}

/** A product variant gid from a gid or numeric id; null when it is neither. */
export function variantGidOf(idOrGid: string): string | null {
  const s = idOrGid.trim();
  if (/^gid:\/\/shopify\/ProductVariant\/\d{1,20}$/.test(s)) return s;
  return /^\d{1,20}$/.test(s) ? `gid://shopify/ProductVariant/${s}` : null;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day "YYYY-MM-DD". */
export function isDay(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = DAY_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** "YYYY-MM-DD" + n days. */
export function addDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Collapse whitespace and cut to `max` characters (by code point). */
export function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  const cps = Array.from(one);
  return cps.length <= max ? one : cps.slice(0, max).join("").trim();
}

/**
 * Keha Preorder's new-preorder form, pre-filled (spec §4 J4). Keha Preorder
 * parses exactly: variants (numeric ids or gids, comma-separated, ≤ 50),
 * trigger (always | stock), ship (YYYY-MM-DD), name (≤ 120), payment.
 * Opened top-level in the admin. Null when no variant id is usable.
 * `ship` is left out when the arrival date is unknown or already past.
 */
export function bridgeUrl(input: {
  storeHandle: string;
  variantIds: readonly string[];
  arrival: string | null | undefined;
  today: string;
  name: string;
}): string | null {
  const ids: string[] = [];
  for (const v of input.variantIds) {
    const n = numericId(v);
    if (n && !ids.includes(n)) ids.push(n);
    if (ids.length >= BRIDGE_MAX_VARIANTS) break;
  }
  const store = input.storeHandle.trim();
  if (ids.length === 0 || !store) return null;
  const qs = new URLSearchParams();
  qs.set("variants", ids.join(","));
  qs.set("trigger", "stock");
  if (isDay(input.arrival) && (!isDay(input.today) || input.arrival >= input.today)) qs.set("ship", input.arrival);
  const name = clip(input.name, BRIDGE_NAME_MAX);
  if (name) qs.set("name", name);
  return `https://admin.shopify.com/store/${encodeURIComponent(store)}/apps/${KEHA_PREORDER_HANDLE}/app/campaigns/new?${qs.toString()}`;
}

/** The Reorder screen with these variants pre-selected (`?variants=<gids>`). */
export function reorderHref(variantIds: readonly string[]): string {
  const gids = [...new Set(variantIds.map(variantGidOf).filter((g): g is string => !!g))];
  if (gids.length === 0) return "/app/reorder";
  return `/app/reorder?${new URLSearchParams({ variants: gids.join(",") }).toString()}`;
}

/** The product in Shopify admin (opened top-level). */
export function adminProductUrl(productId: string): string {
  const n = numericId(productId);
  return n ? `shopify://admin/products/${n}` : "shopify://admin/products";
}

/** Our Products detail page for a variant. */
export function variantDetailHref(variantId: string | undefined): string {
  const n = variantId ? numericId(variantId) : null;
  return n ? `/app/products/${n}` : "/app/products";
}

// ── Reason ──────────────────────────────────────────────────────────────────

export type FactValue = string | number | null;
export type ActionReason = { key: string; params: ReasonParams; facts: { label: string; value: FactValue }[] };

const scalar = (v: unknown): v is string | number => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** Action.reason JSON, read defensively. */
export function readReason(raw: unknown): ActionReason {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const params: ReasonParams = {};
  if (r.params && typeof r.params === "object") {
    for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) if (scalar(v)) params[k] = v;
  }
  const facts: { label: string; value: FactValue }[] = [];
  if (r.facts && typeof r.facts === "object") {
    for (const [k, v] of Object.entries(r.facts as Record<string, unknown>)) {
      if (scalar(v) || v === null) facts.push({ label: k, value: v });
    }
  }
  return { key: typeof r.key === "string" ? r.key : "", params, facts };
}

/**
 * The expected arrival day ("YYYY-MM-DD") of a bridge action. The engine
 * (engine/actions-rules-shared.ts) writes it as `reason.facts.arrival`;
 * `arrivalDate` is also accepted. Without it the preorder form opens without
 * a ship date.
 */
export function arrivalOf(raw: unknown): string | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const part of [r.facts, r.params]) {
    if (part && typeof part === "object") {
      const x = part as Record<string, unknown>;
      for (const v of [x.arrival, x.arrivalDate]) if (isDay(v)) return v;
    }
  }
  return null;
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** An Action row as the model reads it (amounts already numbers). */
export type ActionRowIn = {
  id: string;
  kind: string;
  productId: string;
  variantIds: string[];
  amount: number;
  currency: string;
  reason: unknown;
  state: string;
  snoozeUntil: Date | null;
  stateAmount: number | null;
};

export type VariantInfo = {
  id: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  image: string | null;
};

export type ActionButton =
  | { kind: "reorder"; href: string }
  | { kind: "preorder"; href: string }
  | { kind: "signups"; productUrl: string; arrival: string | null }
  | { kind: "pushHow"; productUrl: string }
  | { kind: "seeWhy"; href: string }
  | { kind: "restockSizes"; href: string }
  | { kind: "checkPage"; productUrl: string }
  | { kind: "checkSizing"; productUrl: string }
  | { kind: "createDiscount" }
  | { kind: "locked"; feature: "bridge" | "clearance" };

export type ActionRowView = {
  id: string;
  kind: ActionKind;
  tab: Exclude<ActionTab, "all">;
  productId: string;
  /** null when the product is no longer in the catalog → "—". */
  productTitle: string | null;
  image: string | null;
  /** Variant names (no "Default Title"), at most ROW_VARIANT_NAMES. */
  variants: string[];
  /** Named variants beyond `variants`. */
  moreVariants: number;
  amount: number;
  currency: string;
  reason: ActionReason;
  button: ActionButton;
};

export type ClearanceRowIn = {
  id: string;
  kind: string;
  code: string | null;
  percent: number;
  productIds: string[];
  startsAt: Date | string;
  endsAt: Date | string | null;
  baselineCash: number | null;
  currency: string;
  /** Cash in those variants now (null = not computable). */
  currentCash: number | null;
  /** Some variant is valued at retail price (no cost). */
  retail: boolean;
  productTitle: string | null;
};

export type ClearanceView = {
  id: string;
  kind: ClearanceKind;
  code: string | null;
  percent: number;
  productTitle: string | null;
  endsOn: string | null;
  /** null → "—". Never negative. */
  cashFreed: number | null;
  retail: boolean;
  currency: string;
};

export type ActionListView = {
  currency: string;
  /** Ranked (by € across groups), already limited to what the plan shows. */
  rows: ActionRowView[];
  /** Rows per tab ("fix" on Free = the held-back count). */
  counts: Record<ActionTab, number>;
  /** Free: ranked rows beyond the top-10 limit (not sent to the browser). */
  hiddenCount: number;
  /** Free: the money those hidden rows are worth (their € figures summed, on the server); null when none. */
  hiddenAmount: number | null;
  /** Free: Fix rows shown only as a count (not sent to the browser). */
  fixCount: number;
  /** Clearances still running (end date not passed). */
  clearances: ClearanceView[];
};

const dayOf = (v: Date | string | null): string | null =>
  v === null ? null : typeof v === "string" ? v.slice(0, 10) : Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : null;

/** The button a row gets (spec §7.7), given the plan and Keha Preorder. */
export function buttonFor(
  row: Pick<ActionRowIn, "kind" | "productId" | "variantIds" | "reason">,
  ctx: { plan: PlanCode; preorderInstalled: boolean; storeHandle: string; today: string; productTitle: string | null },
): ActionButton {
  const kind = row.kind as ActionKind;
  const productUrl = adminProductUrl(row.productId);
  switch (kind) {
    case "reorder":
      return { kind: "reorder", href: reorderHref(row.variantIds) };
    case "bridge": {
      if (!hasFeature(ctx.plan, "bridge")) return { kind: "locked", feature: "bridge" };
      const arrival = arrivalOf(row.reason);
      if (ctx.preorderInstalled) {
        const href = bridgeUrl({
          storeHandle: ctx.storeHandle,
          variantIds: row.variantIds,
          arrival,
          today: ctx.today,
          name: ctx.productTitle ?? "",
        });
        if (href) return { kind: "preorder", href };
      }
      return { kind: "signups", productUrl, arrival };
    }
    case "push":
      return { kind: "pushHow", productUrl };
    case "fix_falling":
      return { kind: "seeWhy", href: variantDetailHref(row.variantIds[0]) };
    case "fix_sizes":
      return { kind: "restockSizes", href: reorderHref(row.variantIds) };
    case "fix_page":
      return { kind: "checkPage", productUrl };
    case "fix_returns":
      return { kind: "checkSizing", productUrl };
    case "clear":
      return hasFeature(ctx.plan, "clearance") ? { kind: "createDiscount" } : { kind: "locked", feature: "clearance" };
  }
}

/** Does this list need to know whether Keha Preorder is installed? */
export function needsPreorderCheck(actions: readonly Pick<ActionRowIn, "kind" | "state" | "amount" | "stateAmount" | "snoozeUntil">[], plan: PlanCode, now: Date): boolean {
  if (!hasFeature(plan, "bridge")) return false;
  return actions.some((a) => a.kind === "bridge" && isVisible(asVisible(a), now));
}

function asVisible(a: Pick<ActionRowIn, "state" | "amount" | "stateAmount" | "snoozeUntil">) {
  const state = (["open", "snoozed", "dismissed", "done"] as const).includes(a.state as ActionState) ? (a.state as ActionState) : "done";
  return { state, amount: a.amount, stateAmount: a.stateAmount, snoozeUntil: a.snoozeUntil };
}

const isFix = (k: ActionKind) => tabOf(k) === "fix";

/** Everything the action list shows, from the database rows. */
export function buildActionList(input: {
  actions: readonly ActionRowIn[];
  variants: readonly VariantInfo[];
  clearances: readonly ClearanceRowIn[];
  plan: PlanCode;
  now: Date;
  today: string;
  storeHandle: string;
  preorderInstalled: boolean;
  currency: string;
}): ActionListView {
  const byVariant = new Map(input.variants.map((v) => [v.id, v]));
  const byProduct = new Map<string, VariantInfo[]>();
  for (const v of input.variants) byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), v]);

  const visible = input.actions.filter(
    (a): a is ActionRowIn & { kind: ActionKind } => isActionKind(a.kind) && Number.isFinite(a.amount) && isVisible(asVisible(a), input.now),
  );
  const ranked = rankActions(visible);
  const fixAllowed = hasFeature(input.plan, "fixDetails");
  const detailed = fixAllowed ? ranked : ranked.filter((a) => !isFix(a.kind));
  const shown = visibleRows(input.plan, detailed);

  const rows: ActionRowView[] = shown.map((a) => {
    const productVariants = byProduct.get(a.productId) ?? [];
    const own = a.variantIds.map((id) => byVariant.get(id)).filter((v): v is VariantInfo => !!v);
    const first = own[0] ?? productVariants[0] ?? null;
    const names = own.map((v) => v.variantTitle.trim()).filter((n) => n && n !== "Default Title");
    const productTitle = first?.productTitle ?? null;
    return {
      id: a.id,
      kind: a.kind,
      tab: tabOf(a.kind),
      productId: a.productId,
      productTitle,
      image: own.find((v) => v.image)?.image ?? productVariants.find((v) => v.image)?.image ?? null,
      variants: names.slice(0, ROW_VARIANT_NAMES),
      moreVariants: Math.max(0, names.length - ROW_VARIANT_NAMES),
      amount: a.amount,
      currency: a.currency || input.currency,
      reason: readReason(a.reason),
      button: buttonFor(a, {
        plan: input.plan,
        preorderInstalled: input.preorderInstalled,
        storeHandle: input.storeHandle,
        today: input.today,
        productTitle,
      }),
    };
  });

  const fixCount = fixAllowed ? 0 : ranked.length - detailed.length;
  const counts = Object.fromEntries(ACTION_TABS.map((tab) => [tab, 0])) as Record<ActionTab, number>;
  counts.all = rows.length;
  for (const r of rows) counts[r.tab] += 1;
  if (!fixAllowed) counts.fix = fixCount;

  const today = input.today;
  const clearances: ClearanceView[] = input.clearances
    .map((c) => ({ c, endsOn: dayOf(c.endsAt) }))
    .filter(({ endsOn }) => endsOn === null || !isDay(today) || endsOn >= today)
    .slice(0, CLEARANCE_LIST_LIMIT)
    .map(({ c, endsOn }) => ({
      id: c.id,
      kind: c.kind === "code" ? "code" : "automatic",
      code: c.code,
      percent: c.percent,
      productTitle: c.productTitle,
      endsOn,
      cashFreed: cashFreed(c.baselineCash, c.currentCash),
      retail: c.retail,
      currency: c.currency || input.currency,
    }));

  // The rows beyond the plan's limit: only their count and total value reach the browser.
  const shownIds = new Set(shown.map((a) => a.id));
  const hidden = detailed.filter((a) => !shownIds.has(a.id));
  const hiddenAmount = hidden.length ? Math.round(hidden.reduce((sum, a) => sum + a.amount, 0) * 100) / 100 : null;

  return {
    currency: input.currency,
    rows,
    counts,
    hiddenCount: hidden.length,
    hiddenAmount,
    fixCount,
    clearances,
  };
}

// ── State changes (snooze / dismiss / done / undo) ──────────────────────────

export const ACTION_OPS = ["snooze", "dismiss", "done", "undo"] as const;
export type ActionOp = (typeof ACTION_OPS)[number];

export function isActionOp(v: unknown): v is ActionOp {
  return typeof v === "string" && (ACTION_OPS as readonly string[]).includes(v);
}

export type StateChange = {
  state: ActionState;
  snoozeUntil: Date | null;
  stateAmount: number | null;
  doneAt: Date | null;
};

/**
 * The fields one op writes. Snooze and dismiss remember the € figure (spec
 * §7.7: the row comes back when it doubles); undo returns the row to open.
 */
export function stateChange(op: ActionOp, amount: number, now: Date): StateChange {
  switch (op) {
    case "snooze":
      return { state: "snoozed", snoozeUntil: new Date(now.getTime() + SNOOZE_DAYS * 86_400_000), stateAmount: amount, doneAt: null };
    case "dismiss":
      return { state: "dismissed", snoozeUntil: null, stateAmount: amount, doneAt: null };
    case "done":
      return { state: "done", snoozeUntil: null, stateAmount: null, doneAt: now };
    case "undo":
      return { state: "open", snoozeUntil: null, stateAmount: null, doneAt: null };
  }
}
