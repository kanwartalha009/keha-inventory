# App Store listing — Keha Inventory Planner

> **Name:** "Keha Inventory Planner" (22 characters), chosen by Kanwar on 2026-10-17 after the marketing
> audit ("Planner" matches what merchants search for and what the app leads with). It must equal
> `shopify.app.toml` `name` and the Partner Dashboard app name (`tests/listing.test.ts`).

Partner Dashboard → Apps → Keha Inventory Planner → Distribution → Manage listing.
English is the primary listing. Every claim below is something the code does today
(checked 2026-10-16, task 2.7; rewritten 2026-10-17 from the marketing audit: the order plan leads,
no plan names in the text, no other Keha app named); `tests/listing.test.ts` enforces the limits,
the name and the pricing table. Edit a value only inside its ```text block, then run
`npx vitest run tests/listing.test.ts`.

Limits used (shopify.dev "App Store requirements checklist", playbook §8):
name ≤ 30 and equal to `shopify.app.toml` `name`; introduction ≤ 100; details ≤ 500; each
feature ≤ 80 (5 required, up to 8 when the form allows); up to 5 search terms. Shopify publishes
no length for the app card subtitle; the test holds it to ≤ 60 (the shortest limit found in
third-party guides). No prices, statistics, outcome guarantees, "AI", "the first" / "the only",
or plan names in the text (prices and plans live in the plan cards).

## App name

```text
Keha Inventory Planner
```

## App card subtitle

```text
Know what to order, from whom, by when and the cash it takes
```

## App introduction

```text
Reorder before your products run out, and see the cash each order needs, week by week.
```

## App details

```text
Keha turns your Shopify sales and stock into an order plan: what to order from each supplier, how many, the last day to order, and the cash needed each week for 13 weeks. Sales per day count only in-stock days, and every forecast shows how it was built. Send one purchase order per supplier per cycle as PDF, CSV or email; suppliers confirm the ship date by link. Every Monday: a ranked list of what to reorder, promote, fix or clear, with the money at stake. It also answers in Shopify Sidekick.
```

## Feature list

```text
Order plan by supplier: what to order, how many, and the last day to order
Cash needed each week on your suppliers' payment terms, for the next 13 weeks
Purchase orders as PDF, CSV or email; suppliers confirm ship dates by link
Forecasts that ignore out-of-stock days, each showing how it was worked out
Weekly to-do list: reorder, promote, fix or clear, ranked by money at stake
```

## Feature list — optional extras (only if the form takes 8)

```text
Clear dead stock with a Shopify discount, created only after you confirm
Plan each warehouse and POS store, and draft stock transfers in Shopify
Season planner: an order list with order-by dates and cash needed per week
```

Where each claim lives in the code (the plan each one needs is in the plan cards, never in the text):

| Claim | Code |
|---|---|
| Order plan by supplier: what, how many, last day to order | `app/lib/engine/forward-plan-shared.ts` (the forward plan, from the nightly forecast), Dashboard "Due this week", Order plan → Due now (`app/routes/app.reorder.tsx`; Growth — Free sees a read-only top-10 preview) |
| Cash each week, next 13 weeks | Order plan → Order calendar (`app/routes/app.reorder_.calendar.tsx`, CSV `app.reorder_.calendar_.csv.tsx`; Growth), the Dashboard's 13-week cash strip |
| Purchase orders PDF / CSV / email, ship date confirmed by link | `app/routes/app.reorder_.$id*.tsx` ("Open in your email": a mailto in the supplier's language, `app/lib/po-mailto-shared.ts`; "Email supplier" only when an email provider is set), `supplier.confirm.$token*.tsx` (PDF and CSV download) (Growth) |
| One purchase order per supplier per cycle (details text) | The purchase order builder, `app/routes/app.reorder_.build.tsx`, `app/lib/supplier-order-shared.ts`: everything due before the supplier's next order (Settings → Suppliers "Order enough for", or a per-order choice of 30–180 days in the builder) in one draft, topped up to its minimums (Growth) |
| Sales per day from in-stock days only; "How the forecast was built" | `app/lib/engine/rate-shared.ts`, `season-shared.ts`; the product page (`app/routes/app.products_.$variantId.tsx`) |
| Weekly to-do list (reorder, promote, fix, clear), ranked by money | `app/lib/engine/actions-rules-shared.ts`, Dashboard tabs, `app/services/monday.server.ts` (Free: top 10) |
| Clear dead stock, discount only after confirm | `app/services/clearance.server.ts` (Growth) |
| Plan each warehouse and POS store, draft transfers | `app/routes/app.settings_.locations.tsx` (roles), location switcher, `app/routes/app.transfers.tsx`, `app/services/transfers.server.ts` (Pro; `inventoryTransferCreate` creates a draft after a confirm) |
| Season planner: order list, order-by dates, cash per week | Order plan → Season planner, `app/routes/app.reorder_.season.tsx`, `app/models/planner.server.ts` (Growth: 1 scenario, Pro: unlimited) |
| It also answers in Shopify Sidekick (details text) | `extensions/keha-inventory-sidekick` (six read-only tools: order plan, products, actions, money at stake, purchase orders, forecast accuracy), `app/routes/api.sidekick.$tool.tsx`; nothing changes the store from Sidekick |

Precision for the text: transfers are created as **drafts** in Shopify (nothing moves until the
merchant marks the transfer ready to ship there); POS stores are the locations the merchant marks
as "Store" in Settings → Locations. "The last day to order" is the order-by date: lead time
(including transit) before the stock would run out.

## Search terms

```text
inventory forecast
purchase orders
inventory planning
demand forecasting
low stock alert
```

## Categories

- Primary: **Orders and shipping → Inventory → Inventory optimization** (saved in the form 2026-10-18).
- No secondary category unless the form asks for one.

## Integrations

```text
Slack
```

The form rejects "Shopify Flow" (an integration name can't contain "Shopify"; checked in the
form 2026-10-18), so Flow is described in the details and features instead. The apps Keha connects to: Slack (incoming webhook, Settings → Alerts) and Shopify Flow
(four triggers, `extensions/keha-inventory-flow`: "Weekly order plan ready" and "First order plan
ready" on every plan — how merchants get Keha's summaries by email, with Flow's "Send internal
email" action — and "Product needs reorder" / "Product became dead stock" on Growth). Keha has no email
provider of its own (owner decision 2026-10-18): nothing in the listing says "we email you"; email
is "through Shopify Flow" or, for purchase orders, the merchant's own email app. Shopify POS and Sidekick are not listed (listing
audit 2026-10-18): POS stores are Shopify locations the app plans for (a feature, in the details and
Structured features), and the Sidekick extension is part of the app, not an integration. No other
Keha app is named anywhere in the listing (App Store requirement 4.4: don't reference your other apps).

## Structured features

Partner Dashboard → listing form → the category's **structured features** (shopify.dev "App listing
categories": each category asks for structured features, up to 25 per category field, editable any
time without a review appeal). Shopify does not publish the list of options per category, so the
labels below describe what the app does; tick the closest option the form offers for each one.
**[Kanwar to confirm in Partner Dashboard]** the exact option labels shown for Orders and shipping →
Inventory → Inventory optimization, and tick nothing the table below doesn't back.

| What the app does (tick the matching option) | Where in the code |
|---|---|
| Demand / sales forecasting per product, seasonality from 13 months of sales | `app/lib/engine/rate-shared.ts`, `season-shared.ts`; product page "How the forecast was built" |
| Out-of-stock days left out of the sales rate | `app/lib/engine/rate-shared.ts` |
| Reorder suggestions: quantity and order-by date per product, by supplier | `app/lib/engine/forward-plan-shared.ts`, Order plan → Due now |
| Purchase orders: create, PDF, CSV, email to the supplier (from the merchant's own email app) | `app/routes/app.reorder_.$id*.tsx`, `app/lib/po-mailto-shared.ts` |
| Supplier management: lead time, case packs, minimums, payment terms, order days ("Order enough for") | `app/routes/app.settings_.suppliers.tsx` |
| Supplier confirms the ship date from a link (no login) | `app/routes/supplier.confirm.$token.tsx` |
| Low-stock / stock-out alerts by email (through Shopify Flow) and Slack | `app/routes/app.settings_.alerts.tsx`, `app/services/alerts.server.ts`, `app/services/monday.server.ts`, `extensions/keha-inventory-flow` |
| Cash-flow planning: cash needed per week for the next 13 weeks | `app/routes/app.reorder_.calendar.tsx`, `app/lib/cash-shared.ts` |
| Dead-stock / overstock detection and clearance discounts (after a confirm) | `app/services/clearance.server.ts` |
| Multi-location planning: each warehouse and POS store | `app/routes/app.settings_.locations.tsx`, location switcher |
| Stock transfers between locations (draft in Shopify, after a confirm) | `app/routes/app.transfers.tsx`, `app/services/transfers.server.ts` |
| Seasonal / event planning (Season planner scenarios) | `app/routes/app.reorder_.season.tsx` |
| Forecast accuracy report | Order plan → Season planner → Forecast accuracy |
| Bundles: a bundle's sales count on its components | `app/services/compute.server.ts` (`isBundle`) |
| CSV import (suppliers, products) and CSV export (products, orders, the 13-week plan) | `app/routes/app.settings_.import.tsx`, `app.products.csv.tsx`, `app.reorder_.calendar_.csv.tsx` |

Do **not** tick: barcode scanning, receiving stock in the app (orders close when the stock lands in
Shopify), inventory sync with other platforms or marketplaces, ERP / accounting sync, dropshipping,
storefront widgets — the app has none of them.

## Languages

The languages the admin is fully translated into (`app/lib/i18n.tsx` `LOCALES`,
`tests/i18n-coverage.test.ts`; App Store requirement 4.3.2):

```text
English
Spanish
French
German
Italian
Portuguese
Dutch
Polish
```

## Pricing (plan cards)

Shopify App Pricing (managed). Prices come from the plan catalog (`app/services/plans.server.ts`
fallback, overridden by the Nova catalog) and must equal what is set in Partner Dashboard →
App pricing. Plan handles: `free`, `growth`, `pro`. Annual = 2 months free (10 × monthly).

| Plan | Monthly | Annual | Free trial |
|---|---|---|---|
| Free | $0 | $0 | none |
| Growth | $49 | $490 | 7 days |
| Pro | $99 | $990 | 7 days |

Plan card features, word for word from `PLAN_POINTS` (`app/lib/plan-matrix.ts`), each marked
with whether the code ships it (all do as of the merge of the Planner and Pro stores). Never
publish a line marked "Not built yet": playbook mistake #18 (a listing promise the app didn't
keep).

### Free

- Shipped — Order plan preview (top 10)
- Shipped — Sales at risk, lost sales, cash tied up and out-of-stock page visits
- Shipped — Numbers refreshed weekly
- Shipped — Top 10 actions and a weekly summary email through Shopify Flow

### Growth

- Shipped — Full order plan by supplier, with purchase orders
- Shipped — Order calendar: every order with cash per week
- Shipped — Numbers refreshed daily, and every action
- Shipped — Stock-gap actions and dead-stock discounts
- Shipped — Season planner (1 scenario) and forecast accuracy
- Shipped — Slack and Shopify Flow

### Pro

- Shipped — Planning per location and per POS store
- Shipped — Transfers from warehouse to stores, created in Shopify
- Shipped — Unlimited Season planner scenarios

### As entered in the Partner Dashboard (2026-10-18)

App Pricing enabled (one-way, Kanwar's yes 2026-10-18). Display names Free / Growth / Pro. The form
caps each feature at 40 characters, so the plan-card lines above are shortened without changing what
they claim:

- **Free:** Order plan preview: top 10 products · Sales at risk, lost sales, cash tied up · Top 10
  actions each week · Numbers refreshed weekly · Weekly summary email via Shopify Flow
- **Growth:** Everything in Free · Full order plan by supplier · Purchase orders with PDF and CSV ·
  Order calendar with cash per week · Daily refresh and the full action list · Stock gaps and
  dead-stock discounts · Season planner and forecast accuracy · Slack and Shopify Flow alerts
- **Pro:** Everything in Growth · Planning per location and POS store · Transfers to stores,
  created in Shopify · Unlimited Season planner scenarios

## Links and contacts

- Privacy policy: `https://inventory.keha.io/privacy`
- Terms: `https://inventory.keha.io/terms`
- Support email: the value of `INVENTORY_SUPPORT_EMAIL` on Railway (the pages fall back to support@keha.io). **[Kanwar to confirm]**
- Emergency developer contact (phone + email). **[Kanwar to confirm]**
- App icon 1200 × 1200, no text. Screenshots and feature image: `SCREENSHOTS.md`. Screencast: `SCREENCAST.md`.
- Reviewer instructions: `REVIEWER.md`. Protected customer data answers: `PCD-ANSWERS.md`.
