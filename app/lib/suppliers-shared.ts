/**
 * Supplier form (Settings → Suppliers, spec §5.5): validation and the
 * form ↔ row mapping. Pure, client-safe. Error values are short codes; the UI
 * turns them into translated text with `supplierErrorText`.
 */

import { readMinOrderScope, type MinOrderScope } from "./supplier-shared";

type T = (s: string) => string;

/** What the merchant edits. Numbers stay strings so a half-typed field round-trips. */
export type SupplierForm = {
  name: string;
  email: string;
  leadTimeDays: string;
  /** Minimum units per variant line. Empty = none. */
  minOrder: string;
  /** Minimum total units for the whole order. Empty = none. */
  minOrderTotal: string;
  casePack: string;
  /** Days from the supplier's ship date to arrival (sea or air freight). Empty = none. */
  transitDays: string;
  /** How often the merchant orders from this supplier, in days. Empty = the store's order cycle. */
  orderCycleDays: string;
  /** Minimum order value in the supplier's currency. Empty = none. */
  minOrderValue: string;
  /** What "Minimum per item" applies to: "variant" (each size/colour) or "product" (split across sizes by sales). */
  minOrderScope: MinOrderScope;
  /** 1 supplier-currency unit in store currency. Only kept when the supplier currency differs from the store's. */
  exchangeRate: string;
  /** ISO 4217 code; empty = the store currency. */
  currency: string;
  hidePrices: boolean;
  vendorMatch: string[];
};

/** A validated supplier, ready to store (the email is still plain text here). */
export type SupplierInput = {
  name: string;
  email: string | null;
  leadTimeDays: number;
  minOrder: number | null;
  minOrderTotal: number | null;
  casePack: number | null;
  transitDays: number | null;
  /** null = the store's order cycle (Settings → Defaults). */
  orderCycleDays: number | null;
  minOrderValue: number | null;
  minOrderScope: MinOrderScope;
  exchangeRate: number | null;
  currency: string | null;
  hidePrices: boolean;
  vendorMatch: string[];
};

export type SupplierErrorCode =
  | "name"
  | "nameLong"
  | "nameTaken"
  | "email"
  | "emailStorage"
  | "range"
  | "currency"
  | "vendors"
  | "transit"
  | "money"
  | "rate";
export type SupplierErrors = Partial<Record<keyof SupplierForm, SupplierErrorCode>>;

export const SUPPLIER_BOUNDS = {
  leadTimeDays: { min: 0, max: 365 },
  minOrder: { min: 1, max: 100_000 },
  minOrderTotal: { min: 1, max: 1_000_000 },
  casePack: { min: 1, max: 10_000 },
  transitDays: { min: 0, max: 365 },
  orderCycleDays: { min: 1, max: 365 },
} as const;
export type SupplierNumberKey = keyof typeof SUPPLIER_BOUNDS;

export const SUPPLIER_NAME_MAX = 100;
export const VENDOR_MATCH_MAX = 50;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Minimum order value: up to 2 decimals, at most this much. */
export const MIN_ORDER_VALUE_MAX = 100_000_000;
/** Exchange rate: positive, up to 6 decimals (Supplier.exchangeRate is Decimal(18, 6)). */
export const EXCHANGE_RATE_MAX = 1_000_000;

export const EMPTY_SUPPLIER_FORM: SupplierForm = {
  name: "",
  email: "",
  leadTimeDays: "14",
  minOrder: "",
  minOrderTotal: "",
  casePack: "",
  transitDays: "",
  orderCycleDays: "",
  minOrderValue: "",
  minOrderScope: "variant",
  exchangeRate: "",
  currency: "",
  hidePrices: false,
  vendorMatch: [],
};

/** A new supplier starts with the store's default lead time and currency. */
export function newSupplierForm(defaultLeadTime: number, storeCurrency: string): SupplierForm {
  return { ...EMPTY_SUPPLIER_FORM, leadTimeDays: String(defaultLeadTime), currency: storeCurrency };
}

export function supplierToForm(s: {
  name: string;
  email: string | null;
  leadTimeDays: number;
  minOrder: number | null;
  minOrderTotal: number | null;
  casePack: number | null;
  transitDays?: number | null;
  orderCycleDays?: number | null;
  minOrderValue?: number | null;
  minOrderScope?: string | null;
  exchangeRate?: number | null;
  currency: string | null;
  hidePrices: boolean;
  vendorMatch: string[];
}): SupplierForm {
  const str = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));
  return {
    name: s.name,
    email: s.email ?? "",
    leadTimeDays: String(s.leadTimeDays),
    minOrder: str(s.minOrder),
    minOrderTotal: str(s.minOrderTotal),
    casePack: str(s.casePack),
    transitDays: str(s.transitDays),
    orderCycleDays: str(s.orderCycleDays),
    minOrderValue: str(s.minOrderValue),
    minOrderScope: readMinOrderScope(s.minOrderScope),
    exchangeRate: str(s.exchangeRate),
    currency: s.currency ?? "",
    hidePrices: s.hidePrices,
    vendorMatch: [...s.vendorMatch],
  };
}

/** Any JSON body → a SupplierForm (unknown fields dropped, wrong types emptied). */
export function readSupplierForm(raw: unknown): SupplierForm {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (k: keyof SupplierForm) => (typeof r[k] === "string" || typeof r[k] === "number" ? String(r[k]) : "");
  return {
    name: s("name"),
    email: s("email"),
    leadTimeDays: s("leadTimeDays"),
    minOrder: s("minOrder"),
    minOrderTotal: s("minOrderTotal"),
    casePack: s("casePack"),
    transitDays: s("transitDays"),
    orderCycleDays: s("orderCycleDays"),
    minOrderValue: s("minOrderValue"),
    minOrderScope: readMinOrderScope(r.minOrderScope),
    exchangeRate: s("exchangeRate"),
    currency: s("currency"),
    hidePrices: r.hidePrices === true,
    vendorMatch: Array.isArray(r.vendorMatch) ? r.vendorMatch.filter((v): v is string => typeof v === "string") : [],
  };
}

/** Trimmed, de-duplicated (case-insensitive) vendor names, empty ones dropped. */
export function cleanVendors(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) {
    const x = v.trim().slice(0, 255);
    const k = x.toLowerCase();
    if (!x || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/** A decimal with at most `places` decimals, in (0, max]; null when it isn't one. Accepts "1,08" too. */
export function parseDecimal(raw: string, places: number, max: number): number | null {
  const x = raw.trim().replace(",", ".");
  if (!new RegExp(`^\\d+(\\.\\d{1,${places}})?$`).test(x)) return null;
  const n = Number(x);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

/** Does this supplier bill in another currency than the store's (so an exchange rate applies)? */
export function needsExchangeRate(supplierCurrency: string, storeCurrency: string): boolean {
  const c = supplierCurrency.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) && c !== storeCurrency.trim().toUpperCase();
}

/**
 * Validate the form. `takenNames` are the other suppliers' names (a name is
 * unique per store, case-insensitive). `storeCurrency` decides whether the
 * exchange rate applies (it is dropped when the supplier bills in the store
 * currency); without it, a rate is kept whenever a currency is set.
 */
export function validateSupplierForm(
  form: SupplierForm,
  takenNames: readonly string[] = [],
  storeCurrency?: string,
): { ok: true; input: SupplierInput } | { ok: false; errors: SupplierErrors } {
  const errors: SupplierErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = "name";
  else if (name.length > SUPPLIER_NAME_MAX) errors.name = "nameLong";
  else if (takenNames.some((n) => n.trim().toLowerCase() === name.toLowerCase())) errors.name = "nameTaken";

  const email = form.email.trim().toLowerCase();
  if (email && (!EMAIL.test(email) || email.length > 254)) errors.email = "email";

  const num = (key: SupplierNumberKey, required: boolean): number | null => {
    const raw = String(form[key]).trim();
    if (!raw) {
      if (required) errors[key] = "range";
      return null;
    }
    const n = Number(raw);
    const { min, max } = SUPPLIER_BOUNDS[key];
    if (!Number.isInteger(n) || n < min || n > max) {
      errors[key] = "range";
      return null;
    }
    return n;
  };
  const leadTimeDays = num("leadTimeDays", true);
  const minOrder = num("minOrder", false);
  const minOrderTotal = num("minOrderTotal", false);
  const casePack = num("casePack", false);
  const transitDays = num("transitDays", false);
  const orderCycleDays = num("orderCycleDays", false);
  // Lead time is the total from order to arrival, so the freight part can't be longer.
  if (transitDays !== null && leadTimeDays !== null && transitDays > leadTimeDays) errors.transitDays = "transit";

  let minOrderValue: number | null = null;
  if (String(form.minOrderValue).trim()) {
    minOrderValue = parseDecimal(String(form.minOrderValue), 2, MIN_ORDER_VALUE_MAX);
    if (minOrderValue === null) errors.minOrderValue = "money";
  }

  const currency = form.currency.trim().toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) errors.currency = "currency";

  const rateApplies = storeCurrency === undefined ? !!currency : needsExchangeRate(currency, storeCurrency);
  let exchangeRate: number | null = null;
  if (rateApplies && String(form.exchangeRate).trim()) {
    exchangeRate = parseDecimal(String(form.exchangeRate), 6, EXCHANGE_RATE_MAX);
    if (exchangeRate === null) errors.exchangeRate = "rate";
  }

  const vendorMatch = cleanVendors(form.vendorMatch);
  if (vendorMatch.length > VENDOR_MATCH_MAX) errors.vendorMatch = "vendors";

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      name,
      email: email || null,
      leadTimeDays: leadTimeDays!,
      minOrder,
      minOrderTotal,
      // A case pack of 1 is no case pack.
      casePack: casePack && casePack > 1 ? casePack : null,
      transitDays: transitDays || null,
      orderCycleDays,
      minOrderValue,
      minOrderScope: readMinOrderScope(form.minOrderScope),
      exchangeRate,
      currency: currency || null,
      hidePrices: form.hidePrices,
      vendorMatch,
    },
  };
}

/** Translated error text (literal t() calls so the coverage test sees them). */
export function supplierErrorText(code: SupplierErrorCode, t: T): string {
  switch (code) {
    case "name":
      return t("Enter the supplier's name.");
    case "nameLong":
      return t("Use up to 100 characters.");
    case "nameTaken":
      return t("You already have a supplier with this name.");
    case "email":
      return t("Check the email address.");
    case "emailStorage":
      return t("Secure storage isn't set up for this app yet, so this can't be saved. Contact Keha support.");
    case "range":
      return t("Enter a whole number from {min} to {max}.");
    case "currency":
      return t("Use a 3-letter currency code, like EUR.");
    case "vendors":
      return t("Pick up to 50 vendors.");
    case "transit":
      return t("Transit can't be longer than the lead time, which already includes it.");
    case "money":
      return t("Enter an amount like 500 or 499.99.");
    case "rate":
      return t("Enter a rate above 0, like 1.08.");
  }
}

/** Shopify product gids from a resource-picker selection (anything else dropped). */
export function productIdsFrom(raw: unknown, max = 250): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const x of raw) {
    const id = typeof x === "string" ? x : x && typeof x === "object" ? (x as { id?: unknown }).id : null;
    if (typeof id === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(id)) out.add(id);
    if (out.size >= max) break;
  }
  return [...out];
}
