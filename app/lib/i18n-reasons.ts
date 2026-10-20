/**
 * Action-list reasons (spec §7.7, ACTION_REASONS in app/lib/actions-shared.ts) and the
 * engine's safety-level setting (Settings → Defaults, spec §5.5). English text is the key
 * (see app/lib/i18n.tsx); every {placeholder} is kept. Tone: German "du", French "vous",
 * Spanish "tú", European Portuguese, Dutch "je", Polish informal.
 */
import type { Tr } from "./i18n";

export const REASONS_TR: Record<string, Tr> = {
  // ---- Action reasons ----
  "Runs out in {days} days; a new order takes {lead} days to arrive. Order by {date}.": {
    es: "Se agota en {days} días; un pedido nuevo tarda {lead} días en llegar. Pide antes del {date}.",
    fr: "Rupture dans {days} jours ; une nouvelle commande met {lead} jours à arriver. Commandez avant le {date}.",
    de: "Ist in {days} Tagen ausverkauft; eine neue Bestellung braucht {lead} Tage. Bestelle bis {date}.",
    it: "Si esaurisce tra {days} giorni; un nuovo ordine impiega {lead} giorni ad arrivare. Ordina entro il {date}.",
    pt: "Esgota dentro de {days} dias; uma nova encomenda demora {lead} dias a chegar. Encomende até {date}.",
    nl: "Is over {days} dagen op; een nieuwe bestelling duurt {lead} dagen. Bestel uiterlijk {date}.",
    pl: "Skończy się za {days} dni; nowe zamówienie dociera w {lead} dni. Zamów do {date}.",
  },
  "Runs out in {days} days; a new order takes {lead} days to arrive. Order now.": {
    es: "Se agota en {days} días; un pedido nuevo tarda {lead} días en llegar. Pide ya.",
    fr: "Rupture dans {days} jours ; une nouvelle commande met {lead} jours à arriver. Commandez maintenant.",
    de: "Ist in {days} Tagen ausverkauft; eine neue Bestellung braucht {lead} Tage. Bestelle jetzt.",
    it: "Si esaurisce tra {days} giorni; un nuovo ordine impiega {lead} giorni ad arrivare. Ordina ora.",
    pt: "Esgota dentro de {days} dias; uma nova encomenda demora {lead} dias a chegar. Encomende já.",
    nl: "Is over {days} dagen op; een nieuwe bestelling duurt {lead} dagen. Bestel nu.",
    pl: "Skończy się za {days} dni; nowe zamówienie dociera w {lead} dni. Zamów teraz.",
  },
  "Out of stock. It sells {rate} a day while in stock.": { es: "Sin stock. Vende {rate} al día cuando hay stock.", fr: "En rupture. Il se vend {rate} par jour quand il est en stock.", de: "Nicht vorrätig. Verkauft sich {rate} pro Tag, solange es vorrätig ist.", it: "Esaurito. Vende {rate} al giorno quando è disponibile.", pt: "Sem stock. Vende {rate} por dia quando há stock.", nl: "Niet op voorraad. Verkoopt {rate} per dag zolang het op voorraad is.", pl: "Brak w magazynie. Sprzedaje się {rate} dziennie, gdy jest na stanie." },
  "Runs out {gap} days before new stock arrives on {date}.": {
    es: "Se agota {gap} días antes de que llegue el stock nuevo, el {date}.",
    fr: "Rupture {gap} jours avant l'arrivée du nouveau stock, le {date}.",
    de: "Ist {gap} Tage vor der neuen Ware ({date}) ausverkauft.",
    it: "Si esaurisce {gap} giorni prima che arrivi la nuova merce, il {date}.",
    pt: "Esgota {gap} dias antes de chegar o stock novo, a {date}.",
    nl: "Is {gap} dagen op voordat de nieuwe voorraad op {date} binnenkomt.",
    pl: "Skończy się {gap} dni przed dostawą nowego towaru ({date}).",
  },
  "Out of stock for about {gap} more days, until new stock arrives on {date}.": { es: "Sin stock durante unos {gap} días más, hasta que llegue el stock nuevo el {date}.", fr: "En rupture pendant encore {gap} jours environ, jusqu'à l'arrivée du nouveau stock le {date}.", de: "Noch etwa {gap} Tage nicht vorrätig, bis die neue Ware am {date} kommt.", it: "Esaurito per circa altri {gap} giorni, finché arriva la nuova merce il {date}.", pt: "Sem stock durante cerca de mais {gap} dias, até chegar o stock novo a {date}.", nl: "Nog ongeveer {gap} dagen niet op voorraad, tot de nieuwe voorraad op {date} binnenkomt.", pl: "Brak w magazynie jeszcze przez około {gap} dni, do dostawy nowego towaru ({date})." },
  "Sales are up {pct}% on last year and it has enough stock. Feature it to sell more.": { es: "Las ventas suben un {pct}% respecto al año pasado y tiene stock suficiente. Destácalo para vender más.", fr: "Les ventes progressent de {pct} % sur un an et le stock est suffisant. Mettez-le en avant pour vendre plus.", de: "Der Umsatz liegt {pct} % über dem Vorjahr und der Bestand reicht. Stell es heraus, um mehr zu verkaufen.", it: "Le vendite sono in crescita del {pct}% sull'anno scorso e la scorta è sufficiente. Mettilo in evidenza per vendere di più.", pt: "As vendas sobem {pct}% face ao ano passado e tem stock suficiente. Destaque-o para vender mais.", nl: "De verkoop ligt {pct}% hoger dan vorig jaar en er is genoeg voorraad. Zet het in de kijker om meer te verkopen.", pl: "Sprzedaż jest o {pct}% wyższa niż rok temu, a zapasu wystarczy. Wyróżnij produkt, by sprzedać więcej." },
  "One of your best sellers, with enough stock. Feature it to sell more.": { es: "Uno de tus productos más vendidos, con stock suficiente. Destácalo para vender más.", fr: "L'une de vos meilleures ventes, avec un stock suffisant. Mettez-la en avant pour vendre plus.", de: "Einer deiner Bestseller, mit genug Bestand. Stell ihn heraus, um mehr zu verkaufen.", it: "Uno dei tuoi prodotti più venduti, con scorta sufficiente. Mettilo in evidenza per vendere di più.", pt: "Um dos seus produtos mais vendidos, com stock suficiente. Destaque-o para vender mais.", nl: "Een van je bestsellers, met genoeg voorraad. Zet het in de kijker om meer te verkopen.", pl: "Jeden z Twoich bestsellerów, z wystarczającym zapasem. Wyróżnij go, by sprzedać więcej." },
  "{conv}% of visitors buy it (store median {median}%), but it is overstocked. Send it more traffic.": { es: "El {conv}% de los visitantes lo compra (mediana de la tienda: {median}%), pero tiene exceso de stock. Llévale más tráfico.", fr: "{conv} % des visiteurs l'achètent (médiane de la boutique : {median} %), mais il est en surstock. Envoyez-lui plus de trafic.", de: "{conv} % der Besucher kaufen es (Median des Shops: {median} %), aber es hat Überbestand. Schick mehr Besucher dorthin.", it: "Il {conv}% dei visitatori lo compra (mediana del negozio: {median}%), ma ha un eccesso di scorte. Portagli più traffico.", pt: "{conv}% dos visitantes compram-no (mediana da loja: {median}%), mas tem excesso de stock. Envie-lhe mais tráfego.", nl: "{conv}% van de bezoekers koopt het (mediaan van de winkel: {median}%), maar er is overvoorraad. Stuur er meer verkeer naartoe.", pl: "{conv}% odwiedzających go kupuje (mediana sklepu: {median}%), ale ma nadmiar zapasu. Skieruj na niego więcej ruchu." },
  "Sales are down {pct}% on the same weeks last year, when it was one of your top 20 products.": {
    es: "Las ventas bajan un {pct}% respecto a las mismas semanas del año pasado, cuando era uno de tus 20 mejores productos.",
    fr: "Les ventes baissent de {pct} % par rapport aux mêmes semaines l'an dernier, quand c'était l'un de vos 20 meilleurs produits.",
    de: "Der Umsatz liegt {pct} % unter denselben Wochen im Vorjahr, als es zu deinen Top 20 gehörte.",
    it: "Le vendite sono in calo del {pct}% rispetto alle stesse settimane dell'anno scorso, quando era tra i tuoi 20 prodotti migliori.",
    pt: "As vendas descem {pct}% face às mesmas semanas do ano passado, quando era um dos seus 20 melhores produtos.",
    nl: "De verkoop ligt {pct}% lager dan in dezelfde weken vorig jaar, toen het bij je top 20 hoorde.",
    pl: "Sprzedaż spadła o {pct}% względem tych samych tygodni rok temu, gdy był w Twoim top 20.",
  },
  "{out} of {total} variants are out of stock while the product still sells.": { es: "{out} de {total} variantes están sin stock mientras el producto sigue vendiéndose.", fr: "{out} variantes sur {total} sont en rupture alors que le produit se vend encore.", de: "{out} von {total} Varianten sind nicht vorrätig, obwohl sich das Produkt noch verkauft.", it: "{out} varianti su {total} sono esaurite mentre il prodotto continua a vendere.", pt: "{out} de {total} variantes estão sem stock enquanto o produto continua a vender.", nl: "{out} van de {total} varianten zijn niet op voorraad terwijl het product nog verkoopt.", pl: "{out} z {total} wariantów nie ma w magazynie, choć produkt nadal się sprzedaje." },
  "{conv}% of visitors who land on this page buy, against {median}% for products at a similar price.": {
    es: "Compra el {conv}% de los visitantes que llegan a esta página, frente al {median}% en productos de precio similar.",
    fr: "{conv} % des visiteurs arrivant sur cette page achètent, contre {median} % pour les produits à prix similaire.",
    de: "{conv} % der Besucher, die auf dieser Seite landen, kaufen – bei Produkten mit ähnlichem Preis sind es {median} %.",
    it: "Compra il {conv}% dei visitatori che arrivano su questa pagina, contro il {median}% per prodotti di prezzo simile.",
    pt: "Compram {conv}% dos visitantes que chegam a esta página, contra {median}% em produtos de preço semelhante.",
    nl: "{conv}% van de bezoekers die op deze pagina landen koopt, tegenover {median}% bij producten met een vergelijkbare prijs.",
    pl: "Kupuje {conv}% odwiedzających, którzy trafiają na tę stronę, wobec {median}% przy produktach w podobnej cenie.",
  },
  "{pct}% of units sold come back, against {median}% across your store.": {
    es: "Se devuelve el {pct}% de las unidades vendidas, frente al {median}% en toda tu tienda.",
    fr: "{pct} % des unités vendues sont retournées, contre {median} % pour l'ensemble de votre boutique.",
    de: "{pct} % der verkauften Einheiten kommen zurück – im ganzen Shop sind es {median} %.",
    it: "Torna indietro il {pct}% delle unità vendute, contro il {median}% in tutto il negozio.",
    pt: "São devolvidas {pct}% das unidades vendidas, contra {median}% em toda a loja.",
    nl: "{pct}% van de verkochte stuks komt terug, tegenover {median}% in je hele winkel.",
    pl: "Wraca {pct}% sprzedanych sztuk, wobec {median}% w całym sklepie.",
  },
  "No sale for {days} days; {units} units are sitting in stock.": {
    es: "Sin ventas desde hace {days} días; hay {units} unidades paradas en stock.",
    fr: "Aucune vente depuis {days} jours ; {units} unités dorment en stock.",
    de: "Seit {days} Tagen kein Verkauf; {units} Einheiten liegen im Lager.",
    it: "Nessuna vendita da {days} giorni; {units} unità sono ferme in magazzino.",
    pt: "Sem vendas há {days} dias; há {units} unidades paradas em stock.",
    nl: "Al {days} dagen geen verkoop; er liggen {units} stuks op voorraad.",
    pl: "Brak sprzedaży od {days} dni; {units} szt. leży w magazynie.",
  },
  "{days} days of stock left at the current pace, far more than you need.": {
    es: "Quedan {days} días de stock al ritmo actual, mucho más de lo que necesitas.",
    fr: "{days} jours de stock restants au rythme actuel, bien plus que nécessaire.",
    de: "Beim aktuellen Tempo reicht der Bestand noch {days} Tage – weit mehr als nötig.",
    it: "Restano {days} giorni di scorta al ritmo attuale, molto più del necessario.",
    pt: "Restam {days} dias de stock ao ritmo atual, muito mais do que precisa.",
    nl: "Nog {days} dagen voorraad in het huidige tempo, veel meer dan je nodig hebt.",
    pl: "Zapasu zostało na {days} dni przy obecnym tempie – znacznie więcej, niż potrzeba.",
  },
  "No recent sales, and the stock isn't moving.": {
    es: "Sin ventas recientes y el stock no se mueve.",
    fr: "Aucune vente récente, et le stock ne bouge pas.",
    de: "Keine Verkäufe in letzter Zeit, der Bestand bewegt sich nicht.",
    it: "Nessuna vendita recente e la scorta non si muove.",
    pt: "Sem vendas recentes, e o stock não sai.",
    nl: "Geen recente verkopen en de voorraad beweegt niet.",
    pl: "Brak ostatnich sprzedaży, a zapas się nie rusza.",
  },

  // ---- Settings → Defaults: safety level (spec §5.5) ----
  "Low": { es: "Bajo", fr: "Faible", de: "Niedrig", it: "Basso", pt: "Baixo", nl: "Laag", pl: "Niski" },
  "Standard": { es: "Estándar", fr: "Moyen", de: "Mittel", it: "Medio", pt: "Padrão", nl: "Standaard", pl: "Standardowy" },
  "High": { es: "Alto", fr: "Élevé", de: "Hoch", it: "Alto", pt: "Alto", nl: "Hoog", pl: "Wysoki" },
  "Extra stock for surprises in demand: High runs out less often but ties up more cash, Low the opposite.": { es: "Stock extra para imprevistos de demanda: Alto se agota menos pero inmoviliza más dinero; Bajo, lo contrario.", fr: "Stock supplémentaire pour les imprévus de demande : Élevé tombe moins en rupture mais immobilise plus de trésorerie, Faible l'inverse.", de: "Zusatzbestand für Nachfragespitzen: Hoch ist seltener nicht vorrätig, bindet aber mehr Kapital, Niedrig umgekehrt.", it: "Scorta extra per gli imprevisti della domanda: Alto si esaurisce meno ma immobilizza più liquidità, Basso il contrario.", pt: "Stock extra para imprevistos na procura: Alto esgota menos mas prende mais dinheiro, Baixo o contrário.", nl: "Extra voorraad voor onverwachte vraag: Hoog is minder vaak niet op voorraad maar legt meer geld vast, Laag omgekeerd.", pl: "Dodatkowy zapas na niespodziewany popyt: Wysoki rzadziej się kończy, ale zamraża więcej gotówki, Niski odwrotnie." },
  "Stock lasts {days} days and more is already on order. Order the next batch by {date}.": { es: "Hay stock para {days} días y ya hay más pedido. Haz el próximo pedido antes del {date}.", fr: "Le stock tient {days} jours et d'autres unités sont déjà commandées. Passez la prochaine commande avant le {date}.", de: "Der Bestand reicht {days} Tage, und mehr ist schon bestellt. Bestelle die nächste Lieferung bis {date}.", it: "La scorta dura {days} giorni e altra merce è già ordinata. Fai il prossimo ordine entro il {date}.", pt: "O stock dura {days} dias e já há mais encomendado. Faça a próxima encomenda até {date}.", nl: "De voorraad is goed voor {days} dagen en er is al meer besteld. Bestel de volgende partij uiterlijk {date}.", pl: "Zapas wystarczy na {days} dni, a więcej jest już zamówione. Złóż kolejne zamówienie do {date}." },
  "Runs out today and more is already on order. Order the next batch by {date}.": { es: "Se agota hoy y ya hay más pedido. Haz el próximo pedido antes del {date}.", fr: "Épuisé aujourd'hui, et d'autres unités sont déjà commandées. Passez la prochaine commande avant le {date}.", de: "Heute ausverkauft, und mehr ist schon bestellt. Bestelle die nächste Lieferung bis {date}.", it: "Si esaurisce oggi e altra merce è già ordinata. Fai il prossimo ordine entro il {date}.", pt: "Esgota hoje e já há mais encomendado. Faça a próxima encomenda até {date}.", nl: "Vandaag uitverkocht en er is al meer besteld. Bestel de volgende partij uiterlijk {date}.", pl: "Skończy się dziś, a więcej jest już zamówione. Złóż kolejne zamówienie do {date}." },
  "Stock lasts 1 day and more is already on order. Order the next batch by {date}.": { es: "Hay stock para 1 día y ya hay más pedido. Haz el próximo pedido antes del {date}.", fr: "Le stock tient 1 jour et d'autres unités sont déjà commandées. Passez la prochaine commande avant le {date}.", de: "Der Bestand reicht 1 Tag, und mehr ist schon bestellt. Bestelle die nächste Lieferung bis {date}.", it: "La scorta dura 1 giorno e altra merce è già ordinata. Fai il prossimo ordine entro il {date}.", pt: "O stock dura 1 dia e já há mais encomendado. Faça a próxima encomenda até {date}.", nl: "De voorraad is goed voor 1 dag en er is al meer besteld. Bestel de volgende partij uiterlijk {date}.", pl: "Zapas wystarczy na 1 dzień, a więcej jest już zamówione. Złóż kolejne zamówienie do {date}." },
};
