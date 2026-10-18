/**
 * Forecast accuracy translations (accuracy audit 2026-10-18): recurring high days, stores with
 * less than 13 months of sales, late purchase orders. English text is the key (see
 * app/lib/i18n.tsx). Tone: German "du", French "vous", Spanish "tú", European Portuguese, Dutch
 * "je", Polish informal.
 */
import type { Tr } from "./i18n";

export const ACCURACY_TR: Record<string, Tr> = {
  "High days that come back (promotions, repeat orders) count as {units} a day over the year.": {
    es: "Los días fuertes que se repiten (promociones, pedidos recurrentes) cuentan como {units} al día a lo largo del año.",
    fr: "Les jours forts qui reviennent (promotions, commandes répétées) comptent pour {units} par jour sur l'année.",
    de: "Starke Tage, die wiederkommen (Aktionen, Wiederholungsbestellungen), zählen als {units} pro Tag übers Jahr.",
    it: "I giorni forti che si ripetono (promozioni, ordini ricorrenti) contano come {units} al giorno nell'anno.",
    pt: "Os dias fortes que se repetem (promoções, encomendas recorrentes) contam como {units} por dia ao longo do ano.",
    nl: "Sterke dagen die terugkomen (acties, herhaalbestellingen) tellen als {units} per dag over het jaar.",
    pl: "Mocne dni, które się powtarzają (promocje, powtarzane zamówienia), liczą się jako {units} dziennie w skali roku.",
  },
  "{source}, blended with your whole store ({pct} % its own)": {
    es: "{source}, combinado con toda tu tienda ({pct} % propio)",
    fr: "{source}, combiné avec toute votre boutique ({pct} % propre)",
    de: "{source}, gemischt mit deinem ganzen Shop ({pct} % eigen)",
    it: "{source}, combinato con tutto il tuo negozio ({pct} % proprio)",
    pt: "{source}, combinado com toda a sua loja ({pct} % próprio)",
    nl: "{source}, gemengd met je hele winkel ({pct} % eigen)",
    pl: "{source}, połączone z całym Twoim sklepem ({pct} % własne)",
  },
};
