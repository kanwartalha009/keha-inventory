/**
 * Forecast notes (audit fixes 2026-10-17): the few labels the engine now attaches to its numbers
 * — a measured trend that is not applied (growth assumption off), an "off season" product that
 * sold in the coming weeks last year (instead of Dead), and the Free plan's weekly refresh.
 * English text is the key (see app/lib/i18n.tsx); every {placeholder} is kept.
 * Tone: German "du", French "vous", Spanish "tú", European Portuguese, Dutch "je", Polish informal.
 */
import type { Tr } from "./i18n";

export const FORECAST_TR: Record<string, Tr> = {
  "Not applied: year-over-year growth is off": { es: "No aplicado: el crecimiento interanual está desactivado", fr: "Non appliqué : la croissance sur un an est désactivée", de: "Nicht angewendet: Wachstum zum Vorjahr ist aus", it: "Non applicato: la crescita anno su anno è disattivata", pt: "Não aplicado: o crescimento homólogo está desligado", nl: "Niet toegepast: groei ten opzichte van vorig jaar staat uit", pl: "Nie zastosowano: wzrost rok do roku jest wyłączony" },
  "Off season: it sold in these weeks last year": {
    es: "Fuera de temporada: se vendió en estas semanas el año pasado",
    fr: "Hors saison : il s'est vendu à cette période l'an dernier",
    de: "Außerhalb der Saison: Es hat sich letztes Jahr in diesen Wochen verkauft",
    it: "Fuori stagione: si è venduto in queste settimane l'anno scorso",
    pt: "Fora de época: vendeu nestas semanas no ano passado",
    nl: "Buiten het seizoen: het verkocht vorig jaar in deze weken",
    pl: "Poza sezonem: sprzedawał się w tych tygodniach w zeszłym roku",
  },
};

/**
 * The engine's forecast notes, translated with the screen's `t` (Products, Home, the email). The
 * engine stores the English keys (season-shared TREND_NOT_APPLIED, VariantMetric.inputs.offSeason).
 */
export function forecastNotes(t: (key: string) => string) {
  return {
    trendNotApplied: t("Not applied: year-over-year growth is off"),
    offSeason: t("Off season: it sold in these weeks last year"),
    refreshedWeekly: t("Refreshed weekly on Free"),
  };
}
