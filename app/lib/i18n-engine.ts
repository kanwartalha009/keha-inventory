/**
 * Forecast and order-plan translations (engine work 2026-10-17): level shifts, safety stock from
 * the forecast's own error, next-season orders, long-overdue orders and orders below a supplier's
 * minimum. English text is the key (see app/lib/i18n.tsx). Tone: German "du", French "vous",
 * Spanish "tú", European Portuguese, Dutch "je", Polish informal.
 */
import type { Tr } from "./i18n";

export const ENGINE_TR: Record<string, Tr> = {
  // ---- "Why this quantity": level shift ----
  "Sales stepped up on {date}; using the recent level.": {
    es: "Las ventas subieron el {date}; se usa el nivel reciente.",
    fr: "Les ventes ont augmenté le {date} ; le niveau récent est utilisé.",
    de: "Die Verkäufe sind am {date} gestiegen; es zählt das neue Niveau.",
    it: "Le vendite sono salite il {date}; si usa il livello recente.",
    pt: "As vendas subiram a {date}; é usado o nível recente.",
    nl: "De verkoop steeg op {date}; het recente niveau telt.",
    pl: "Sprzedaż wzrosła {date}; liczy się nowy poziom.",
  },
  "Sales dropped on {date}; using the recent level.": {
    es: "Las ventas bajaron el {date}; se usa el nivel reciente.",
    fr: "Les ventes ont baissé le {date} ; le niveau récent est utilisé.",
    de: "Die Verkäufe sind am {date} gesunken; es zählt das neue Niveau.",
    it: "Le vendite sono scese il {date}; si usa il livello recente.",
    pt: "As vendas desceram a {date}; é usado o nível recente.",
    nl: "De verkoop daalde op {date}; het recente niveau telt.",
    pl: "Sprzedaż spadła {date}; liczy się nowy poziom.",
  },
  // ---- Safety stock from the forecast's own error ----
  "Safety {safety}: the forecast's own error over {n} days (± {error}) for a {pct} % fill target.": {
    es: "Seguridad {safety}: el propio error de la previsión en {n} días (± {error}) para un objetivo de servicio del {pct} %.",
    fr: "Sécurité {safety} : l'erreur propre de la prévision sur {n} jours (± {error}) pour un taux de service visé de {pct} %.",
    de: "Sicherheit {safety}: der eigene Fehler der Prognose über {n} Tage (± {error}) für {pct} % Lieferquote.",
    it: "Sicurezza {safety}: l'errore della previsione stessa su {n} giorni (± {error}) per un obiettivo di servizio del {pct} %.",
    pt: "Segurança {safety}: o próprio erro da previsão em {n} dias (± {error}) para um objetivo de serviço de {pct} %.",
    nl: "Veiligheid {safety}: de eigen fout van de prognose over {n} dagen (± {error}) voor {pct} % leverbaarheid.",
    pl: "Zapas bezpieczeństwa {safety}: własny błąd prognozy w {n} dni (± {error}) przy celu obsługi {pct} %.",
  },
  "Fill target": {
    es: "Objetivo de servicio",
    fr: "Taux de service visé",
    de: "Ziel-Lieferquote",
    it: "Obiettivo di servizio",
    pt: "Objetivo de serviço",
    nl: "Doel leverbaarheid",
    pl: "Cel obsługi",
  },
  "Forecast error over {n} days": {
    es: "Error de la previsión en {n} días",
    fr: "Erreur de prévision sur {n} jours",
    de: "Prognosefehler über {n} Tage",
    it: "Errore di previsione su {n} giorni",
    pt: "Erro da previsão em {n} dias",
    nl: "Prognosefout over {n} dagen",
    pl: "Błąd prognozy w {n} dni",
  },
  "± {n} units": { es: "± {n} unidades", fr: "± {n} unités", de: "± {n} Stück", it: "± {n} unità", pt: "± {n} unidades", nl: "± {n} stuks", pl: "± {n} szt." },
  "last 13 weeks: {x}× the expected error": {
    es: "últimas 13 semanas: {x}× el error esperado",
    fr: "13 dernières semaines : {x}× l'erreur attendue",
    de: "letzte 13 Wochen: {x}× der erwartete Fehler",
    it: "ultime 13 settimane: {x}× l'errore atteso",
    pt: "últimas 13 semanas: {x}× o erro esperado",
    nl: "laatste 13 weken: {x}× de verwachte fout",
    pl: "ostatnie 13 tygodni: {x}× oczekiwany błąd",
  },
  "Sales level": { es: "Nivel de ventas", fr: "Niveau des ventes", de: "Verkaufsniveau", it: "Livello delle vendite", pt: "Nível de vendas", nl: "Verkoopniveau", pl: "Poziom sprzedaży" },
};
