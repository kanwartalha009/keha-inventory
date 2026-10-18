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
  "Safety {safety}: the forecast's own error over {n} days (± {error}) for a {pct} % in-stock target.": { es: "Seguridad {safety}: el propio error de la previsión en {n} días (± {error}) para un objetivo de disponibilidad del {pct} %.", fr: "Sécurité {safety} : l'erreur propre de la prévision sur {n} jours (± {error}) pour un objectif de disponibilité de {pct} %.", de: "Sicherheit {safety}: der eigene Fehler der Prognose über {n} Tage (± {error}) für {pct} % Verfügbarkeitsziel.", it: "Sicurezza {safety}: l'errore della previsione stessa su {n} giorni (± {error}) per un obiettivo di disponibilità del {pct} %.", pt: "Segurança {safety}: o próprio erro da previsão em {n} dias (± {error}) para uma meta de disponibilidade de {pct} %.", nl: "Veiligheid {safety}: de eigen fout van de prognose over {n} dagen (± {error}) voor een beschikbaarheidsdoel van {pct} %.", pl: "Zapas bezpieczeństwa {safety}: własny błąd prognozy w {n} dni (± {error}) przy celu dostępności {pct} %." },
  "In-stock target": { es: "Objetivo de disponibilidad", fr: "Objectif de disponibilité", de: "Verfügbarkeitsziel", it: "Obiettivo di disponibilità", pt: "Meta de disponibilidade", nl: "Beschikbaarheidsdoel", pl: "Cel dostępności" },
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
  // ---- Order-by labels (A1) ----
  "Next season: order by {date}": {
    es: "Próxima temporada: pedir antes del {date}",
    fr: "Prochaine saison : commander avant le {date}",
    de: "Nächste Saison: bis {date} bestellen",
    it: "Prossima stagione: ordina entro il {date}",
    pt: "Próxima estação: encomendar até {date}",
    nl: "Volgend seizoen: bestellen vóór {date}",
    pl: "Następny sezon: zamów do {date}",
  },
  "Next season": { es: "Próxima temporada", fr: "Prochaine saison", de: "Nächste Saison", it: "Prossima stagione", pt: "Próxima estação", nl: "Volgend seizoen", pl: "Następny sezon" },
  "Overdue · out of stock since {date}": { es: "Atrasado · sin stock desde el {date}", fr: "En retard · en rupture depuis le {date}", de: "Überfällig · nicht vorrätig seit {date}", it: "In ritardo · esaurito dal {date}", pt: "Atrasado · sem stock desde {date}", nl: "Te laat · niet op voorraad sinds {date}", pl: "Po terminie · brak w magazynie od {date}" },
  "Overdue · runs out {date}": {
    es: "Atrasado · se agota el {date}",
    fr: "En retard · rupture le {date}",
    de: "Überfällig · ausverkauft am {date}",
    it: "In ritardo · si esaurisce il {date}",
    pt: "Atrasado · esgota a {date}",
    nl: "Te laat · uitverkocht op {date}",
    pl: "Po terminie · skończy się {date}",
  },
  "out of stock since {date}": { es: "sin stock desde el {date}", fr: "en rupture depuis le {date}", de: "nicht vorrätig seit {date}", it: "esaurito dal {date}", pt: "sem stock desde {date}", nl: "niet op voorraad sinds {date}", pl: "brak w magazynie od {date}" },
  "runs out {date}": { es: "se agota el {date}", fr: "rupture le {date}", de: "ausverkauft am {date}", it: "si esaurisce il {date}", pt: "esgota a {date}", nl: "uitverkocht op {date}", pl: "skończy się {date}" },
  // ---- Below the supplier's minimum (A2) ----
  "Below minimum order": { es: "Por debajo del pedido mínimo", fr: "En dessous du minimum de commande", de: "Unter der Mindestbestellmenge", it: "Sotto l'ordine minimo", pt: "Abaixo da encomenda mínima", nl: "Onder de minimale bestelling", pl: "Poniżej minimalnego zamówienia" },
  "{product}: needs {n} of a minimum of {min} per style": {
    es: "{product}: necesita {n} de un mínimo de {min} por modelo",
    fr: "{product} : besoin de {n} pour un minimum de {min} par modèle",
    de: "{product}: braucht {n} bei mindestens {min} pro Modell",
    it: "{product}: servono {n} su un minimo di {min} per modello",
    pt: "{product}: precisa de {n} de um mínimo de {min} por modelo",
    nl: "{product}: nodig {n} bij een minimum van {min} per model",
    pl: "{product}: potrzeba {n} przy minimum {min} na model",
  },
  "Wait for the next season, or add it to a larger order.": { es: "Espera a la próxima temporada o añádelo a un pedido mayor.", fr: "Attendez la prochaine saison ou ajoutez-le à une commande plus grande.", de: "Warte auf die nächste Saison oder nimm es in eine größere Bestellung.", it: "Aspetta la prossima stagione o aggiungilo a un ordine più grande.", pt: "Espere pela próxima temporada ou junte-o a uma encomenda maior.", nl: "Wacht op het volgende seizoen of voeg het toe aan een grotere bestelling.", pl: "Poczekaj na następny sezon albo dodaj to do większego zamówienia." },
};
