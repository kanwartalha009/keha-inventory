/**
 * Order plan readiness (2026-10-17 click-through): while the store isn't ready (still reading it,
 * fewer than 14 days of sales, nothing tracked) every order-plan surface says so and why, never
 * "nothing to order". English text is the key (see app/lib/i18n.tsx). Tone: German "du", French
 * "vous", Spanish "tú", European Portuguese, Dutch "je", Polish informal.
 */
import type { Tr } from "./i18n";

export const READINESS_TR: Record<string, Tr> = {
  "Your order plan isn't ready yet": {
    es: "Tu plan de pedidos aún no está listo",
    fr: "Votre plan de commandes n'est pas encore prêt",
    de: "Dein Bestellplan ist noch nicht fertig",
    it: "Il tuo piano ordini non è ancora pronto",
    pt: "O seu plano de encomendas ainda não está pronto",
    nl: "Je bestelplan is nog niet klaar",
    pl: "Twój plan zamówień nie jest jeszcze gotowy",
  },
  "Still reading your store: {pct}.": {
    es: "Todavía estamos leyendo tu tienda: {pct}.",
    fr: "Nous lisons encore votre boutique : {pct}.",
    de: "Wir lesen deinen Shop noch: {pct}.",
    it: "Stiamo ancora leggendo il tuo negozio: {pct}.",
    pt: "Ainda estamos a ler a sua loja: {pct}.",
    nl: "We lezen je winkel nog in: {pct}.",
    pl: "Wciąż odczytujemy Twój sklep: {pct}.",
  },
  "Still reading your store: {pct}. Your first order plan appears once your products, stock and sales are read.": {
    es: "Todavía estamos leyendo tu tienda: {pct}. Tu primer plan de pedidos aparecerá cuando hayamos leído tus productos, stock y ventas.",
    fr: "Nous lisons encore votre boutique : {pct}. Votre premier plan de commandes s'affichera une fois vos produits, stocks et ventes lus.",
    de: "Wir lesen deinen Shop noch: {pct}. Dein erster Bestellplan erscheint, sobald deine Produkte, Bestände und Verkäufe gelesen sind.",
    it: "Stiamo ancora leggendo il tuo negozio: {pct}. Il tuo primo piano ordini apparirà quando avremo letto prodotti, stock e vendite.",
    pt: "Ainda estamos a ler a sua loja: {pct}. O seu primeiro plano de encomendas aparece quando os seus produtos, stock e vendas forem lidos.",
    nl: "We lezen je winkel nog in: {pct}. Je eerste bestelplan verschijnt zodra je producten, voorraad en verkopen zijn ingelezen.",
    pl: "Wciąż odczytujemy Twój sklep: {pct}. Twój pierwszy plan zamówień pojawi się, gdy odczytamy produkty, stany i sprzedaż.",
  },
  "Your first order plan needs 14 days of sales — expected on {date}.": {
    es: "Tu primer plan de pedidos necesita 14 días de ventas; previsto para el {date}.",
    fr: "Votre premier plan de commandes a besoin de 14 jours de ventes — prévu le {date}.",
    de: "Dein erster Bestellplan braucht 14 Tage Verkäufe – voraussichtlich am {date}.",
    it: "Il tuo primo piano ordini ha bisogno di 14 giorni di vendite: previsto per il {date}.",
    pt: "O seu primeiro plano de encomendas precisa de 14 dias de vendas — previsto para {date}.",
    nl: "Je eerste bestelplan heeft 14 dagen verkoop nodig — verwacht op {date}.",
    pl: "Twój pierwszy plan zamówień potrzebuje 14 dni sprzedaży — spodziewany {date}.",
  },
};
