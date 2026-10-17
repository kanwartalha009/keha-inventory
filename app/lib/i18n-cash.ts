/**
 * Supplier module (Kanwar 2026-10-17): the product's supplier code and the size-grid purchase
 * order. English text is the key (see app/lib/i18n.tsx). Tone as the rest of the admin: German
 * "du", French "vous", Spanish "tú", European Portuguese, Dutch "je", Polish informal.
 */
import type { Tr } from "./i18n";

export const CASH_TR: Record<string, Tr> = {
  // ---- Supplier code (product page) and the size-grid purchase order ----
  "Supplier code": { es: "Código del proveedor", fr: "Référence fournisseur", de: "Lieferanten-Artikelnummer", it: "Codice fornitore", pt: "Código do fornecedor", nl: "Leverancierscode", pl: "Kod dostawcy" },
  "The supplier's article or style number for this product. Shown on purchase orders. Leave empty to use the start of the SKUs.": {
    es: "El número de artículo o modelo del proveedor para este producto. Aparece en los pedidos de compra. Déjalo vacío para usar el inicio de los SKU.",
    fr: "La référence article ou modèle du fournisseur pour ce produit. Affichée sur les bons de commande. Laissez vide pour utiliser le début des SKU.",
    de: "Die Artikel- oder Modellnummer des Lieferanten für dieses Produkt. Steht auf den Bestellungen. Leer lassen, um den Anfang der SKUs zu verwenden.",
    it: "Il codice articolo o modello del fornitore per questo prodotto. Compare negli ordini d'acquisto. Lascia vuoto per usare l'inizio degli SKU.",
    pt: "A referência de artigo ou modelo do fornecedor para este produto. Aparece nas encomendas. Deixe vazio para usar o início dos SKU.",
    nl: "Het artikel- of modelnummer van de leverancier voor dit product. Staat op inkooporders. Laat leeg om het begin van de SKU's te gebruiken.",
    pl: "Numer artykułu lub modelu dostawcy dla tego produktu. Widoczny na zamówieniach. Zostaw puste, aby użyć początku kodów SKU.",
  },
  "Use up to 64 characters.": { es: "Usa hasta 64 caracteres.", fr: "64 caractères maximum.", de: "Höchstens 64 Zeichen.", it: "Usa fino a 64 caratteri.", pt: "Use até 64 caracteres.", nl: "Gebruik maximaal 64 tekens.", pl: "Użyj maksymalnie 64 znaków." },
  "Download CSV (size grid)": { es: "Descargar CSV (tabla de tallas)", fr: "Télécharger le CSV (grille de tailles)", de: "CSV herunterladen (Größenraster)", it: "Scarica CSV (griglia taglie)", pt: "Transferir CSV (grelha de tamanhos)", nl: "CSV downloaden (maatraster)", pl: "Pobierz CSV (siatka rozmiarów)" },
  "Style code": { es: "Referencia", fr: "Référence", de: "Artikelnummer", it: "Codice articolo", pt: "Referência", nl: "Artikelcode", pl: "Kod artykułu" },
  "Total units": { es: "Unidades totales", fr: "Unités au total", de: "Stück gesamt", it: "Unità totali", pt: "Unidades no total", nl: "Totaal stuks", pl: "Razem sztuk" },
  Totals: { es: "Totales", fr: "Totaux", de: "Summe", it: "Totali", pt: "Totais", nl: "Totalen", pl: "Razem" },
};
