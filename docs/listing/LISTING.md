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
Order best sellers before they sell out, and see the cash each order needs, week by week.
```

## App details

```text
Keha turns your Shopify sales and stock into an order plan: what to order from each supplier, how many, the last day to order, and the cash each week needs over the next 13 weeks. Sales per day count only the days a product was in stock, and every forecast shows how it was built. Send one purchase order per supplier per cycle as PDF, CSV or email; suppliers confirm the ship date from a link. Every Monday you get a ranked list of what to reorder, promote, fix or clear, with the money at stake.
```

## Feature list

```text
Order plan by supplier: what to order, how many, and the last day to order
Cash needed each week for every planned order over the next 13 weeks
Purchase orders as PDF, CSV or email; suppliers confirm ship dates by link
Forecasts skip sold-out days, and each one shows how it was worked out
Monday to-do list: reorder, promote, fix or clear, ranked by money at stake
```

## Feature list — optional extras (only if the form takes 8)

```text
Clear dead stock with a Shopify discount, created only after you confirm
Plan each warehouse and POS store, and draft stock transfers in Shopify
Season plan: an order list with order-by dates and cash needed per week
```

Where each claim lives in the code (the plan each one needs is in the plan cards, never in the text):

| Claim | Code |
|---|---|
| Order plan by supplier: what, how many, last day to order | `app/lib/engine/forward-plan-shared.ts` (the forward plan, from the nightly forecast), Dashboard "Order this week", Order plan → Order now (`app/routes/app.reorder.tsx`; Growth — Free sees a read-only top-10 preview) |
| Cash each week, next 13 weeks | Order plan → Next 13 weeks (`app/routes/app.reorder_.calendar.tsx`, CSV `app.reorder_.calendar_.csv.tsx`; Growth), the Dashboard's 13-week cash strip |
| Purchase orders PDF / CSV / email, ship date confirmed by link | `app/routes/app.reorder_.$id*.tsx`, `supplier.confirm.$token.tsx` (Growth) |
| One purchase order per supplier per cycle (details text) | The supplier order builder, `app/routes/app.reorder_.build.tsx`, `app/lib/supplier-order-shared.ts`: everything due within the supplier's order cycle (Settings → Suppliers "Order every … days") in one draft, topped up to its minimums (Growth) |
| Sales per day from in-stock days only; "How the forecast was built" | `app/lib/engine/rate-shared.ts`, `season-shared.ts`; the product page (`app/routes/app.products_.$variantId.tsx`) |
| Monday to-do list (reorder, promote, fix, clear), ranked by money | `app/lib/engine/actions-rules-shared.ts`, Dashboard tabs, `app/services/monday.server.ts` (Free: top 10) |
| Clear dead stock, discount only after confirm | `app/services/clearance.server.ts` (Growth) |
| Plan each warehouse and POS store, draft transfers | `app/routes/app.settings_.locations.tsx` (roles), location switcher, `app/routes/app.transfers.tsx`, `app/services/transfers.server.ts` (Pro; `inventoryTransferCreate` creates a draft after a confirm) |
| Season plan: order list, order-by dates, cash per week | Order plan → Season plan, `app/routes/app.reorder_.season.tsx`, `app/models/planner.server.ts` (Growth: 1 scenario, Pro: unlimited) |

Precision for the text: transfers are created as **drafts** in Shopify (nothing moves until the
merchant marks the transfer ready to ship there); POS stores are the locations the merchant marks
as "Store" in Settings → Locations. "The last day to order" is the order-by date: lead time
(including transit) before the stock would run out.

## Search terms

```text
inventory forecasting
purchase orders
inventory planning
demand forecasting
low stock alert
```

## Categories

- Primary: **Orders and shipping → Inventory → Inventory optimization.** **[Kanwar to confirm]**
  the exact labels shown in the form.
- No secondary category unless the form asks for one.

## Integrations

```text
Slack
Shopify Flow
Shopify POS
Shopify Sidekick
```

Only what the app itself works with (Slack incoming webhook, Flow triggers, POS locations in
Settings → Locations, the Sidekick extension). No other Keha app is named anywhere in the listing
(App Store requirement 4.4: don't reference your other apps).

## Pricing (plan cards)

Shopify App Pricing (managed). Prices come from the plan catalog (`app/services/plans.server.ts`
fallback, overridden by the Nova catalog) and must equal what is set in Partner Dashboard →
App pricing. Plan handles: `free`, `growth`, `pro`. Annual = 2 months free (10 × monthly).

| Plan | Monthly | Annual | Free trial |
|---|---|---|---|
| Free | $0 | $0 | none |
| Growth | $49 | $490 | 14 days |
| Pro | $99 | $990 | 14 days |

Plan card features, word for word from `PLAN_POINTS` (`app/lib/plan-matrix.ts`), each marked
with whether the code ships it (all do as of the merge of the Planner and Pro stores). Never
publish a line marked "Not built yet": playbook mistake #18 (a listing promise the app didn't
keep).

### Free

- Shipped — Order plan preview (top 10)
- Shipped — Sales at risk, sales lost to sell-outs, cash stuck and sold-out page visits
- Shipped — Numbers refreshed weekly
- Shipped — Top 10 actions and a Monday email

### Growth

- Shipped — Full order plan by supplier, with purchase orders
- Shipped — 13-week order calendar with cash per week
- Shipped — Numbers refreshed daily, and every action
- Shipped — What to do while a best seller is sold out, and dead-stock discounts
- Shipped — Season plan (1 scenario) and forecast accuracy
- Shipped — Slack and Shopify Flow

### Pro

- Shipped — Planning per location and per POS store
- Shipped — Transfers from warehouse to stores, created in Shopify
- Shipped — Unlimited Season plan scenarios

## Links and contacts

- Privacy policy: `https://inventory.keha.io/privacy`
- Terms: `https://inventory.keha.io/terms`
- Support email: the value of `INVENTORY_SUPPORT_EMAIL` on Railway (the pages fall back to support@keha.io). **[Kanwar to confirm]**
- Emergency developer contact (phone + email). **[Kanwar to confirm]**
- App icon 1200 × 1200, no text. Screenshots and feature image: `SCREENSHOTS.md`. Screencast: `SCREENCAST.md`.
- Reviewer instructions: `REVIEWER.md`. Protected customer data answers: `PCD-ANSWERS.md`.
