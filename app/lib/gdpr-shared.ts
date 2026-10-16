/**
 * Pure helpers for the GDPR handlers — shared by gdpr.server and its tests.
 * No database or network here.
 *
 * Keha Inventory stores no shopper personal data. The only place a customer's
 * email can appear is a Nova outbox copy of the compliance webhook itself, so
 * the redact handler matches the email as sent and lower-cased.
 */

export type GdprCustomer = {
  id?: number | string | null;
  email?: string | null;
  phone?: string | null;
};

/** The email as sent and lower-cased. */
export function emailForms(email?: string | null): string[] {
  const e = (email ?? "").trim();
  return Array.from(new Set([e, e.toLowerCase()])).filter(Boolean);
}
