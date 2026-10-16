# App Store listing — Keha Inventory Intelligence

Partner Dashboard → Apps → Keha Inventory Intelligence → Distribution → Manage listing.
English is the primary listing. Every claim below is something the code does today
(checked 2026-10-16, task 2.7); `tests/listing.test.ts` enforces the limits, the name and the
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
Keha reads your own Shopify sales, stock and store visits and puts a money figure on four problems: sales at risk, sales lost to sell-outs, cash stuck in slow stock, and visits to sold-out product pages. Every Monday you get a ranked list of what to reorder, push, fix and clear, in the app and by email. Sales per day count only the days a product was in stock, so sell-outs never drag a forecast down. Build purchase orders per supplier and let suppliers confirm the ship date through a link.
```

## Feature list

```text
Money at stake: sales at risk, lost to sell-outs, cash stuck, sold-out visits
A weekly to-do list to reorder, push, fix and clear, ranked by money at stake
Forecasts ignore sold-out days and use seasonality once 13 months exist
Purchase orders per supplier as PDF, CSV or email, with a ship-date link
Clear dead stock with a Shopify discount, created only after you confirm
Monday email in your store's language, plus Slack and Shopify Flow alerts
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

Not claimed anywhere in the text because it is not built yet: the season planner, collection
goals, the accuracy scorecard screen (the accuracy line is in the Monday email), planning per
location / POS store, and stock transfers.

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

Plan card features, word for word from `PLAN_POINTS` (`app/lib/plan-matrix.ts`), with what is
shipped today. **Do not publish a "Not built yet" line**: playbook mistake #18 (a listing
promise the app didn't keep). **[Kanwar to confirm]** whether to submit before the planner
(task 2.5) and Pro (phase 3) ship — see `REVIEWER.md`.

### Free

- Shipped — Sales at risk, sales lost to sell-outs, cash stuck and sold-out page visits
- Shipped — Numbers refreshed monthly
- Shipped — Top 10 actions and a Monday email

### Growth

- Shipped — Numbers refreshed daily, and every action
- Shipped — Reorder plan with suppliers and purchase orders
- Shipped — Preorder bridge and dead-stock discounts
- Not built yet — Season planner (1 scenario) and forecast accuracy
- Shipped — Slack and Shopify Flow

### Pro

- Not built yet — Planning per location and per POS store
- Not built yet — Transfers from warehouse to stores, created in Shopify
- Not built yet — Unlimited planner scenarios

## Links and contacts

- Privacy policy: `https://inventory.keha.io/privacy`
- Terms: `https://inventory.keha.io/terms`
- Support email: the value of `INVENTORY_SUPPORT_EMAIL` on Railway (the pages fall back to support@keha.io). **[Kanwar to confirm]**
- Emergency developer contact (phone + email). **[Kanwar to confirm]**
- App icon 1200 × 1200, no text. Screenshots and feature image: `SCREENSHOTS.md`. Screencast: `SCREENCAST.md`.
- Reviewer instructions: `REVIEWER.md`. Protected customer data answers: `PCD-ANSWERS.md`.
