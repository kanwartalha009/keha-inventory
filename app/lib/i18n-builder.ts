/**
 * Supplier order builder (consolidated supplier purchase order, Kanwar 2026-10-17): the
 * supplier's order cycle in Settings → Suppliers, the builder page (/app/reorder/build), its
 * entry points on Order now and Next 90 days, and its plan lock. English text is the key (see
 * app/lib/i18n.tsx). Tone as the rest of the admin: German "du", French "vous", Spanish "tú",
 * European Portuguese, Dutch "je", Polish informal.
 */
import type { Tr } from "./i18n";

export const BUILDER_TR: Record<string, Tr> = {
  // ---- Settings → Suppliers: order cycle ----
  "Order every": { es: "Pedir cada", fr: "Commander tous les", de: "Bestellen alle", it: "Ordina ogni", pt: "Encomendar a cada", nl: "Bestellen elke", pl: "Zamawiaj co" },
  "Order every {n} days": { es: "Pedido cada {n} días", fr: "Commande tous les {n} jours", de: "Bestellung alle {n} Tage", it: "Ordine ogni {n} giorni", pt: "Encomenda a cada {n} dias", nl: "Bestelling elke {n} dagen", pl: "Zamówienie co {n} dni" },
  "How often you place an order with this supplier. Leave empty to use your store's order cycle ({n} days).": {
    es: "Cada cuánto haces un pedido a este proveedor. Déjalo vacío para usar el ciclo de pedidos de tu tienda ({n} días).",
    fr: "La fréquence à laquelle vous passez commande auprès de ce fournisseur. Laissez vide pour utiliser le cycle de commande de votre boutique ({n} jours).",
    de: "Wie oft du bei diesem Lieferanten bestellst. Leer lassen, um den Bestellzyklus deines Shops zu verwenden ({n} Tage).",
    it: "Ogni quanto fai un ordine a questo fornitore. Lascia vuoto per usare il ciclo degli ordini del negozio ({n} giorni).",
    pt: "Com que frequência faz uma encomenda a este fornecedor. Deixe vazio para usar o ciclo de encomendas da sua loja ({n} dias).",
    nl: "Hoe vaak je bij deze leverancier bestelt. Laat leeg om de bestelcyclus van je winkel te gebruiken ({n} dagen).",
    pl: "Jak często składasz zamówienie u tego dostawcy. Zostaw puste, aby użyć cyklu zamówień sklepu ({n} dni).",
  },
  "How often you place an order with this supplier. Leave empty to use your store's order cycle.": {
    es: "Cada cuánto haces un pedido a este proveedor. Déjalo vacío para usar el ciclo de pedidos de tu tienda.",
    fr: "La fréquence à laquelle vous passez commande auprès de ce fournisseur. Laissez vide pour utiliser le cycle de commande de votre boutique.",
    de: "Wie oft du bei diesem Lieferanten bestellst. Leer lassen, um den Bestellzyklus deines Shops zu verwenden.",
    it: "Ogni quanto fai un ordine a questo fornitore. Lascia vuoto per usare il ciclo degli ordini del negozio.",
    pt: "Com que frequência faz uma encomenda a este fornecedor. Deixe vazio para usar o ciclo de encomendas da sua loja.",
    nl: "Hoe vaak je bij deze leverancier bestelt. Laat leeg om de bestelcyclus van je winkel te gebruiken.",
    pl: "Jak często składasz zamówienie u tego dostawcy. Zostaw puste, aby użyć cyklu zamówień sklepu.",
  },
};
