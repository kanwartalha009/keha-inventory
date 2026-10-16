/**
 * Reorder, suppliers and purchase orders (task 2.2, spec §5.3, §5.5, §14):
 * the Reorder screen, the order page, Settings → Suppliers, the supplier
 * email / PDF / CSV and the public supplier page. English text is the key
 * (see app/lib/i18n.tsx).
 *
 * Tone: the admin follows the app's convention (German "du", French "vous",
 * Spanish "tú", European Portuguese, Dutch "je", Polish informal). Text a
 * supplier reads (email, PDF, supplier page) is business correspondence and
 * uses the polite form (German "Sie", Spanish "usted", Dutch "u", Polish
 * "Państwo", Italian "Lei").
 */
import type { Tr } from "./i18n";

export const REORDER_TR: Record<string, Tr> = {
  // ---- Reorder screen ----
  "No vendor": {
    es: "Sin marca",
    fr: "Sans marque",
    de: "Kein Anbieter",
    it: "Nessuna marca",
    pt: "Sem marca",
    nl: "Geen merk",
    pl: "Brak producenta",
  },

  // ---- Open orders and order page ----
  "Draft": { es: "Borrador", fr: "Brouillon", de: "Entwurf", it: "Bozza", pt: "Rascunho", nl: "Concept", pl: "Szkic" },
  "Sent": { es: "Enviado", fr: "Envoyée", de: "Gesendet", it: "Inviato", pt: "Enviada", nl: "Verzonden", pl: "Wysłane" },
  "Confirmed": { es: "Confirmado", fr: "Confirmée", de: "Bestätigt", it: "Confermato", pt: "Confirmada", nl: "Bevestigd", pl: "Potwierdzone" },
  "Received": { es: "Recibido", fr: "Reçue", de: "Erhalten", it: "Ricevuto", pt: "Recebida", nl: "Ontvangen", pl: "Przyjęte" },
  "Cancelled": { es: "Cancelado", fr: "Annulée", de: "Storniert", it: "Annullato", pt: "Cancelada", nl: "Geannuleerd", pl: "Anulowane" },

  // ---- Settings → Suppliers ----
  "Currency": { es: "Moneda", fr: "Devise", de: "Währung", it: "Valuta", pt: "Moeda", nl: "Valuta", pl: "Waluta" },
  "Enter the supplier's name.": {
    es: "Escribe el nombre del proveedor.",
    fr: "Saisissez le nom du fournisseur.",
    de: "Gib den Namen des Lieferanten ein.",
    it: "Inserisci il nome del fornitore.",
    pt: "Indique o nome do fornecedor.",
    nl: "Vul de naam van de leverancier in.",
    pl: "Wpisz nazwę dostawcy.",
  },
  "Use up to 100 characters.": {
    es: "Usa hasta 100 caracteres.",
    fr: "Utilisez 100 caractères au maximum.",
    de: "Höchstens 100 Zeichen.",
    it: "Usa al massimo 100 caratteri.",
    pt: "Use até 100 caracteres.",
    nl: "Gebruik maximaal 100 tekens.",
    pl: "Użyj maksymalnie 100 znaków.",
  },
  "You already have a supplier with this name.": {
    es: "Ya tienes un proveedor con este nombre.",
    fr: "Vous avez déjà un fournisseur portant ce nom.",
    de: "Du hast schon einen Lieferanten mit diesem Namen.",
    it: "Hai già un fornitore con questo nome.",
    pt: "Já tem um fornecedor com este nome.",
    nl: "Je hebt al een leverancier met deze naam.",
    pl: "Masz już dostawcę o tej nazwie.",
  },
  "Check the email address.": {
    es: "Revisa la dirección de email.",
    fr: "Vérifiez l'adresse e-mail.",
    de: "Prüfe die E-Mail-Adresse.",
    it: "Controlla l'indirizzo email.",
    pt: "Verifique o endereço de email.",
    nl: "Controleer het e-mailadres.",
    pl: "Sprawdź adres e-mail.",
  },
  "Use a 3-letter currency code, like EUR.": {
    es: "Usa un código de moneda de 3 letras, como EUR.",
    fr: "Utilisez un code de devise à 3 lettres, comme EUR.",
    de: "Verwende einen 3-stelligen Währungscode wie EUR.",
    it: "Usa un codice valuta di 3 lettere, come EUR.",
    pt: "Use um código de moeda de 3 letras, como EUR.",
    nl: "Gebruik een valutacode van 3 letters, zoals EUR.",
    pl: "Użyj 3-literowego kodu waluty, np. EUR.",
  },
  "Pick up to 50 vendors.": {
    es: "Elige hasta 50 marcas.",
    fr: "Choisissez jusqu'à 50 marques.",
    de: "Wähle höchstens 50 Anbieter.",
    it: "Scegli al massimo 50 marche.",
    pt: "Escolha até 50 marcas.",
    nl: "Kies maximaal 50 merken.",
    pl: "Wybierz maksymalnie 50 producentów.",
  },

  // ---- What the supplier reads: email, PDF, CSV, supplier page (polite form) ----
  "Purchase order {number} from {store}": {
    es: "Pedido de compra {number} de {store}",
    fr: "Bon de commande {number} de {store}",
    de: "Bestellung {number} von {store}",
    it: "Ordine d'acquisto {number} da {store}",
    pt: "Encomenda {number} de {store}",
    nl: "Inkooporder {number} van {store}",
    pl: "Zamówienie zakupu {number} od {store}",
  },
  "Hello {name},": { es: "Hola, {name}:", fr: "Bonjour {name},", de: "Guten Tag {name},", it: "Buongiorno {name},", pt: "Olá {name},", nl: "Beste {name},", pl: "Dzień dobry {name}," },
  "Hello,": { es: "Hola:", fr: "Bonjour,", de: "Guten Tag,", it: "Buongiorno,", pt: "Olá,", nl: "Beste leverancier,", pl: "Dzień dobry," },
  "{store} would like to order the items below.": {
    es: "{store} desea pedir los siguientes artículos.",
    fr: "{store} souhaite commander les articles ci-dessous.",
    de: "{store} möchte die folgenden Artikel bestellen.",
    it: "{store} desidera ordinare gli articoli qui sotto.",
    pt: "{store} gostaria de encomendar os artigos abaixo.",
    nl: "{store} wil de onderstaande artikelen bestellen.",
    pl: "{store} chce zamówić poniższe pozycje.",
  },
  "Please confirm the ship date with the link below. You can also download the order as a PDF there.": {
    es: "Le rogamos que confirme la fecha de envío con el enlace de abajo. Allí también puede descargar el pedido en PDF.",
    fr: "Merci de confirmer la date d'expédition via le lien ci-dessous. Vous pouvez aussi y télécharger la commande en PDF.",
    de: "Bitte bestätigen Sie das Versanddatum über den Link unten. Dort können Sie die Bestellung auch als PDF herunterladen.",
    it: "La preghiamo di confermare la data di spedizione con il link qui sotto. Lì può anche scaricare l'ordine in PDF.",
    pt: "Por favor confirme a data de envio através da ligação abaixo. Também pode transferir a encomenda em PDF.",
    nl: "Bevestig de verzenddatum via de link hieronder. Daar kunt u de bestelling ook als pdf downloaden.",
    pl: "Prosimy o potwierdzenie daty wysyłki przez poniższy link. Można tam też pobrać zamówienie w PDF.",
  },
  "Total units: {n}": { es: "Unidades totales: {n}", fr: "Total des unités : {n}", de: "Einheiten gesamt: {n}", it: "Unità totali: {n}", pt: "Total de unidades: {n}", nl: "Totaal aantal stuks: {n}", pl: "Łącznie sztuk: {n}" },
  "Total cost: {amount}": { es: "Coste total: {amount}", fr: "Coût total : {amount}", de: "Gesamtkosten: {amount}", it: "Costo totale: {amount}", pt: "Custo total: {amount}", nl: "Totale kosten: {amount}", pl: "Łączny koszt: {amount}" },
  "Reply to this email to reach the store.": {
    es: "Responda a este email para contactar con la tienda.",
    fr: "Répondez à cet e-mail pour joindre la boutique.",
    de: "Antworten Sie auf diese E-Mail, um den Shop zu erreichen.",
    it: "Risponda a questa email per contattare il negozio.",
    pt: "Responda a este email para contactar a loja.",
    nl: "Beantwoord deze e-mail om de winkel te bereiken.",
    pl: "Odpowiedz na ten e-mail, aby skontaktować się ze sklepem.",
  },
  "Confirm the ship date": {
    es: "Confirmar la fecha de envío",
    fr: "Confirmer la date d'expédition",
    de: "Versanddatum bestätigen",
    it: "Conferma la data di spedizione",
    pt: "Confirmar a data de envio",
    nl: "Verzenddatum bevestigen",
    pl: "Potwierdź datę wysyłki",
  },
  "Quantity": { es: "Cantidad", fr: "Quantité", de: "Menge", it: "Quantità", pt: "Quantidade", nl: "Aantal", pl: "Ilość" },
  "Unit cost": { es: "Coste unitario", fr: "Coût unitaire", de: "Stückkosten", it: "Costo unitario", pt: "Custo unitário", nl: "Stukprijs", pl: "Koszt jednostkowy" },
  "Line total": { es: "Total de la línea", fr: "Total de la ligne", de: "Positionssumme", it: "Totale riga", pt: "Total da linha", nl: "Regeltotaal", pl: "Wartość pozycji" },
};
