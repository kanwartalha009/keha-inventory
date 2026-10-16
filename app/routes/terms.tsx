/**
 * Public terms of service — linked from the Shopify App Store listing.
 * Served unauthenticated on the app's own domain. Company + support email from
 * env (lib/legal.server) — 2026-09-28.
 */
import { useLoaderData } from "react-router";
import { legalContact } from "../lib/legal.server";

const UPDATED = "October 16, 2026";

export const loader = () => legalContact();

export default function Terms() {
  const { company, email } = useLoaderData<typeof loader>();
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
      <h1>Keha Inventory Intelligence — Terms of Service</h1>
      <p>
        <em>Last updated: {UPDATED}</em>
      </p>
      <p>
        These terms govern use of the Keha Inventory Intelligence app (“the App”){company ? `, operated by ${company},` : ""} by
        merchants who install it from the Shopify App Store. By installing or
        using the App you agree to these terms.
      </p>

      <h2>The service</h2>
      <p>
        The App reads a store’s products, stock, sales and store visits, and
        gives the merchant stock advice: money at stake, a weekly list of what
        to reorder, push, fix and clear, reorder plans, and season plans.
        Features may be added, changed, or removed as the App evolves.
      </p>

      <h2>Fees and billing</h2>
      <p>
        Paid plans are billed through Shopify on the pricing shown in the App
        and on its listing, including any free trial period. Charges appear on
        the merchant’s Shopify invoice. Plans can be changed or cancelled at any
        time on Shopify’s plan page; uninstalling the App ends billing in
        accordance with Shopify’s billing rules.
      </p>

      <h2>Merchant responsibilities</h2>
      <p>
        The App’s numbers and suggestions are estimates based on the store’s
        own history; they are not guarantees of future sales. Merchants decide
        what to order, discount or transfer: the App changes nothing in the
        store until the merchant confirms. Purchasing decisions and supplier
        relationships remain the merchant’s.
      </p>

      <h2>Availability and liability</h2>
      <p>
        We aim for continuous availability but the App is provided “as is”
        without warranties of any kind. To the maximum extent permitted by law,
        our aggregate liability for any claim relating to the App is limited to
        the fees paid for the App in the three months preceding the claim. We
        are not liable for indirect or consequential damages, including lost
        profits or lost sales.
      </p>

      <h2>Data</h2>
      <p>
        Handling of merchant and customer data is described in our{" "}
        <a href="/privacy">Privacy Policy</a>, which forms part of these terms.
      </p>

      <h2>Termination</h2>
      <p>
        Merchants can stop using the App at any time by uninstalling it. We may
        suspend or terminate access for abuse, non-payment, or use that risks
        harm to Shopify, other merchants, or customers. Stored data is purged
        after uninstall as described in the Privacy Policy.
      </p>

      <h2>Contact</h2>
      <p>
        {email ? (
          <>
            Questions about these terms: <a href={`mailto:${email}`}>{email}</a>.
          </>
        ) : (
          <>Questions about these terms: support@keha.io.</>
        )}
      </p>
    </main>
  );
}
