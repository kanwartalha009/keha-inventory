/**
 * Admin i18n. The admin UI follows the staff member's admin language (the
 * `locale` URL param Shopify adds), else the store's primary language, with a
 * manual override in Settings (persisted to localStorage). Any untranslated
 * string falls back to English, so the app is always usable.
 *
 * English text is the key: wrap every visible string in t() with its English
 * text, and add its translations to the area dictionary
 * (`app/lib/i18n-<area>.ts`). tests/i18n-coverage.test.ts fails when a t()
 * string has no translation in any of the 7 non-English languages.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { COMMON_TR } from "./i18n-common";
import { PLANS_TR } from "./i18n-plans";
import { HOME_TR } from "./i18n-home";
import { PRODUCTS_TR } from "./i18n-products";
import { EMAIL_TR } from "./i18n-email";
import { REASONS_TR } from "./i18n-reasons";
import { REORDER_TR } from "./i18n-reorder";
import { ACTIONS_TR } from "./i18n-actions";
import { ALERTS_TR } from "./i18n-alerts";
import { PLANNER_TR } from "./i18n-planner";
import { STORES_TR } from "./i18n-stores";
import { FACTS_TR } from "./i18n-facts";
import { ORDERPLAN_TR } from "./i18n-orderplan";
import { FORECAST_TR } from "./i18n-forecast";
import { PO_TR } from "./i18n-po";
import { ORDERING_TR } from "./i18n-ordering";
import { UX_TR } from "./i18n-ux";
import { READINESS_TR } from "./i18n-readiness";
import { BUILDER_TR } from "./i18n-builder";
import { SETUP_TR } from "./i18n-setup";
import { CASH_TR } from "./i18n-cash";
import { SAMPLE_TR } from "./i18n-sample";
import { QUALITY_TR } from "./i18n-quality";
import { ENGINE_TR } from "./i18n-engine";
import { COPY_TR } from "./i18n-copy";

export type Locale = "en" | "es" | "fr" | "de" | "it" | "pt" | "nl" | "pl";

export const LOCALES: Locale[] = ["en", "es", "fr", "de", "it", "pt", "nl", "pl"];

export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  pt: "Português",
  nl: "Nederlands",
  pl: "Polski",
};

/** One English string's translations (English is the key). */
export type Tr = Partial<Record<Exclude<Locale, "en">, string>>;

// Fallback when no language is known (the real default is detected in the app
// loader and passed to LocaleProvider via `defaultLocale`).
export const STORE_DEFAULT_LOCALE: Locale = "en";

const STORAGE_KEY = "keha_inventory_locale";

/**
 * Map a Shopify locale (e.g. "de", "de-DE", "pt-BR") to one of our supported
 * admin locales by 2-letter prefix; anything unknown falls back to English.
 */
export function toSupportedLocale(raw: string | null | undefined): Locale {
  const prefix = (raw ?? "").toLowerCase().slice(0, 2);
  return (LOCALES as string[]).includes(prefix) ? (prefix as Locale) : "en";
}

type Dict = Record<string, string>;
const DICT: Record<Exclude<Locale, "en">, Dict> = { es: {}, fr: {}, de: {}, it: {}, pt: {}, nl: {}, pl: {} };

/** Every area dictionary. Add a new `i18n-<area>.ts` here. */
export const AREAS: Record<string, Record<string, Tr>> = {
  common: COMMON_TR,
  plans: PLANS_TR,
  home: HOME_TR,
  products: PRODUCTS_TR,
  email: EMAIL_TR,
  reasons: REASONS_TR,
  reorder: REORDER_TR,
  actions: ACTIONS_TR,
  alerts: ALERTS_TR,
  planner: PLANNER_TR,
  stores: STORES_TR,
  facts: FACTS_TR,
  orderplan: ORDERPLAN_TR,
  forecast: FORECAST_TR,
  po: PO_TR,
  ordering: ORDERING_TR,
  ux: UX_TR,
  readiness: READINESS_TR,
  builder: BUILDER_TR,
  setup: SETUP_TR,
  cash: CASH_TR,
  sample: SAMPLE_TR,
  quality: QUALITY_TR,
  engine: ENGINE_TR,
  copy: COPY_TR,
};

for (const area of Object.values(AREAS)) {
  for (const [key, m] of Object.entries(area)) {
    (Object.keys(m) as Array<Exclude<Locale, "en">>).forEach((loc) => {
      const val = m[loc];
      if (val) DICT[loc][key] = val;
    });
  }
}

/** Translate outside React (store-owner emails, tests). Same lookup as `t`. */
export function translate(locale: Locale, key: string): string {
  if (locale === "en") return key;
  return DICT[locale]?.[key] ?? key;
}

/** Replace `{name}` placeholders. */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

type LocaleCtx = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string) => string;
};

const Ctx = createContext<LocaleCtx>({
  locale: STORE_DEFAULT_LOCALE,
  setLocale: () => {},
  t: (k) => k,
});

export function LocaleProvider({
  children,
  defaultLocale,
}: {
  children: ReactNode;
  /** Staff admin language, else the store's primary language (detected server-side); a manual choice saved in localStorage still wins. */
  defaultLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale ?? STORE_DEFAULT_LOCALE);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY) as Locale | null;
      if (saved && (LOCALES as string[]).includes(saved)) setLocaleState(saved);
    } catch {
      /* storage blocked — keep the detected language */
    }
  }, []);

  const value = useMemo<LocaleCtx>(
    () => ({
      locale,
      setLocale: (l) => {
        setLocaleState(l);
        try {
          if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, l);
        } catch {
          /* storage blocked — the choice lasts for this page view */
        }
      },
      t: (key) => translate(locale, key),
    }),
    [locale],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLocale() {
  return useContext(Ctx);
}
