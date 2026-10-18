/**
 * Public privacy policy — required for the Shopify App Store listing. Served unauthenticated
 * on the app's own domain. English only by design (like /terms): the App Store listing and
 * Shopify's review read it in English; the admin UI is what is translated.
 *
 * Checked against the code for task 2.7 (2026-10-16); read_locales added 2026-10-17.
 * Every period comes from the module that enforces it (lib/legal.server LEGAL_FACTS), every
 * scope sentence from SCOPE_PURPOSES (held equal to shopify.app.toml by tests/legal.test.ts),
 * and the email provider from the API the app really sends through — or none, when no provider
 * is configured (owner decision 2026-10-18, the default: summaries go through Shopify Flow and
 * purchase orders through the merchant's own email app). Company and support email come from env (INVENTORY_LEGAL_NAME,
 * INVENTORY_SUPPORT_EMAIL; falls back to support@keha.io).
 */
import { useLoaderData } from "react-router";
import { privacyData } from "../lib/legal.server";

const UPDATED = "October 18, 2026";

export const loader = () => privacyData();

export default function Privacy() {
  const { company, email, emailProvider, facts, scopes } = useLoaderData<typeof loader>();
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
        background: "#ffffff",
      }}
    >
      <h1>Keha Inventory Planner — Privacy Policy</h1>
      <p>
        <em>Last updated: {UPDATED}</em>
      </p>
      <p>
        Keha Inventory Planner (“the App”) gives Shopify merchants stock
        advice from their own store data. {who} (“we”) operates the App. This
        policy explains what information the App collects, why, who processes
        it, how long it is kept, and how to reach us.
      </p>

      <h2>No data about your customers</h2>
      <p>
        The App does not request access to orders or customers, subscribes to
        no order webhooks, and stores no shopper names, email addresses, phone
        numbers or addresses. Sales come from Shopify’s own analytics reports as
        daily totals per product variant, location and sales channel; store
        visits are counted per landing page and traffic type. None of these
        totals identify a shopper.
      </p>

      <h2>Information we collect</h2>
      <p>
        <strong>About the store, from Shopify:</strong> the store’s domain,
        currency, time zone and language; the App plan; and an access token
        received through Shopify’s standard authorization flow. The store’s
        name, owner email and contact email are read from Shopify when a
        summary or purchase order is prepared or shown, and are not stored in
        our database.
      </p>
      <p>
        <strong>Store data, as totals:</strong> the product catalog (product
        and variant titles, SKUs, vendors, product types, collection titles, image
        links, status, creation date, prices and costs); locations (name,
        whether active, whether they fulfil online orders); stock per variant
        and location, now and per day; units sold, units returned and sales per
        variant, location, channel and day; store visits and checkouts per
        landing page and day; the store’s daily order count and sales; and
        purchase orders created in Shopify (supplier name, lines, quantities,
        costs and dates).
      </p>
      <p>
        <strong>What the merchant enters in the App:</strong> settings (lead
        times, thresholds, safety level); suppliers (name, email address, lead
        time, minimum orders, case packs, the vendors they supply); purchase
        orders created in the App; Season planner scenarios (dates and targets) and
        revenue goals per collection; each location’s role (warehouse, store)
        and whether it counts for online sales; the stock transfers created
        from the App; {emailProvider ? "the email addresses that should receive the weekly summary email; " : ""}
        a Slack webhook address, if connected; and what the
        merchant does with each suggested action (done, snoozed, dismissed,
        discounts created).
      </p>
      <p>
        <strong>From suppliers:</strong> the ship date a supplier confirms
        through the confirmation link (see below). Their IP address is used in
        memory to limit repeated requests and is not stored.
      </p>
      <p>
        <strong>Automatically:</strong> standard server logs (such as IP address
        and request time) kept by our hosting provider for security and
        troubleshooting. The App adds nothing to the store’s storefront.
      </p>

      <h2>How we use information</h2>
      <p>
        Only to provide the App to the merchant: calculating the money at stake
        in their stock, ranking the weekly actions, building reorder plans,
        season plans, purchase orders and transfer plans, measuring forecast
        accuracy, and sending the emails and
        messages described below. We do not sell information or use it for
        advertising.
      </p>

      <h2>Changes the App makes in your store</h2>
      <p>
        The App changes nothing in your store until you press a confirm button.
        After you confirm, it can create a Shopify discount for the products in
        a Clear action, or (on Pro) a stock transfer from a warehouse to a
        store. Transfers are created as drafts: no stock moves until you mark
        the transfer ready to ship in Shopify. The App never edits your
        products, prices or stock levels.
      </p>
      <p>
        The App sends events to Shopify Flow in your own store. On every plan:
        “Weekly order plan ready” (the weekly summary: what to order this week,
        the money at stake, the top actions, with links into the App) and
        “First order plan ready” (once, when your first plan is ready). On plans
        with Shopify Flow triggers: “Product needs reorder” (product and variant
        IDs, days of stock left, order-by date, suggested quantity) and “Product
        went dead” (product ID, cash stuck). Only workflows you turn on act on
        them — for example Flow’s “Send internal email” action, which Shopify
        sends to the addresses you type in Flow.
      </p>
      <p>
        Shopify Sidekick: when someone in your Shopify admin asks Sidekick a
        stock question, Sidekick can read the App’s answers (reorder plan,
        product stock, actions, money at stake, purchase orders, forecast
        accuracy) for your store only, in that admin session. This reads data
        the App already holds; it collects nothing new and changes nothing in
        your store.
      </p>

      <h2>Emails and messages</h2>
      <ul>
        {emailProvider ? (
          <li>
            <strong>To the store:</strong> the weekly summary email and instant stock
            alerts go to the store owner email or the addresses the merchant
            enters; every weekly summary email has an unsubscribe link. Answers to
            Shopify’s customer data requests go to the store owner.
          </li>
        ) : (
          <li>
            <strong>To the store:</strong> the App sends no email itself. The
            weekly summary and stock alerts reach the merchant through Shopify
            Flow (above) and, if connected, Slack. Shopify’s customer data
            requests are answered in the App’s access log (the App holds no
            data about the customer).
          </li>
        )}
        {emailProvider ? (
          <li>
            <strong>To suppliers:</strong> only when the merchant presses “Email
            supplier”. The email carries the purchase order and its confirmation
            link; it is sent from our address with the store’s name, and replies
            go to the store’s contact email. “Open in your email” instead
            prepares the same message in the merchant’s own email app.
          </li>
        ) : (
          <li>
            <strong>To suppliers:</strong> the App emails no supplier. “Open in
            your email” prepares the purchase order and its confirmation link as
            a new message in the merchant’s own email app; the merchant sends it
            from their own address.
          </li>
        )}
        <li>
          <strong>Slack:</strong> only when the merchant connects their own
          Slack webhook. The weekly summary and instant alerts (product names
          and the amounts at stake) are posted there. The merchant can
          disconnect at any time.
        </li>
        <li>The App never emails the store’s customers.</li>
      </ul>

      <h2>The supplier confirmation link</h2>
      <p>
        Each purchase order sent from the App has its own random link that
        needs no login. It shows the store’s name, the order number, the
        supplier’s name, the order lines (product, variant, SKU, quantity and,
        unless the merchant hides prices, unit cost) and the expected date. The
        supplier can pick a ship date and download the order as a PDF or CSV. The link
        works only while the order is open, stops working {facts.confirmLinkDays}{" "}
        days after the order is sent, and is rate-limited.
      </p>

      <h2>Shopify permissions the App asks for</h2>
      <ul>
        {Object.entries(scopes).map(([scope, why]) => (
          <li key={scope}>
            <code>{scope}</code> — {why}
          </li>
        ))}
      </ul>

      <h2>Service providers (subprocessors)</h2>
      <p>We share data only with the providers needed to run the App:</p>
      <ul>
        <li>Shopify — the platform the App runs on.</li>
        <li>Railway — hosting and database for the App.</li>
        {emailProvider && (
          <li>
            {emailProvider} — sends the emails described above (to the store and,
            when the merchant asks, to a supplier).
          </li>
        )}
        <li>Slack — only when the merchant connects their own Slack workspace.</li>
        <li>
          The Nova Apps platform (operated by us) — installation, plan and
          support records, and copies of Shopify’s privacy requests (as Shopify
          sends them, which can include a customer’s email address) so they can
          be tracked to completion.
        </li>
      </ul>

      <h2>Data retention and deletion</h2>
      <ul>
        <li>
          We keep data while the App is installed. Daily sales, stock and visit
          totals older than {facts.dailyFactsMonths} months are deleted.
        </li>
        <li>
          When a merchant uninstalls the App, the access token stops working and
          all stored data for that store is permanently deleted{" "}
          {facts.purgeAfterHours} hours later (unless the App is reinstalled
          within that time). Shopify’s store deletion request deletes it
          straight away.
        </li>
        <li>
          A customer data request is answered {emailProvider ? "to the store owner by email" : "in the access log"} (the App holds
          no data about the customer). A customer deletion request removes any
          copy of that request’s email address from our delivery records.
        </li>
        <li>
          Privacy requests are recorded in an access log (what, when and how many
          records, without personal data), kept for {facts.accessLogDays} days and
          deleted with the store’s data.
        </li>
        <li>
          Copies sent to the Nova Apps platform are emptied within an hour of
          delivery and deleted after {facts.outboxDays} days.
        </li>
        <li>
          As proof of the deletion after uninstall we keep the store’s domain
          with the dates it was uninstalled and deleted. Shopify’s store
          deletion request removes this record too.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        Data is transmitted over HTTPS and stored with access limited to the
        App’s backend. Slack webhook addresses and supplier email addresses are
        encrypted at rest (AES-256-GCM); supplier email addresses are decrypted
        only to prepare or send an order, and are shown only to the merchant.
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
