# App Store listing — Keha Inventory Intelligence

Partner Dashboard → Apps → Keha Inventory Intelligence → Distribution → Manage listing.
English is the primary listing. Every claim below is something the code does today
(checked 2026-10-16, task 2.7; rechecked 2026-10-17 after the Planner and Pro stores merged); `tests/listing.test.ts` enforces the limits, the name and the
pricing table. Edit a value only inside its ```text block, then run `npx vitest run tests/listing.test.ts`.

Limits used (shopify.dev "App Store requirements checklist", playbook §8):
name ≤ 30 and equal to `shopify.app.toml` `name`; introduction ≤ 100; details ≤ 500; each
feature ≤ 80; up to 5 search terms. Shopify publishes no length for the app card subtitle; the
test holds it to ≤ 60 (the shortest limit found in third-party guides — see the report).
No prices, statistics, outcome guarantees or "AI" in the text (prices live in the plan cards).

## App name

```text
Keha Inventory Intelligence
```

## App card subtitle

```text
Know what to reorder, push, fix and clear, every Monday
```

## App introduction

```text
See what your stock is costing you in money, and get a ranked to-do list every Monday.
```

## App details

```text
Keha reads your own Shopify sales, stock and store visits and puts a money figure on four problems: sales at risk, sales lost to sell-outs, cash stuck and visits to sold-out pages. Every Monday you get a ranked list of what to reorder, push, fix and clear. Sales per day count only in-stock days, so sell-outs never drag a forecast down. Send purchase orders that suppliers confirm through a link, plan a season's orders and cash per week, and on Pro plan each warehouse and POS store.
```

## Feature list

```text
Money at stake: sales at risk, lost to sell-outs, cash stuck, sold-out visits
A weekly to-do list to reorder, push, fix and clear, ranked by money at stake
Forecasts ignore sold-out days and use seasonality once 13 months exist
Purchase orders per supplier as PDF, CSV or email, with a ship-date link
Clear dead stock with a Shopify discount, created only after you confirm
Monday email in your store's language, plus Slack and Shopify Flow alerts
Season planner: order list with order-by dates and cash needed per week
Pro: plan each warehouse and POS store, and create draft transfers in Shopify
```

Where each claim lives in the code:

| Claim | Code |
|---|---|
| Four money numbers | `app/lib/engine/money-shared.ts`, Home cards |
| Ranked to-do list (reorder, push, fix, clear, bridge) | `app/lib/engine/actions-rules-shared.ts`, Home tabs |
| Sold-out days ignored; seasonality from 13 months | `app/lib/engine/rate-shared.ts`, `season-shared.ts` |
| Purchase orders PDF / CSV / email, ship-date link | `app/routes/app.reorder_.$id*.tsx`, `supplier.confirm.$token.tsx` (Growth) |
| Discount only after confirm | `app/services/clearance.server.ts` (Growth) |
| Monday email translated, Slack, Flow | `app/services/monday.server.ts`, `slack.server.ts`, `flow.server.ts` (Slack, Flow: Growth) |
| Season planner: order list, order-by dates, cash per week (also collection goals, accuracy scorecard) | `app/routes/app.planner.tsx`, `app/models/planner.server.ts` (Growth: 1 scenario, Pro: unlimited) |
| Plan per warehouse and POS store | `app/routes/app.settings_.locations.tsx` (roles), location switcher on Products and Reorder (Pro) |
| Draft transfers in Shopify | Reorder → "Transfers: warehouse → stores", `app/routes/app.transfers.tsx`, `app/services/transfers.server.ts` (Pro; `inventoryTransferCreate` creates a draft after a confirm) |

Precision for the text: transfers are created as **drafts** in Shopify (nothing moves until the
merchant marks the transfer ready to ship there); POS stores are the locations the merchant marks
as "Store" in Settings → Locations.

## Search terms

```text
inventory forecasting
reorder
dead stock
purchase orders
stock alerts
```

## Categories

- Primary: the Partner Dashboard's inventory-management category (Store management → Inventory). **[Kanwar to confirm]** the exact category and tags shown in the form.
- No secondary category unless the form asks for one.

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

- Shipped — Sales at risk, sales lost to sell-outs, cash stuck and sold-out page visits
- Shipped — Numbers refreshed monthly
- Shipped — Top 10 actions and a Monday email
- Shipped — Order plan preview (top 10)

### Growth

- Shipped — Numbers refreshed daily, and every action
- Shipped — Reorder plan with suppliers and purchase orders
- Shipped — 90-day order calendar
- Shipped — Preorder bridge and dead-stock discounts
- Shipped — Season planner (1 scenario) and forecast accuracy
- Shipped — Slack and Shopify Flow

### Pro

- Shipped — Planning per location and per POS store
- Shipped — Transfers from warehouse to stores, created in Shopify
- Shipped — Unlimited planner scenarios

## Links and contacts

- Privacy policy: `https://inventory.keha.io/privacy`
- Terms: `https://inventory.keha.io/terms`
- Support email: the value of `INVENTORY_SUPPORT_EMAIL` on Railway (the pages fall back to support@keha.io). **[Kanwar to confirm]**
- Emergency developer contact (phone + email). **[Kanwar to confirm]**
- App icon 1200 × 1200, no text. Screenshots and feature image: `SCREENSHOTS.md`. Screencast: `SCREENCAST.md`.
- Reviewer instructions: `REVIEWER.md`. Protected customer data answers: `PCD-ANSWERS.md`.
