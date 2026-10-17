/**
 * Translations for the purchase-order workflow fixes (merchant audit 2026-10-17): draft edits
 * and delete, partial receiving, re-opening, ship date and arrival, supplier-currency prices,
 * minimums and the Open orders columns. English text is the key (see app/lib/i18n.tsx). Admin
 * tone: tú (es), vous (fr), du (de), tu (it), European Portuguese, je (nl), informal Polish.
 * The two supplier-email labels at the end are neutral.
 */
import type { Tr } from "./i18n";

export const PO_TR: Record<string, Tr> = {
  "Partially received": { es: "Recibido en parte", fr: "Reçue en partie", de: "Teilweise erhalten", it: "Ricevuto in parte", pt: "Recebida em parte", nl: "Deels ontvangen", pl: "Przyjęte częściowo" },
  "Ship date: {date}": { es: "Fecha de envío: {date}", fr: "Date d'expédition : {date}", de: "Versanddatum: {date}", it: "Data di spedizione: {date}", pt: "Data de envio: {date}", nl: "Verzenddatum: {date}", pl: "Data wysyłki: {date}" },
  "Expected arrival: ~{date}": { es: "Llegada prevista: ~{date}", fr: "Arrivée prévue : ~{date}", de: "Erwartete Ankunft: ~{date}", it: "Arrivo previsto: ~{date}", pt: "Chegada prevista: ~{date}", nl: "Verwachte aankomst: ~{date}", pl: "Przewidywana dostawa: ~{date}" },
};
