/**
 * Public terms of service — linked from the Shopify App Store listing. Served unauthenticated
 * on the app's own domain. English only by design (like /privacy). Company + support email
 * from env (lib/legal.server). Checked against the code for task 2.7 (2026-10-16).
 */
import { useLoaderData } from "react-router";
import { LEGAL_FACTS, legalContact } from "../lib/legal.server";

const UPDATED = "October 16, 2026";

export const loader = () => ({ ...legalContact(), facts: LEGAL_FACTS });

export default function Terms() {
  const { company, email, facts } = useLoaderData<typeof loader>();
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
        background: "#ffffff",
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
        The App reads a store’s products, stock, sales totals and store visits,
        and gives the merchant stock advice: the money at stake, a weekly list
        of what to reorder, push, fix and clear, reorder plans with purchase
        orders, a confirmation link for suppliers, and emails, Slack messages
        and Shopify Flow events about stock. Features may be added, changed, or
        removed as the App evolves.
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
      <ul>
        <li>
          The App’s numbers and suggestions are estimates based on the store’s
          own history; they are not guarantees of future sales. Purchasing
          decisions and supplier relationships remain the merchant’s.
        </li>
        <li>
          The App changes nothing in the store until the merchant confirms.
          Discounts and stock transfers the merchant confirms are created in
          Shopify as the merchant set them up; the merchant can edit or end them
          in Shopify at any time.
        </li>
        <li>
          The merchant must have the right to give us the supplier details they
          enter, and is responsible for the purchase orders they send. A
          supplier confirmation link works without a login for anyone who has
          it, so it should only be shared with that supplier; it stops working{" "}
          {facts.confirmLinkDays} days after the order is sent.
        </li>
        <li>
          Slack messages go to the webhook the merchant connects; the merchant
          is responsible for who can read that Slack channel.
        </li>
      </ul>

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
        Handling of merchant, supplier and customer data is described in our{" "}
        <a href="/privacy">Privacy Policy</a>, which forms part of these terms.
      </p>

      <h2>Termination</h2>
      <p>
        Merchants can stop using the App at any time by uninstalling it. We may
        suspend or terminate access for abuse, non-payment, or use that risks
        harm to Shopify, other merchants, or customers. Stored data is deleted{" "}
        {facts.purgeAfterHours} hours after uninstall, as described in the
        Privacy Policy.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms: <a href={`mailto:${email}`}>{email}</a>.
      </p>
    </main>
  );
}
