/**
 * Listing / marketing audit copy fixes (2026-10-18): the "plan is ready" notice and email say how
 * much sales history was really read (lib/sync-progress-shared salesSpan), not the fixed read
 * window. English text is the key (see app/lib/i18n.tsx). Tone: German "du", French "vous",
 * Spanish "tú", European Portuguese, Dutch "je", Polish informal. Polish uses "mies." so the
 * sentence reads right for any number of months (2 miesiące / 5 miesięcy).
 */
import type { Tr } from "./i18n";

export const COPY_TR: Record<string, Tr> = {
  // ---- First sync: the read covers up to the window, a young store has less ----
  "We're reading up to {n} months of sales, so the plan can reflect your seasons.": {
    es: "Estamos leyendo hasta {n} meses de ventas para que el plan pueda reflejar tus temporadas.",
    fr: "Nous lisons jusqu'à {n} mois de ventes pour que le plan puisse tenir compte de vos saisons.",
    de: "Wir lesen bis zu {n} Monate Verkäufe, damit der Plan deine Saisons abbilden kann.",
    it: "Stiamo leggendo fino a {n} mesi di vendite perché il piano possa riflettere le tue stagioni.",
    pt: "Estamos a ler até {n} meses de vendas para que o plano possa refletir as suas épocas.",
    nl: "We lezen tot {n} maanden verkopen, zodat het plan je seizoenen kan volgen.",
    pl: "Odczytujemy sprzedaż z maksymalnie {n} mies., aby plan mógł uwzględnić Twoje sezony.",
  },

  // ---- "Your order plan is ready": the months of sales really read ----
  "We read {n} months of your sales, so your plan reflects your seasons.": {
    es: "Hemos leído {n} meses de tus ventas, así que tu plan refleja tus temporadas.",
    fr: "Nous avons lu {n} mois de ventes : votre plan tient compte de vos saisons.",
    de: "Wir haben {n} Monate deiner Verkäufe gelesen – dein Plan bildet deine Saisons ab.",
    it: "Abbiamo letto {n} mesi di vendite: il piano riflette le tue stagioni.",
    pt: "Lemos {n} meses das suas vendas, por isso o plano reflete as suas épocas.",
    nl: "We hebben {n} maanden van je verkopen gelezen, dus je plan volgt je seizoenen.",
    pl: "Odczytaliśmy Twoją sprzedaż z {n} mies., więc plan uwzględnia Twoje sezony.",
  },
  "We read your {n} months of sales.": {
    es: "Hemos leído tus {n} meses de ventas.",
    fr: "Nous avons lu vos {n} mois de ventes.",
    de: "Wir haben deine {n} Monate Verkäufe gelesen.",
    it: "Abbiamo letto i tuoi {n} mesi di vendite.",
    pt: "Lemos os seus {n} meses de vendas.",
    nl: "We hebben je {n} maanden verkopen gelezen.",
    pl: "Odczytaliśmy Twoją sprzedaż z {n} mies.",
  },
  "We read your {n} days of sales.": {
    es: "Hemos leído tus {n} días de ventas.",
    fr: "Nous avons lu vos {n} jours de ventes.",
    de: "Wir haben deine {n} Tage Verkäufe gelesen.",
    it: "Abbiamo letto i tuoi {n} giorni di vendite.",
    pt: "Lemos os seus {n} dias de vendas.",
    nl: "We hebben je {n} dagen verkopen gelezen.",
    pl: "Odczytaliśmy Twoją sprzedaż z {n} dni.",
  },
  "We read your first day of sales.": {
    es: "Hemos leído tu primer día de ventas.",
    fr: "Nous avons lu votre premier jour de ventes.",
    de: "Wir haben deinen ersten Verkaufstag gelesen.",
    it: "Abbiamo letto il tuo primo giorno di vendite.",
    pt: "Lemos o seu primeiro dia de vendas.",
    nl: "We hebben je eerste verkoopdag gelezen.",
    pl: "Odczytaliśmy Twój pierwszy dzień sprzedaży.",
  },
  "We didn't find any sales yet. Your plan fills in as sales come in.": {
    es: "Aún no hemos encontrado ventas. Tu plan se irá completando a medida que lleguen.",
    fr: "Nous n'avons pas encore trouvé de ventes. Votre plan se complète au fil des ventes.",
    de: "Wir haben noch keine Verkäufe gefunden. Dein Plan füllt sich, sobald Verkäufe eingehen.",
    it: "Non abbiamo ancora trovato vendite. Il piano si completa man mano che arrivano.",
    pt: "Ainda não encontrámos vendas. O seu plano vai-se completando à medida que chegam.",
    nl: "We hebben nog geen verkopen gevonden. Je plan vult zich zodra er verkopen binnenkomen.",
    pl: "Nie znaleźliśmy jeszcze sprzedaży. Plan uzupełni się, gdy pojawi się sprzedaż.",
  },
  "We've finished reading your sales, stock and store visits.": {
    es: "Hemos terminado de leer tus ventas, stock y visitas.",
    fr: "Nous avons fini de lire vos ventes, votre stock et vos visites.",
    de: "Wir haben deine Verkäufe, deinen Bestand und deine Shop-Besuche fertig gelesen.",
    it: "Abbiamo finito di leggere vendite, stock e visite.",
    pt: "Terminámos de ler as suas vendas, stock e visitas.",
    nl: "We hebben je verkopen, voorraad en winkelbezoeken gelezen.",
    pl: "Skończyliśmy odczytywać Twoją sprzedaż, stany i odwiedziny.",
  },

  // ---- Growth plan card: named like the screen (Order plan → Next 13 weeks) ----
  "Order calendar: every order with cash per week": { es: "Calendario de pedidos: cada pedido con el dinero de cada semana", fr: "Calendrier des commandes : chaque commande avec la trésorerie par semaine", de: "Bestellkalender: jede Bestellung mit Geldbedarf pro Woche", it: "Calendario ordini: ogni ordine con la liquidità per settimana", pt: "Calendário de encomendas: cada encomenda com o dinheiro por semana", nl: "Bestelkalender: elke bestelling met het geld per week", pl: "Kalendarz zamówień: każde zamówienie z gotówką na każdy tydzień" },

  // ---- Weekly sales re-check (owner 2026-10-18): shown only when corrections moved units by > 2% ----
  "Shopify updated 1 day of past sales (refunds or order edits). Your numbers include it.": {
    es: "Shopify actualizó 1 día de ventas pasadas (reembolsos o pedidos editados). Tus números ya lo incluyen.",
    fr: "Shopify a mis à jour 1 jour de ventes passées (remboursements ou commandes modifiées). Vos chiffres en tiennent compte.",
    de: "Shopify hat 1 Tag vergangener Verkäufe aktualisiert (Erstattungen oder geänderte Bestellungen). Deine Zahlen berücksichtigen das.",
    it: "Shopify ha aggiornato 1 giorno di vendite passate (rimborsi o ordini modificati). I tuoi numeri lo includono.",
    pt: "A Shopify atualizou 1 dia de vendas passadas (reembolsos ou encomendas editadas). Os seus números já o incluem.",
    nl: "Shopify heeft 1 dag eerdere verkopen bijgewerkt (terugbetalingen of gewijzigde bestellingen). Je cijfers houden er rekening mee.",
    pl: "Shopify zaktualizował 1 dzień wcześniejszej sprzedaży (zwroty lub edytowane zamówienia). Twoje liczby już to uwzględniają.",
  },
  "Shopify updated {n} days of past sales (refunds or order edits). Your numbers include them.": {
    es: "Shopify actualizó {n} días de ventas pasadas (reembolsos o pedidos editados). Tus números ya los incluyen.",
    fr: "Shopify a mis à jour {n} jours de ventes passées (remboursements ou commandes modifiées). Vos chiffres en tiennent compte.",
    de: "Shopify hat {n} Tage vergangener Verkäufe aktualisiert (Erstattungen oder geänderte Bestellungen). Deine Zahlen berücksichtigen das.",
    it: "Shopify ha aggiornato {n} giorni di vendite passate (rimborsi o ordini modificati). I tuoi numeri li includono.",
    pt: "A Shopify atualizou {n} dias de vendas passadas (reembolsos ou encomendas editadas). Os seus números já os incluem.",
    nl: "Shopify heeft {n} dagen eerdere verkopen bijgewerkt (terugbetalingen of gewijzigde bestellingen). Je cijfers houden er rekening mee.",
    pl: "Shopify zaktualizował sprzedaż z {n} dni wstecz (zwroty lub edytowane zamówienia). Twoje liczby już to uwzględniają.",
  },
};
