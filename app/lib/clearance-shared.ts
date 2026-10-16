/**
 * Clear → Shopify discount (spec §4 J5, §6.4, §7.7). Pure, client-safe: the
 * confirm-dialog defaults and validation, the discount code generator, the
 * mutation input, the cash-in-stock baseline and "cash freed so far".
 *
 * Decisions (Kanwar, 2026-10-16): the merchant chooses an automatic discount
 * (default) or a discount code in the confirm dialog; 20% by default (1–90);
 * an optional end date, 30 days out by default; a generated code like
 * CLEAR-7Q3K that can be edited. Scoped to the action's product.
 */

export const CLEARANCE_KINDS = ["automatic", "code"] as const;
export type ClearanceKind = (typeof CLEARANCE_KINDS)[number];

export const CLEAR_PERCENT = { min: 1, max: 90, default: 20 } as const;
export const CLEAR_DAYS_DEFAULT = 30;

/** Letters without look-alikes (no I, O) and digits without 0 / 1. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_PREFIX = "CLEAR-";

/**
 * ASSUMPTION: Shopify accepts far longer codes, but a code a shopper types
 * should stay short and unambiguous: letters, digits, "-" and "_", 3–40.
 */
export const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;

/** "CLEAR-7Q3K". `rand` returns [0, 1) (injectable for tests). */
export function generateCode(rand: () => number = Math.random): string {
  let s = CODE_PREFIX;
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.min(CODE_ALPHABET.length - 1, Math.floor(rand() * CODE_ALPHABET.length))];
  return s;
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidCode(code: string): boolean {
  return CODE_RE.test(normalizeCode(code));
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function realDay(v: string): boolean {
  const m = DAY_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function plusDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** What the confirm dialog posts (strings, as typed). */
export type ClearForm = {
  kind: string;
  percent: string;
  /** "YYYY-MM-DD", or "" for no end date. */
  endsOn: string;
  code: string;
};

export function defaultClearForm(today: string, rand?: () => number): ClearForm {
  return {
    kind: "automatic",
    percent: String(CLEAR_PERCENT.default),
    endsOn: realDay(today) ? plusDays(today, CLEAR_DAYS_DEFAULT) : "",
    code: generateCode(rand),
  };
}

export type ClearFormError = "kind" | "percent" | "endsOn" | "code";

export type ClearValue = {
  kind: ClearanceKind;
  percent: number;
  endsOn: string | null;
  code: string | null;
};

/** Validate the dialog. The end date may be today or later (store calendar). */
export function validateClearForm(
  form: Partial<ClearForm>,
  today: string,
): { ok: true; value: ClearValue } | { ok: false; errors: Partial<Record<ClearFormError, true>> } {
  const errors: Partial<Record<ClearFormError, true>> = {};
  const kind = String(form.kind ?? "");
  if (!(CLEARANCE_KINDS as readonly string[]).includes(kind)) errors.kind = true;

  const pctRaw = String(form.percent ?? "").trim();
  const percent = /^\d{1,3}$/.test(pctRaw) ? Number(pctRaw) : NaN;
  if (!Number.isInteger(percent) || percent < CLEAR_PERCENT.min || percent > CLEAR_PERCENT.max) errors.percent = true;

  const endsRaw = String(form.endsOn ?? "").trim();
  let endsOn: string | null = null;
  if (endsRaw) {
    if (!realDay(endsRaw) || (realDay(today) && endsRaw < today)) errors.endsOn = true;
    else endsOn = endsRaw;
  }

  let code: string | null = null;
  if (kind === "code") {
    const c = normalizeCode(String(form.code ?? ""));
    if (!CODE_RE.test(c)) errors.code = true;
    else code = c;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { kind: kind as ClearanceKind, percent, endsOn, code } };
}

/**
 * The instant a store-calendar day ends (23:59:59 local), as UTC. Uses the
 * platform's tz data, so DST and odd offsets work; a bad zone means UTC.
 */
export function endOfLocalDay(day: string, timeZone: string | null | undefined): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d, 23, 59, 0);
  let tz = timeZone || "UTC";
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    tz = "UTC";
    return new Date(target + 59_000);
  }
  const wall = (at: number) => {
    const p = fmt.formatToParts(new Date(at));
    const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  };
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const off = wall(guess) - guess;
    const next = target - off;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess + 59_000);
}

/** The discount title shoppers see at checkout: language-neutral ("-20%") or the code. */
export function discountTitle(value: Pick<ClearValue, "kind" | "percent" | "code">): string {
  return value.kind === "code" && value.code ? value.code : `-${value.percent}%`;
}

/**
 * Variables for discountAutomaticBasicCreate / discountCodeBasicCreate
 * (Admin 2026-10: DiscountAutomaticBasicInput / DiscountCodeBasicInput).
 * `percentage` is a 0–1 decimal; items are the action's products; all buyers.
 */
export function discountInput(
  value: ClearValue,
  scope: { productIds: string[]; startsAt: Date; endsAt: Date | null },
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    title: discountTitle(value),
    startsAt: scope.startsAt.toISOString(),
    endsAt: scope.endsAt ? scope.endsAt.toISOString() : null,
    context: { all: "ALL" },
    customerGets: {
      value: { percentage: Math.round(value.percent) / 100 },
      items: { products: { productsToAdd: [...new Set(scope.productIds)] } },
    },
  };
  if (value.kind === "code") base.code = value.code;
  return base;
}

export type DiscountUserError = { field?: string[] | null; message: string; code?: string | null };

/** User errors from either mutation payload, as plain messages (Shopify sends them in the admin language). */
export function userErrorMessages(errors: readonly DiscountUserError[] | null | undefined): string[] {
  return (errors ?? []).map((e) => String(e?.message ?? "").trim()).filter(Boolean);
}

// ── Cash in stock and cash freed ────────────────────────────────────────────

export type StockValueIn = { onHand: number | null; cost: number | null; price: number | null };

/**
 * Cash in stock for a set of variants: on-hand units × cost, or × retail price
 * when a variant has no cost (`retail` = true, labelled in the UI). Variants
 * with no stock row are skipped; `cash` is null when no variant has a value.
 */
export function cashInStock(rows: readonly StockValueIn[]): { cash: number | null; units: number | null; retail: boolean } {
  let cash = 0;
  let units = 0;
  let valued = 0;
  let counted = 0;
  let retail = false;
  for (const r of rows) {
    if (r.onHand === null || !Number.isFinite(r.onHand)) continue;
    const qty = Math.max(0, r.onHand);
    counted += 1;
    units += qty;
    const cost = r.cost !== null && Number.isFinite(r.cost) ? r.cost : null;
    const price = r.price !== null && Number.isFinite(r.price) ? r.price : null;
    const unit = cost ?? price;
    if (unit === null) continue;
    if (cost === null) retail = true;
    cash += qty * unit;
    valued += 1;
  }
  return {
    cash: valued > 0 ? Math.round(cash * 100) / 100 : null,
    units: counted > 0 ? units : null,
    retail,
  };
}

/**
 * Cash freed so far = baseline − cash in those variants now (spec §4 J5).
 * Never negative; null ("—") when either side is unknown or the baseline was
 * not computable (stored as ≤ 0).
 */
export function cashFreed(baseline: number | null | undefined, current: number | null | undefined): number | null {
  if (baseline === null || baseline === undefined || !Number.isFinite(baseline) || baseline <= 0) return null;
  if (current === null || current === undefined || !Number.isFinite(current)) return null;
  return Math.round(Math.max(0, baseline - current) * 100) / 100;
}
