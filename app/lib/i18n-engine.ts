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
};
