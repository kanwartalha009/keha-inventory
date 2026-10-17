/**
 * Forecast notes (audit fixes 2026-10-17): the few labels the engine now attaches to its numbers
 * — a measured trend that is not applied (growth assumption off), an "off season" product that
 * sold in the coming weeks last year (instead of Dead), and the Free plan's weekly refresh.
 * English text is the key (see app/lib/i18n.tsx); every {placeholder} is kept.
 * Tone: German "du", French "vous", Spanish "tú", European Portuguese, Dutch "je", Polish informal.
 */
import type { Tr } from "./i18n";

export const FORECAST_TR: Record<string, Tr> = {
  "Not applied: the growth assumption is off": {
    es: "No aplicado: la previsión de crecimiento está desactivada",
    fr: "Non appliqué : l'hypothèse de croissance est désactivée",
    de: "Nicht angewendet: Die Wachstumsannahme ist aus",
    it: "Non applicato: l'ipotesi di crescita è disattivata",
    pt: "Não aplicado: o pressuposto de crescimento está desligado",
    nl: "Niet toegepast: de groeiaanname staat uit",
    pl: "Nie zastosowano: założenie wzrostu jest wyłączone",
  },
  "Off season: it sold in these weeks last year": {
    es: "Fuera de temporada: se vendió en estas semanas el año pasado",
    fr: "Hors saison : il s'est vendu à cette période l'an dernier",
    de: "Außerhalb der Saison: Es hat sich letztes Jahr in diesen Wochen verkauft",
    it: "Fuori stagione: si è venduto in queste settimane l'anno scorso",
    pt: "Fora de época: vendeu nestas semanas no ano passado",
    nl: "Buiten het seizoen: het verkocht vorig jaar in deze weken",
    pl: "Poza sezonem: sprzedawał się w tych tygodniach w zeszłym roku",
  },
  "Refreshed weekly on Free": {
    es: "Se actualizan cada semana en el plan Free",
    fr: "Actualisés chaque semaine avec le forfait Free",
    de: "Im Free-Tarif wöchentlich aktualisiert",
    it: "Aggiornati ogni settimana con il piano Free",
    pt: "Atualizados semanalmente no plano Free",
    nl: "Wekelijks bijgewerkt met Free",
    pl: "W planie Free odświeżane co tydzień",
  },
};

/**
 * The engine's forecast notes, translated with the screen's `t` (Products, Home, the email). The
 * engine stores the English keys (season-shared TREND_NOT_APPLIED, VariantMetric.inputs.offSeason).
 */
export function forecastNotes(t: (key: string) => string) {
  return {
    trendNotApplied: t("Not applied: the growth assumption is off"),
    offSeason: t("Off season: it sold in these weeks last year"),
    refreshedWeekly: t("Refreshed weekly on Free"),
  };
}
