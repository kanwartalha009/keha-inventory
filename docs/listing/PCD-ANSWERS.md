# Protected customer data — DRAFT answers (Keha Inventory Intelligence)

**DRAFT.** These are statements the company makes to Shopify. Claude drafted them on
2026-10-16 from the code (task 2.7) and from nothing else. Every line marked
**[Kanwar to confirm]** depends on how the company and its hosting are run, which the code can't
show; answer those only once they are true. Partner Dashboard → Apps → Keha Inventory
Intelligence → API access → Protected customer data access.

## What data, and why Level 2

- **Why the app needs protected customer data access at all:** `read_reports` unlocks
  `shopifyqlQuery`, which Shopify gates behind Level 2 protected customer data. The app uses
  it only for aggregate reports: daily units sold, units returned and sales per product
  variant, location and sales channel; daily stock per variant and location; sessions and
  checkouts per landing page and referrer; the store's daily order count and sales. The exact
  queries are in `REVIEWER.md`. None selects a customer field.
- **Fields requested (name, email, phone, address):** the form asks for a reason per field.
  Reason for each field the form makes us tick: "Required by Shopify to run ShopifyQL reports
  (`read_reports`). The app's queries select no customer fields, and the app stores none."
  **[Kanwar to confirm]** which fields the form requires for ShopifyQL; tick no more than it
  requires.
- **No other customer access:** no `read_orders`, `read_customers` or `read_all_orders`, no
  `orders/*` or `customers/*` webhooks except Shopify's mandatory compliance topics.

**The one place customer data passes through the app (be accurate about it):** Shopify's
mandatory compliance webhooks (`customers/data_request`, `customers/redact`) carry the
customer's ID, email and phone. The app (1) answers the data request to the store owner by
email (stating the app holds no data about the customer), (2) logs the request in
`PersonalDataAccessLog` without personal data, and (3) forwards a copy to our own Nova Apps
platform through an outbox. The outbox copy is emptied within an hour of delivery (hourly job) and
deleted 30 days later; a copy that could not be delivered stays until the customer's deletion request or
the store's purge removes it.

## Level 1 requirements

| # | Requirement | Draft answer |
|---|---|---|
| 1 | Process only the minimum personal data needed | Yes. The app stores no shopper personal data. Sales, stock and visits are stored as totals per variant, location, channel, landing page and day. |
| 2 | Tell merchants what personal data you process and why | Yes: the privacy policy at `https://inventory.keha.io/privacy` (lists data, purposes, scopes, sub-processors, retention). |
| 3 | Limit use to the stated purposes | Yes. Data is used only to give the merchant stock advice, emails and alerts. No sale, no advertising, no use across stores. |
| 4 | Respect and apply consent decisions | Not applicable to shoppers (no shopper data is processed or contacted). Merchants choose every email and Slack destination; the Monday email has an unsubscribe link. |
| 5 | Respect opt-outs of data selling / sharing | Not applicable: no personal data is sold or shared for advertising. |
| 6 | Opt-out of automated decisions with legal or similar effect | Not applicable: the app makes suggestions to merchants only; nothing changes in the store until the merchant confirms. |
| 7 | Privacy and data protection agreements with merchants | The Terms of Service and Privacy Policy, accepted on install. **[Kanwar to confirm]** whether the company also offers a data processing agreement on request. |
| 8 | Apply retention periods | Yes. Daily totals: deleted after 25 months. Privacy-request access log: 90 days. Delivered platform copies: emptied within an hour of delivery, deleted after 30 days. All store data: deleted 48 hours after uninstall, immediately on `shop/redact`. |
| 9 | Encrypt data at rest and in transit | In transit: HTTPS to Shopify, to the email provider, to Slack and for every app page. At rest: Slack webhook links and supplier email addresses are encrypted in the app with AES-256-GCM. Database disk encryption is the hosting provider's: **[Kanwar to confirm]** that Railway encrypts the Postgres volume at rest, and whether the app's database connection uses TLS on Railway's private network. |

## Level 2 requirements

| # | Requirement | Draft answer |
|---|---|---|
| 10 | Encrypt data backups | **[Kanwar to confirm]** that Railway's Postgres backups are encrypted (their docs must say so; ask Railway support if not). |
| 11 | Keep test and production data separate | The code has a separate dev app config (`shopify.app.dev.toml`, its own client ID). **[Kanwar to confirm]** that the dev app uses its own database (e.g. a Railway staging environment), not production's. |
| 12 | Data loss prevention | **[Kanwar to confirm]** the strategy: Railway backups and their schedule, restore tested, who can delete the database. |
| 13 | Limit staff access to customer data | There is no admin screen that shows shopper data (the app stores none). **[Kanwar to confirm]** who has Railway, database, GitHub and Partner Dashboard access, and that it is limited to named people. |
| 14 | Strong passwords and authentication for staff | **[Kanwar to confirm]** password manager and two-factor sign-in on Shopify Partners, Railway, GitHub, the email provider and Nova admin. |
| 15 | Log access to personal data | **Yes.** `PersonalDataAccessLog` records every privacy request the app handles (who, what, how many records, no personal data), kept 90 days. The app has no other screen or export that shows shopper data. **[Kanwar to confirm]** that database access by staff is logged on the hosting side if Shopify asks about direct database access. |
| 16 | Security incident response policy | Draft below. **[Kanwar to confirm]** that the company adopts it and who is on call. |

## Data deletion on request

- **Customer deletion (`customers/redact`):** removes any outbox copy carrying the customer's
  email. Nothing else holds customer data.
- **Customer data request (`customers/data_request`):** the store owner receives an email that
  the app holds no data about the customer; the request is logged.
- **Store deletion (`shop/redact`):** every table with a `shop` column is deleted immediately
  (the purge list is generated from the database schema, so new tables are covered), plus the
  uninstall record.
- **Uninstall:** the access token is removed at once; all store data is deleted 48 hours later
  unless the app is reinstalled. The store's domain and the uninstall / deletion dates are kept as
  proof of deletion (removed by `shop/redact`).
- **Merchant request by email:** **[Kanwar to confirm]** the support address and that requests
  are answered within 30 days.

## Sub-processors

| Provider | What it processes | When |
|---|---|---|
| Shopify | Everything (the platform) | Always |
| Railway | App hosting and the Postgres database | Always. **[Kanwar to confirm]** the region the project runs in. |
| Resend (the default of `INVENTORY_EMAIL_API_URL`) | Emails to store staff and suppliers: recipient address, store name, order content | When an email is sent. **[Kanwar to confirm]** the provider actually configured on Railway; the privacy page names whichever the URL points to. |
| Slack | The Monday summary and alerts (product names, amounts) | Only when the merchant connects a webhook |
| Nova Apps platform (operated by us) | Install, plan and support records; copies of compliance webhooks | Always. **[Kanwar to confirm]** where Nova is hosted, and add that host as a sub-processor if it is a third party. |

## Personal data that is not customer data (for completeness)

- Store staff: email addresses the merchant enters for the Monday email (stored as entered);
  the store owner's email is read from Shopify when an email is sent and not stored.
- Suppliers: name and email address (email encrypted with AES-256-GCM, decrypted only to send
  an order). Supplier IP addresses are used in memory for rate limiting and not stored.
- The offline access token for the store is stored in the database (needed to sync).

## Draft security incident response policy

1. **Detect:** alerts from `/health` (sync, outbox, pricing), Railway logs, reports to the
   support address.
2. **Contain (within 1 hour of discovery):** rotate the affected secrets (`SHOPIFY_API_SECRET`,
   `APP_ENCRYPTION_KEY`, `INVENTORY_EMAIL_API_KEY`, `SHOPIFY_PARTNER_API_TOKEN`, database
   password), stop all scheduled jobs with `INVENTORY_DISABLE_INTERNAL_CRON=1` if they are
   involved, revoke staff access as needed.
3. **Assess:** which stores and what data; the database holds no shopper personal data, so
   assess supplier emails, staff emails and access tokens first.
4. **Notify:** affected merchants and Shopify without undue delay and within 72 hours of
   confirming a breach of personal data; authorities where the law requires.
5. **Recover and review:** restore from backup if needed, fix the cause, write a short
   post-incident note, update this policy.

Owner and on-call contact: **[Kanwar to confirm]**.
