/**
 * Public privacy policy — required for the Shopify App Store listing.
 * Served unauthenticated on the app's own domain.
 *
 * Written from spec v1 (§8, §10, §14). Before submission (task 2.7) every
 * claim here must be checked against the code and /health.config: encryption
 * of Slack URLs and supplier emails, 25-month roll-up, 48h purge, access log.
 * The company name and support email come from env (INVENTORY_LEGAL_NAME,
 * INVENTORY_SUPPORT_EMAIL; legal.server falls back to support@keha.io).
 */
import { useLoaderData } from "react-router";
import { legalContact } from "../lib/legal.server";

const UPDATED = "October 16, 2026";

export const loader = () => legalContact();

export default function Privacy() {
  const { company, email } = useLoaderData<typeof loader>();
  const who = company || "Keha";
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "48px 24px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        lineHeight: 1.6,
        color: "#1a1a1a",
      }}
    >
      <h1>Keha Inventory Intelligence — Privacy Policy</h1>
      <p>
        <em>Last updated: {UPDATED}</em>
      </p>
      <p>
        Keha Inventory Intelligence (“the App”) gives Shopify merchants stock
        advice from their own store data. {who} (“we”) operates the App. This
        policy explains what information the App collects, why, who processes
        it, how long it is kept, and how to reach us.
      </p>

      <h2>Information we collect</h2>
      <p>
        <strong>From merchants:</strong> the store’s domain, name, currency,
        time zone, language and email addresses, and an API access token
        received through Shopify’s standard authorization flow; the settings
        the merchant saves (lead times, suppliers with their names and email
        addresses, alert recipients and, if connected, a Slack webhook
        address); and the plan and billing status of the App subscription.
      </p>
      <p>
        <strong>Store data, aggregated:</strong> the product catalog (titles,
        variants, SKUs, vendors, collections, costs and prices), stock levels
        per location, and daily totals of units sold, units returned and sales
        per product variant, location and sales channel, plus daily store-visit
        counts per landing page. These totals contain no information about
        individual customers.
      </p>
      <p>
        <strong>About the merchant’s customers:</strong> nothing. The App does
        not request access to orders or customers, and stores no customer
        names, email addresses, phone numbers or addresses.
      </p>
      <p>
        <strong>Automatically:</strong> standard server logs (such as IP
        address and request time) kept by our hosting provider for security and
        troubleshooting. The App adds nothing to the store’s storefront.
      </p>

      <h2>How we use information</h2>
      <p>
        Data is used only to provide the App to the merchant: calculating the
        money at stake in their stock, ranking the weekly actions, building
        reorder and season plans, and emailing the merchant (the Monday summary
        and alerts they can turn off). We do not sell information or use it for
        advertising.
      </p>

      <h2>Service providers (subprocessors)</h2>
      <p>We share data only with the providers needed to run the App:</p>
      <ul>
        <li>Shopify — the platform the App runs on.</li>
        <li>Railway — hosting and database for the App.</li>
        <li>Our transactional email provider — sends emails to the merchant and, when the merchant asks, a purchase order to their supplier.</li>
        <li>Slack — only when the merchant connects their own Slack workspace.</li>
        <li>
          The Nova Apps platform (operated by us) — installation, billing and
          support records, and copies of Shopify’s privacy requests so they can
          be tracked to completion.
        </li>
      </ul>

      <h2>Data retention and deletion</h2>
      <p>
        We keep data while the App is installed; daily totals older than 25
        months are rolled up into monthly totals. The App handles Shopify’s
        mandatory privacy webhooks: a customer data request is answered to the
        store owner (the App holds no data about the customer), and a customer
        deletion request removes any copy of that request’s email address from
        our delivery records. When a merchant uninstalls the App, the access
        token stops working immediately and all stored data for that store is
        permanently deleted 48 hours later (unless the App is reinstalled
        within that time).
      </p>

      <h2>Security</h2>
      <p>
        Data is transmitted over HTTPS and stored with access limited to the
        App’s backend. Slack webhook addresses and supplier email addresses are
        encrypted at rest (AES-256-GCM). Privacy requests are recorded in an
        access log (who, what and how many records, without personal data),
        kept for 90 days and deleted with the store’s data.
      </p>

      <h2>Your rights</h2>
      <p>
        Merchants can contact us directly to access, correct or delete their
        data. Customers of a store should contact that store; the store can
        make the request through Shopify.
      </p>

      <h2>Contact</h2>
      <p>
        Privacy questions or requests: <a href={`mailto:${email}`}>{email}</a>
        {company ? ` (${company})` : ""}.
      </p>
    </main>
  );
}
