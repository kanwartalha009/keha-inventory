/**
 * Company name + support email for the public privacy / terms pages
 * (2026-09-28). Set on the server so the pages never show invented details:
 *   INVENTORY_LEGAL_NAME     e.g. the registered company name
 *   INVENTORY_SUPPORT_EMAIL  the support / privacy contact address
 */
export function legalContact(): { company: string; email: string } {
  const email = (process.env.INVENTORY_SUPPORT_EMAIL ?? "").trim();
  return {
    company: (process.env.INVENTORY_LEGAL_NAME ?? "").trim() || "Keha",
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "support@keha.io",
  };
}
