/**
 * The "Why" dialog of an action (spec §7.7, §12): the plain-words labels and coded values of
 * `reason.facts` (FACT_DEFS in app/lib/action-facts-shared.ts) plus the period templates.
 * Labels already translated in another area (e.g. "Order by", "Supplier lead time",
 * "Seasonal change") are not repeated here. English text is the key (see app/lib/i18n.tsx);
 * every {placeholder} is kept. Tone: German "du", French "vous", Spanish "tú",
 * European Portuguese, Dutch "je", Polish informal.
 */
import type { Tr } from "./i18n";

export const FACTS_TR: Record<string, Tr> = {
  // ---- Periods ----
  "Next {n} days": { es: "Próximos {n} días", fr: "{n} prochains jours", de: "Nächste {n} Tage", it: "Prossimi {n} giorni", pt: "Próximos {n} dias", nl: "Komende {n} dagen", pl: "Następne {n} dni" },

  // ---- Stock and sales ----
  "Variants affected": { es: "Variantes afectadas", fr: "Variantes concernées", de: "Betroffene Varianten", it: "Varianti interessate", pt: "Variantes afetadas", nl: "Betrokken varianten", pl: "Warianty, których to dotyczy" },
  "Trend vs last year": { es: "Tendencia frente al año pasado", fr: "Tendance par rapport à l'an dernier", de: "Entwicklung gegenüber dem Vorjahr", it: "Tendenza rispetto all'anno scorso", pt: "Tendência face ao ano passado", nl: "Ontwikkeling t.o.v. vorig jaar", pl: "Tendencja wobec zeszłego roku" },
  "Units to order": { es: "Unidades a pedir", fr: "Unités à commander", de: "Zu bestellende Einheiten", it: "Unità da ordinare", pt: "Unidades a encomendar", nl: "Te bestellen stuks", pl: "Sztuki do zamówienia" },
  "Price": { es: "Precio", fr: "Prix", de: "Preis", it: "Prezzo", pt: "Preço", nl: "Prijs", pl: "Cena" },
  "Days without stock": { es: "Días sin stock", fr: "Jours sans stock", de: "Tage ohne Bestand", it: "Giorni senza stock", pt: "Dias sem stock", nl: "Dagen zonder voorraad", pl: "Dni bez towaru" },
  "New stock arrives": { es: "Llega stock nuevo", fr: "Arrivée du nouveau stock", de: "Neuer Bestand kommt am", it: "Arrivo del nuovo stock", pt: "Chegada do novo stock", nl: "Nieuwe voorraad komt op", pl: "Nowy towar dotrze" },
  "Arrival date based on": { es: "Fecha de llegada según", fr: "Date d'arrivée d'après", de: "Grundlage des Ankunftsdatums", it: "Data di arrivo in base a", pt: "Data de chegada com base em", nl: "Aankomstdatum op basis van", pl: "Data dostawy na podstawie" },
  "An open purchase order": { es: "Una orden de compra abierta", fr: "Un bon de commande en cours", de: "Eine offene Bestellung", it: "Un ordine d'acquisto aperto", pt: "Uma ordem de compra em aberto", nl: "Een openstaande inkooporder", pl: "Otwarte zamówienie zakupu" },
  "The lead time, if you order today": { es: "El plazo de entrega, si pides hoy", fr: "Le délai de livraison, si vous commandez aujourd'hui", de: "Die Lieferzeit, wenn du heute bestellst", it: "I tempi di consegna, se ordini oggi", pt: "O prazo de entrega, se encomendar hoje", nl: "De levertijd, als je vandaag bestelt", pl: "Czas dostawy, jeśli zamówisz dziś" },
  "Units on purchase orders": { es: "Unidades en órdenes de compra", fr: "Unités sur des bons de commande", de: "Einheiten in Bestellungen", it: "Unità negli ordini d'acquisto", pt: "Unidades em ordens de compra", nl: "Stuks op inkooporders", pl: "Sztuki w zamówieniach zakupu" },
  "Units sold, last 28 days": { es: "Unidades vendidas, últimos 28 días", fr: "Unités vendues, 28 derniers jours", de: "Verkaufte Einheiten, letzte 28 Tage", it: "Unità vendute, ultimi 28 giorni", pt: "Unidades vendidas, últimos 28 dias", nl: "Verkochte stuks, afgelopen 28 dagen", pl: "Sprzedane sztuki, ostatnie 28 dni" },
  "Variants sold out": { es: "Variantes agotadas", fr: "Variantes en rupture", de: "Ausverkaufte Varianten", it: "Varianti esaurite", pt: "Variantes esgotadas", nl: "Uitverkochte varianten", pl: "Wyprzedane warianty" },
  "Variants estimated from the other variants": { es: "Variantes estimadas a partir de las demás", fr: "Variantes estimées d'après les autres variantes", de: "Varianten, aus den anderen Varianten geschätzt", it: "Varianti stimate dalle altre varianti", pt: "Variantes estimadas a partir das outras", nl: "Varianten geschat op basis van de andere varianten", pl: "Warianty oszacowane na podstawie pozostałych" },
  "Sales per day of the other variants": { es: "Ventas al día de las demás variantes", fr: "Ventes par jour des autres variantes", de: "Verkäufe pro Tag der anderen Varianten", it: "Vendite al giorno delle altre varianti", pt: "Vendas por dia das outras variantes", nl: "Verkopen per dag van de andere varianten", pl: "Sprzedaż dzienna pozostałych wariantów" },

  // ---- Visits ----
  "Page visits per week": { es: "Visitas a la página por semana", fr: "Visites de la page par semaine", de: "Seitenbesuche pro Woche", it: "Visite alla pagina a settimana", pt: "Visitas à página por semana", nl: "Paginabezoeken per week", pl: "Wizyty na stronie tygodniowo" },
  "Page visits, last 28 days": { es: "Visitas a la página, últimos 28 días", fr: "Visites de la page, 28 derniers jours", de: "Seitenbesuche, letzte 28 Tage", it: "Visite alla pagina, ultimi 28 giorni", pt: "Visitas à página, últimos 28 dias", nl: "Paginabezoeken, afgelopen 28 dagen", pl: "Wizyty na stronie, ostatnie 28 dni" },
  "Visits that bought, last 28 days": { es: "Visitas con compra, últimos 28 días", fr: "Visites avec achat, 28 derniers jours", de: "Besuche mit Kauf, letzte 28 Tage", it: "Visite con acquisto, ultimi 28 giorni", pt: "Visitas com compra, últimos 28 dias", nl: "Bezoeken met aankoop, afgelopen 28 dagen", pl: "Wizyty zakończone zakupem, ostatnie 28 dni" },
  "Visitors who buy": { es: "Visitantes que compran", fr: "Visiteurs qui achètent", de: "Besucher, die kaufen", it: "Visitatori che acquistano", pt: "Visitantes que compram", nl: "Bezoekers die kopen", pl: "Odwiedzający, którzy kupują" },
  "Store median": { es: "Mediana de la tienda", fr: "Médiane de la boutique", de: "Shop-Median", it: "Mediana del negozio", pt: "Mediana da loja", nl: "Winkelmediaan", pl: "Mediana sklepu" },
  "Extra sales if featured": { es: "Ventas extra si lo destacas", fr: "Ventes en plus si vous le mettez en avant", de: "Mehr Verkäufe, wenn du es hervorhebst", it: "Vendite in più se lo metti in evidenza", pt: "Vendas extra se o destacar", nl: "Extra verkopen als je het uitlicht", pl: "Dodatkowa sprzedaż po wyróżnieniu" },
  "Products at a similar price": { es: "Productos de precio similar", fr: "Produits à un prix similaire", de: "Produkte zu ähnlichem Preis", it: "Prodotti a un prezzo simile", pt: "Produtos com preço semelhante", nl: "Producten met een vergelijkbare prijs", pl: "Produkty w podobnej cenie" },
  "Average order value": { es: "Valor medio del pedido", fr: "Panier moyen", de: "Durchschnittlicher Bestellwert", it: "Valore medio dell'ordine", pt: "Valor médio da encomenda", nl: "Gemiddelde orderwaarde", pl: "Średnia wartość zamówienia" },
  "Visits counted": { es: "Visitas contadas", fr: "Visites comptées", de: "Gezählte Besuche", it: "Visite conteggiate", pt: "Visitas contadas", nl: "Getelde bezoeken", pl: "Liczone wizyty" },
  "Visits that started on this page": { es: "Visitas que empezaron en esta página", fr: "Visites qui ont commencé sur cette page", de: "Besuche, die auf dieser Seite begannen", it: "Visite iniziate su questa pagina", pt: "Visitas que começaram nesta página", nl: "Bezoeken die op deze pagina begonnen", pl: "Wizyty rozpoczęte na tej stronie" },

  // ---- Sales vs last year ----
  "Sales, last 28 days": { es: "Ventas, últimos 28 días", fr: "Ventes, 28 derniers jours", de: "Umsatz, letzte 28 Tage", it: "Vendite, ultimi 28 giorni", pt: "Vendas, últimos 28 dias", nl: "Omzet, afgelopen 28 dagen", pl: "Sprzedaż, ostatnie 28 dni" },
  "Sales, same weeks last year": { es: "Ventas, mismas semanas del año pasado", fr: "Ventes, mêmes semaines l'an dernier", de: "Umsatz, gleiche Wochen im Vorjahr", it: "Vendite, stesse settimane dell'anno scorso", pt: "Vendas, mesmas semanas do ano passado", nl: "Omzet, dezelfde weken vorig jaar", pl: "Sprzedaż, te same tygodnie rok temu" },
  "Rank by sales last year": { es: "Posición por ventas el año pasado", fr: "Rang par ventes l'an dernier", de: "Rang nach Umsatz im Vorjahr", it: "Posizione per vendite l'anno scorso", pt: "Posição por vendas no ano passado", nl: "Plaats op omzet vorig jaar", pl: "Miejsce wg sprzedaży rok temu" },

  // ---- Returns ----
  "Units returned": { es: "Unidades devueltas", fr: "Unités retournées", de: "Zurückgegebene Einheiten", it: "Unità restituite", pt: "Unidades devolvidas", nl: "Geretourneerde stuks", pl: "Zwrócone sztuki" },
  "Return rate that counts as high": { es: "Tasa de devolución que se considera alta", fr: "Taux de retour jugé élevé", de: "Retourenquote, die als hoch gilt", it: "Tasso di reso considerato alto", pt: "Taxa de devolução considerada alta", nl: "Retourpercentage dat als hoog geldt", pl: "Wskaźnik zwrotów uznawany za wysoki" },

  // ---- Clear ----
  "Variants with no recent sales": { es: "Variantes sin ventas recientes", fr: "Variantes sans ventes récentes", de: "Varianten ohne aktuelle Verkäufe", it: "Varianti senza vendite recenti", pt: "Variantes sem vendas recentes", nl: "Varianten zonder recente verkopen", pl: "Warianty bez ostatniej sprzedaży" },
  "Variants with too much stock": { es: "Variantes con demasiado stock", fr: "Variantes en surstock", de: "Varianten mit zu viel Bestand", it: "Varianti con troppo stock", pt: "Variantes com stock a mais", nl: "Varianten met te veel voorraad", pl: "Warianty z nadmiarem zapasu" },
  "Units to clear": { es: "Unidades a liquidar", fr: "Unités à écouler", de: "Abzuverkaufende Einheiten", it: "Unità da smaltire", pt: "Unidades a escoar", nl: "Op te ruimen stuks", pl: "Sztuki do wyprzedania" },
  "Valued at": { es: "Valorado a", fr: "Valorisé au", de: "Bewertet zum", it: "Valutato al", pt: "Avaliado ao", nl: "Gewaardeerd tegen", pl: "Wyceniono według" },
  "Cost price": { es: "Precio de coste", fr: "Prix de revient", de: "Einkaufspreis", it: "Prezzo di costo", pt: "Preço de custo", nl: "Kostprijs", pl: "Ceny zakupu" },
  "Retail price": { es: "Precio de venta", fr: "Prix de vente", de: "Verkaufspreis", it: "Prezzo di vendita", pt: "Preço de venda", nl: "Verkoopprijs", pl: "Ceny sprzedaży" },
  "Stock you need": { es: "Stock que necesitas", fr: "Stock nécessaire", de: "Benötigter Bestand", it: "Stock che ti serve", pt: "Stock de que precisa", nl: "Voorraad die je nodig hebt", pl: "Potrzebny zapas" },
};
