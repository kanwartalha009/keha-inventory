/**
 * What the public privacy / terms pages state, kept next to the code that makes it true
 * (task 2.7; playbook §8 "privacy text matches the code", mistake #20).
 *
 *   INVENTORY_LEGAL_NAME     the registered company name
 *   INVENTORY_SUPPORT_EMAIL  the support / privacy contact address
 *   INVENTORY_EMAIL_API_URL  the email API the app sends through (names the email provider)
 *
 * Every period below is imported from the module that enforces it, or (for the two that live
 * in server modules with side effects) held equal to it by tests/legal.test.ts.
 */
import { CONFIRM_LINK_DAYS } from "./purchase-order-shared";
import { PII_LOG_RETENTION_DAYS } from "./pii-log-shared";
import { RETENTION_MONTHS } from "./sync/store-time-shared";

export function legalContact(): { company: string; email: string } {
  const email = (process.env.INVENTORY_SUPPORT_EMAIL ?? "").trim();
  return {
    company: (process.env.INVENTORY_LEGAL_NAME ?? "").trim() || "Keha",
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "support@keha.io",
  };
}

/** = PURGE_AFTER_MS in app/services/gdpr.server.ts (tests/legal.test.ts). */
export const PURGE_AFTER_HOURS = 48;
/** = SENT_RETENTION_MS in app/lib/nova.server.ts (tests/legal.test.ts). */
export const OUTBOX_SENT_RETENTION_DAYS = 30;

export const LEGAL_FACTS = {
  /** Daily sales, stock and visit totals are deleted after this many months (sync/facts.server applyRetention). */
  dailyFactsMonths: RETENTION_MONTHS,
  /** All store data is deleted this long after uninstall (gdpr.server purgeDueShops). */
  purgeAfterHours: PURGE_AFTER_HOURS,
  /** Privacy-request access log rows are deleted after this many days (pii-log.server). */
  accessLogDays: PII_LOG_RETENTION_DAYS,
  /** Supplier confirmation link stops working this many days after the order is sent. */
  confirmLinkDays: CONFIRM_LINK_DAYS,
  /** Delivered Nova platform copies are deleted after this many days. */
  outboxDays: OUTBOX_SENT_RETENTION_DAYS,
} as const;

/**
 * Every scope the app requests (shopify.app.toml [access_scopes]) and why, in one plain
 * sentence. tests/legal.test.ts holds the keys equal to the toml.
 */
export const SCOPE_PURPOSES: Record<string, string> = {
  read_products: "Reads your products and variants (titles, SKUs, vendors, collections, prices and costs) to know what you sell.",
  read_inventory: "Reads stock levels per location, so we know what is in stock, running low or sold out.",
  read_locations: "Reads your locations, to tell which ones fulfil online orders.",
  read_reports:
    "Runs Shopify's own analytics reports (ShopifyQL) for daily sales totals per product, stock history and store visits per landing page. These reports are totals: the app never asks them for customer details.",
  read_inventory_purchase_orders: "Reads purchase orders you create in Shopify, so stock you have already ordered is counted as incoming.",
  write_inventory_transfers:
    "Reads the transfers linked to your Shopify purchase orders and, on Pro, creates a draft stock transfer from a warehouse to a store only when you press confirm.",
  write_discounts: "Creates a Shopify discount for dead stock, only when you press confirm on a Clear action.",
};

const KNOWN_EMAIL_PROVIDERS: [RegExp, string][] = [
  [/(^|\.)resend\.com$/, "Resend"],
  [/(^|\.)sendgrid\.(com|net)$/, "SendGrid"],
  [/(^|\.)postmarkapp\.com$/, "Postmark"],
  [/(^|\.)mailgun\.(net|org)$/, "Mailgun"],
  [/(^|\.)amazonaws\.com$/, "Amazon SES"],
  [/(^|\.)brevo\.com$|(^|\.)sendinblue\.com$/, "Brevo"],
];

/** The email provider's name, from the API the app really sends through (email.server). */
export function emailProvider(apiUrl: string | undefined = process.env.INVENTORY_EMAIL_API_URL): string {
  let host = "api.resend.com"; // email.server's default
  try {
    if (apiUrl) host = new URL(apiUrl).hostname.toLowerCase();
  } catch {
    // malformed URL: email.server would fail to send; name the default
  }
  return KNOWN_EMAIL_PROVIDERS.find(([re]) => re.test(host))?.[1] ?? host;
}

/** Everything the privacy page renders that comes from the server. */
export function privacyData() {
  return { ...legalContact(), emailProvider: emailProvider(), facts: LEGAL_FACTS, scopes: SCOPE_PURPOSES };
}
