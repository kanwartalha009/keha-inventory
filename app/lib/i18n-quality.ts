/**
 * Forecast quality translations (R4): unusual (spike) days capped, "Plan like…" for new
 * products, sales channels left out of the forecast, and the per-warehouse sales note.
 * English text is the key (see app/lib/i18n.tsx). Tone: German "du", French "vous", Spanish
 * "tú", European Portuguese, Dutch "je", Polish informal.
 */
import type { Tr } from "./i18n";

export const QUALITY_TR: Record<string, Tr> = {
  // ---- Products: a warehouse in the supplier-order pool ----
  "One row per variant this warehouse carries. Shopify doesn't report which warehouse shipped an online order, so its sales per day are its share of online sales by the stock it holds. Supplier orders are planned once for every warehouse they count.": {
    es: "Una fila por variante que tiene este almacén. Shopify no indica qué almacén envió un pedido online, así que sus ventas por día son su parte de las ventas online según el stock que tiene. Los pedidos a proveedores se planifican una vez para todos los almacenes que cuentan.",
    fr: "Une ligne par variante présente dans cet entrepôt. Shopify n'indique pas quel entrepôt a expédié une commande en ligne : ses ventes par jour sont donc sa part des ventes en ligne selon le stock qu'il détient. Les commandes fournisseurs sont planifiées une seule fois pour tous les entrepôts qu'elles comptent.",
    de: "Eine Zeile pro Variante, die dieses Lager führt. Shopify meldet nicht, welches Lager eine Online-Bestellung versendet hat, daher sind seine Verkäufe pro Tag sein Anteil an den Online-Verkäufen nach dem Bestand, den es hält. Lieferantenbestellungen werden einmal für alle Lager geplant, die sie zählen.",
    it: "Una riga per variante presente in questo magazzino. Shopify non indica quale magazzino ha spedito un ordine online, quindi le sue vendite al giorno sono la sua quota delle vendite online in base allo stock che detiene. Gli ordini ai fornitori sono pianificati una sola volta per tutti i magazzini che contano.",
    pt: "Uma linha por variante que este armazém tem. A Shopify não indica que armazém enviou uma encomenda online, por isso as vendas por dia são a sua parte das vendas online de acordo com o stock que tem. As encomendas a fornecedores são planeadas uma vez para todos os armazéns que contam.",
    nl: "Eén rij per variant die dit magazijn voert. Shopify meldt niet welk magazijn een online bestelling heeft verzonden, dus de verkopen per dag zijn het aandeel van dit magazijn in de online verkopen naar de voorraad die het heeft. Leveranciersbestellingen worden één keer gepland voor alle magazijnen die meetellen.",
    pl: "Jeden wiersz na wariant, który ma ten magazyn. Shopify nie podaje, który magazyn wysłał zamówienie online, więc jego sprzedaż dziennie to jego udział w sprzedaży online według posiadanego stanu. Zamówienia u dostawców planowane są raz dla wszystkich magazynów, które się w nich liczą.",
  },
};
