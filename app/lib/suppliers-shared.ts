/**
 * Supplier form (Settings → Suppliers, spec §5.5): validation and the
 * form ↔ row mapping. Pure, client-safe. Error values are short codes; the UI
 * turns them into translated text with `supplierErrorText`.
 */

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
  currency: string | null;
  hidePrices: boolean;
  vendorMatch: string[];
};

export type SupplierErrorCode = "name" | "nameLong" | "nameTaken" | "email" | "range" | "currency" | "vendors";
export type SupplierErrors = Partial<Record<keyof SupplierForm, SupplierErrorCode>>;

export const SUPPLIER_BOUNDS = {
  leadTimeDays: { min: 0, max: 365 },
  minOrder: { min: 1, max: 100_000 },
  minOrderTotal: { min: 1, max: 1_000_000 },
  casePack: { min: 1, max: 10_000 },
} as const;
export type SupplierNumberKey = keyof typeof SUPPLIER_BOUNDS;

export const SUPPLIER_NAME_MAX = 100;
export const VENDOR_MATCH_MAX = 50;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const EMPTY_SUPPLIER_FORM: SupplierForm = {
  name: "",
  email: "",
  leadTimeDays: "14",
  minOrder: "",
  minOrderTotal: "",
  casePack: "",
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
  currency: string | null;
  hidePrices: boolean;
  vendorMatch: string[];
}): SupplierForm {
  const str = (n: number | null) => (n === null ? "" : String(n));
  return {
    name: s.name,
    email: s.email ?? "",
    leadTimeDays: String(s.leadTimeDays),
    minOrder: str(s.minOrder),
    minOrderTotal: str(s.minOrderTotal),
    casePack: str(s.casePack),
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

/**
 * Validate the form. `takenNames` are the other suppliers' names (a name is
 * unique per store, case-insensitive).
 */
export function validateSupplierForm(
  form: SupplierForm,
  takenNames: readonly string[] = [],
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

  const currency = form.currency.trim().toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) errors.currency = "currency";

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
    case "range":
      return t("Enter a whole number from {min} to {max}.");
    case "currency":
      return t("Use a 3-letter currency code, like EUR.");
    case "vendors":
      return t("Pick up to 50 vendors.");
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
