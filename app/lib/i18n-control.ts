/**
 * Settings in plain words (S4, Kanwar 2026-10-18): "Order cycle" is now "Order enough for" — the
 * days of stock each order lasts after it arrives — and every explanation links to the setting
 * behind it. German uses "du", like the rest of the admin.
 */
import type { Tr } from "./i18n";

export const CONTROL_TR: Record<string, Tr> = {
  "Days of stock each order should last after it arrives — usually how often you order. Suggested quantities cover the lead time plus these days. You can change it for a single order.": {
    es: "Días de stock que debe durar cada pedido después de llegar; normalmente, cada cuánto pides. Las cantidades sugeridas cubren el plazo de entrega más estos días. Puedes cambiarlo para un solo pedido.",
    fr: "Jours de stock que chaque commande doit couvrir après son arrivée — en général, la fréquence de vos commandes. Les quantités suggérées couvrent le délai de livraison plus ces jours. Vous pouvez le modifier pour une seule commande.",
    de: "Wie viele Tage jede Bestellung nach dem Eintreffen reichen soll – meist, wie oft du bestellst. Die vorgeschlagenen Mengen decken die Lieferzeit plus diese Tage. Du kannst es für eine einzelne Bestellung ändern.",
    it: "Giorni di scorta che ogni ordine deve coprire dopo l'arrivo: di solito ogni quanto ordini. Le quantità suggerite coprono il tempo di consegna più questi giorni. Puoi cambiarlo per un singolo ordine.",
    pt: "Dias de stock que cada encomenda deve durar depois de chegar — normalmente, a frequência com que encomenda. As quantidades sugeridas cobrem o prazo de entrega mais estes dias. Pode alterá-lo para uma única encomenda.",
    nl: "Hoeveel dagen elke bestelling moet meegaan nadat ze binnen is — meestal hoe vaak je bestelt. De voorgestelde aantallen dekken de levertijd plus deze dagen. Je kunt dit per bestelling aanpassen.",
    pl: "Na ile dni zapasu ma wystarczyć każde zamówienie po dostawie — zwykle tak często zamawiasz. Sugerowane ilości pokrywają czas dostawy plus te dni. Możesz to zmienić dla pojedynczego zamówienia.",
  },
  "Order enough for: 1 day": { es: "Pedir para: 1 día", fr: "Commander pour : 1 jour", de: "Bestellen für: 1 Tag", it: "Ordina per: 1 giorno", pt: "Encomendar para: 1 dia", nl: "Bestellen voor: 1 dag", pl: "Zamów na: 1 dzień" },
  "Order enough for: {n} days": { es: "Pedir para: {n} días", fr: "Commander pour : {n} jours", de: "Bestellen für: {n} Tage", it: "Ordina per: {n} giorni", pt: "Encomendar para: {n} dias", nl: "Bestellen voor: {n} dagen", pl: "Zamów na: {n} dni" },
  "Days of stock each order from this supplier should last after it arrives. Leave empty to use your store's setting ({n} days).": {
    es: "Días de stock que debe durar cada pedido a este proveedor después de llegar. Déjalo vacío para usar el ajuste de tu tienda ({n} días).",
    fr: "Jours de stock que chaque commande à ce fournisseur doit couvrir après son arrivée. Laissez vide pour utiliser le réglage de votre boutique ({n} jours).",
    de: "Wie viele Tage jede Bestellung bei diesem Lieferanten nach dem Eintreffen reichen soll. Leer lassen für die Einstellung deines Shops ({n} Tage).",
    it: "Giorni di scorta che ogni ordine a questo fornitore deve coprire dopo l'arrivo. Lascia vuoto per usare l'impostazione del negozio ({n} giorni).",
    pt: "Dias de stock que cada encomenda a este fornecedor deve durar depois de chegar. Deixe vazio para usar a definição da loja ({n} dias).",
    nl: "Hoeveel dagen elke bestelling bij deze leverancier moet meegaan nadat ze binnen is. Laat leeg om de instelling van je winkel te gebruiken ({n} dagen).",
    pl: "Na ile dni zapasu ma wystarczyć każde zamówienie u tego dostawcy po dostawie. Zostaw puste, aby użyć ustawienia sklepu ({n} dni).",
  },
  "Days of stock each order from this supplier should last after it arrives. Leave empty to use your store's setting.": {
    es: "Días de stock que debe durar cada pedido a este proveedor después de llegar. Déjalo vacío para usar el ajuste de tu tienda.",
    fr: "Jours de stock que chaque commande à ce fournisseur doit couvrir après son arrivée. Laissez vide pour utiliser le réglage de votre boutique.",
    de: "Wie viele Tage jede Bestellung bei diesem Lieferanten nach dem Eintreffen reichen soll. Leer lassen für die Einstellung deines Shops.",
    it: "Giorni di scorta che ogni ordine a questo fornitore deve coprire dopo l'arrivo. Lascia vuoto per usare l'impostazione del negozio.",
    pt: "Dias de stock que cada encomenda a este fornecedor deve durar depois de chegar. Deixe vazio para usar a definição da loja.",
    nl: "Hoeveel dagen elke bestelling bij deze leverancier moet meegaan nadat ze binnen is. Laat leeg om de instelling van je winkel te gebruiken.",
    pl: "Na ile dni zapasu ma wystarczyć każde zamówienie u tego dostawcy po dostawie. Zostaw puste, aby użyć ustawienia sklepu.",
  },
  "One row per supplier: lead time, transit, days per order, minimums, case pack, currency and vendors. New names are added; suppliers not in the file stay as they are.": {
    es: "Una fila por proveedor: plazo, tránsito, días por pedido, mínimos, unidades por caja, moneda y marcas. Los nombres nuevos se añaden; los proveedores que no estén en el archivo se quedan como están.",
    fr: "Une ligne par fournisseur : délai, transit, jours par commande, minimums, conditionnement, devise et fabricants. Les nouveaux noms sont ajoutés ; les fournisseurs absents du fichier restent inchangés.",
    de: "Eine Zeile pro Lieferant: Lieferzeit, Transit, Tage pro Bestellung, Mindestmengen, Kartongröße, Währung und Anbieter. Neue Namen werden hinzugefügt; Lieferanten, die nicht in der Datei stehen, bleiben, wie sie sind.",
    it: "Una riga per fornitore: tempi, transito, giorni per ordine, minimi, pezzi per confezione, valuta e marchi. I nomi nuovi vengono aggiunti; i fornitori che non sono nel file restano come sono.",
    pt: "Uma linha por fornecedor: prazo, trânsito, dias por encomenda, mínimos, unidades por caixa, moeda e marcas. Os nomes novos são adicionados; os fornecedores que não estão no ficheiro ficam como estão.",
    nl: "Eén rij per leverancier: levertijd, transport, dagen per bestelling, minimums, doosgrootte, valuta en merken. Nieuwe namen worden toegevoegd; leveranciers die niet in het bestand staan, blijven zoals ze zijn.",
    pl: "Jeden wiersz na dostawcę: czas dostawy, transport, dni na zamówienie, minima, wielkość opakowania, waluta i producenci. Nowe nazwy zostaną dodane; dostawcy spoza pliku pozostaną bez zmian.",
  },
  "Order enough for (days)": { es: "Pedir para (días)", fr: "Commander pour (jours)", de: "Bestellen für (Tage)", it: "Ordina per (giorni)", pt: "Encomendar para (dias)", nl: "Bestellen voor (dagen)", pl: "Zamów na (dni)" },
  "Days of stock each order should last after it arrives. Empty = your store's setting.": {
    es: "Días de stock que debe durar cada pedido después de llegar. Vacío = el ajuste de tu tienda.",
    fr: "Jours de stock que chaque commande doit couvrir après son arrivée. Vide = le réglage de votre boutique.",
    de: "Wie viele Tage jede Bestellung nach dem Eintreffen reichen soll. Leer = die Einstellung deines Shops.",
    it: "Giorni di scorta che ogni ordine deve coprire dopo l'arrivo. Vuoto = l'impostazione del negozio.",
    pt: "Dias de stock que cada encomenda deve durar depois de chegar. Vazio = a definição da loja.",
    nl: "Hoeveel dagen elke bestelling moet meegaan nadat ze binnen is. Leeg = de instelling van je winkel.",
    pl: "Na ile dni zapasu ma wystarczyć każde zamówienie po dostawie. Puste = ustawienie sklepu.",
  },
  "An order arrives after the lead time ({lead} days unless a supplier has its own) and lasts the days set under Order enough for, plus safety stock for surprises.": {
    es: "Un pedido llega tras el plazo de entrega ({lead} días, salvo que un proveedor tenga el suyo) y dura los días fijados en Pedir para, más un stock de seguridad para imprevistos.",
    fr: "Une commande arrive après le délai de livraison ({lead} jours, sauf si un fournisseur a le sien) et couvre les jours réglés dans Commander pour, plus un stock de sécurité pour les imprévus.",
    de: "Eine Bestellung kommt nach der Lieferzeit an ({lead} Tage, außer ein Lieferant hat eine eigene) und reicht für die Tage unter Bestellen für, plus Sicherheitsbestand für Überraschungen.",
    it: "Un ordine arriva dopo il tempo di consegna ({lead} giorni, salvo che un fornitore abbia il suo) e copre i giorni impostati in Ordina per, più una scorta di sicurezza per gli imprevisti.",
    pt: "Uma encomenda chega após o prazo de entrega ({lead} dias, salvo se um fornecedor tiver o seu) e dura os dias definidos em Encomendar para, mais um stock de segurança para imprevistos.",
    nl: "Een bestelling komt binnen na de levertijd ({lead} dagen, tenzij een leverancier een eigen levertijd heeft) en gaat mee voor de dagen bij Bestellen voor, plus veiligheidsvoorraad voor verrassingen.",
    pl: "Zamówienie przychodzi po czasie dostawy ({lead} dni, chyba że dostawca ma własny) i wystarcza na dni ustawione w Zamów na, plus zapas bezpieczeństwa na niespodzianki.",
  },
  "Change the numbers behind this:": { es: "Cambia los datos de este cálculo:", fr: "Modifier les valeurs de ce calcul :", de: "Werte dieser Rechnung ändern:", it: "Modifica i valori di questo calcolo:", pt: "Alterar os valores deste cálculo:", nl: "Wijzig de waarden achter deze berekening:", pl: "Zmień wartości tego wyliczenia:" },
  "With the days you chose, 1 supplier has nothing due this week.": { es: "Con los días que elegiste, 1 proveedor no tiene nada que pedir esta semana.", fr: "Avec les jours choisis, 1 fournisseur n'a rien à commander cette semaine.", de: "Mit den gewählten Tagen ist bei 1 Lieferanten diese Woche nichts fällig.", it: "Con i giorni scelti, 1 fornitore non ha nulla da ordinare questa settimana.", pt: "Com os dias escolhidos, 1 fornecedor não tem nada a encomendar esta semana.", nl: "Met de gekozen dagen hoeft er deze week bij 1 leverancier niets besteld te worden.", pl: "Przy wybranych dniach u 1 dostawcy nic nie jest do zamówienia w tym tygodniu." },
  "With the days you chose, {n} suppliers have nothing due this week.": { es: "Con los días que elegiste, {n} proveedores no tienen nada que pedir esta semana.", fr: "Avec les jours choisis, {n} fournisseurs n'ont rien à commander cette semaine.", de: "Mit den gewählten Tagen ist bei {n} Lieferanten diese Woche nichts fällig.", it: "Con i giorni scelti, {n} fornitori non hanno nulla da ordinare questa settimana.", pt: "Com os dias escolhidos, {n} fornecedores não têm nada a encomendar esta semana.", nl: "Met de gekozen dagen hoeft er deze week bij {n} leveranciers niets besteld te worden.", pl: "Przy wybranych dniach u {n} dostawców nic nie jest do zamówienia w tym tygodniu." },
  "Back to the plan's days": { es: "Volver a los días del plan", fr: "Revenir aux jours du plan", de: "Zurück zu den Tagen des Plans", it: "Torna ai giorni del piano", pt: "Voltar aos dias do plano", nl: "Terug naar de dagen van het plan", pl: "Wróć do dni z planu" },
  "This supplier isn't in your order plan any more.": { es: "Este proveedor ya no está en tu plan de pedidos.", fr: "Ce fournisseur ne fait plus partie de votre plan de commandes.", de: "Dieser Lieferant ist nicht mehr in deinem Bestellplan.", it: "Questo fornitore non è più nel tuo piano ordini.", pt: "Este fornecedor já não está no seu plano de encomendas.", nl: "Deze leverancier staat niet meer in je bestelplan.", pl: "Tego dostawcy nie ma już w Twoim planie zamówień." },
  "Back to Due now": { es: "Volver a Para pedir ya", fr: "Retour à À commander maintenant", de: "Zurück zu Jetzt fällig", it: "Torna a Da ordinare ora", pt: "Voltar a A encomendar já", nl: "Terug naar Nu nodig", pl: "Wróć do Do zamówienia teraz" },
};
