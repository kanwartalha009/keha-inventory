/**
 * Forecast accuracy translations (accuracy audit 2026-10-18): recurring high days, small season
 * groups blended with the store, stores with less than 13 months of sales, late purchase orders. English text is the key (see
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
  "Seasonality: {n} of 13 months of history": { es: "Estacionalidad: {n} de 13 meses de historial", fr: "Saisonnalité : {n} mois d'historique sur 13", de: "Saisonalität: {n} von 13 Monaten Verlauf", it: "Stagionalità: {n} mesi di storico su 13", pt: "Sazonalidade: {n} de 13 meses de histórico", nl: "Seizoenspatroon: {n} van 13 maanden historie", pl: "Sezonowość: {n} z 13 miesięcy historii" },
  "An open order is 1 day late: counted as arriving now, with {units} more safety while it is late.": {
    es: "Un pedido abierto lleva 1 día de retraso: se cuenta como si llegara ya, con {units} más de seguridad mientras siga retrasado.",
    fr: "Une commande en cours a 1 jour de retard : comptée comme arrivant maintenant, avec {units} de sécurité en plus tant qu'elle est en retard.",
    de: "Eine offene Bestellung ist 1 Tag zu spät: Sie zählt als jetzt eingetroffen, mit {units} mehr Sicherheit, solange sie zu spät ist.",
    it: "Un ordine aperto è in ritardo di 1 giorno: contato come in arrivo ora, con {units} di scorta in più finché è in ritardo.",
    pt: "Uma encomenda em aberto está 1 dia atrasada: conta como a chegar agora, com mais {units} de segurança enquanto estiver atrasada.",
    nl: "Een open bestelling is 1 dag te laat: telt alsof hij nu binnenkomt, met {units} extra veiligheid zolang hij te laat is.",
    pl: "Otwarte zamówienie spóźnia się 1 dzień: liczone jak przychodzące teraz, z {units} szt. zapasu więcej, dopóki się spóźnia.",
  },
  "An open order is {n} days late: counted as arriving now, with {units} more safety while it is late.": {
    es: "Un pedido abierto lleva {n} días de retraso: se cuenta como si llegara ya, con {units} más de seguridad mientras siga retrasado.",
    fr: "Une commande en cours a {n} jours de retard : comptée comme arrivant maintenant, avec {units} de sécurité en plus tant qu'elle est en retard.",
    de: "Eine offene Bestellung ist {n} Tage zu spät: Sie zählt als jetzt eingetroffen, mit {units} mehr Sicherheit, solange sie zu spät ist.",
    it: "Un ordine aperto è in ritardo di {n} giorni: contato come in arrivo ora, con {units} di scorta in più finché è in ritardo.",
    pt: "Uma encomenda em aberto está {n} dias atrasada: conta como a chegar agora, com mais {units} de segurança enquanto estiver atrasada.",
    nl: "Een open bestelling is {n} dagen te laat: telt alsof hij nu binnenkomt, met {units} extra veiligheid zolang hij te laat is.",
    pl: "Otwarte zamówienie spóźnia się {n} dni: liczone jak przychodzące teraz, z {units} szt. zapasu więcej, dopóki się spóźnia.",
  },
};
