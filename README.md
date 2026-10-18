# Keha Inventory Planner

Shopify app: *Keha turns a store's sales and stock into an order plan — what to order from each supplier, how many, the last day to order and the cash each week needs — plus a weekly to-do list (reorder, promote, fix, clear) ranked by money at stake.*

- **Plan of record:** `inventory-intelligence/KEHA-INVENTORY-INTELLIGENCE-SPEC-v1-2026-10-16.md` (Nova Apps Platform project).
- **Lessons and rules:** `platform/KEHA-SHOPIFY-APP-PLAYBOOK-2026-10-16.md` (same project).
- **Handle:** `keha-inventory` · **code slug:** `inventory` · **host:** `inventory.keha.io` · **Admin API:** 2026-10.
- **Plans:** Free / Growth $49 / Pro $99 (Shopify App Pricing handles `free`, `growth`, `pro`).

Built from the Encore (Keha Preorder) app kit (playbook §2): React Router 7, Polaris web components, Prisma + Postgres, Railway, vitest.

## What the app does today (phases 1–3)

| Area | What the merchant gets | Plan |
|---|---|---|
| Dashboard (`/app`) | "Due this week" first (per supplier: products, units, cash, order-by date, **Review order**) and the 13-week cash strip, from the forward order plan; then 4 money cards (sales at risk, lost sales, cash tied up, out-of-stock page visits) with "how we got this"; this week's actions (Reorder · Stock gaps · Promote · Product issues · Clearance) with mark as done / snooze / dismiss; setup guide (lead times, suppliers, costs, weekly summary email); while the store is read for the first time, "Setting up your order plan" (stages with months read, the time left measured from the store's own read, plain error copy naming the month, what to do meanwhile, "we'll email you when your order plan is ready" — one email per store, `plan_ready`), then "Based on the last 90 days so far" on the numbers until older months are in and "Your order plan is ready" for 3 days; Shopify's review request once after a success moment | Free: weekly refresh, top 10, order plan preview (top 10, read only) · Growth+: daily, all |
| Products (`/app/products`) | One row per variant (status, stock, incoming, sales per day while in stock, days of stock, order by, suggested qty), filters, CSV export; variant page with 13 months of sales (out-of-stock days shaded) and how the forecast was built; Ordering: "Don't reorder", the product's case size and its **supplier code** (article / style number on purchase orders) | Forecast columns and CSV: Growth |
| Order plan: Due now (`/app/reorder`) | Everything due in the next 7 days, overdue included (the forward plan's orders, engine/forward-plan-shared ORDER_NOW_DAYS — the Dashboard's "Due this week"), grouped by supplier, each line on its own order-by date, with case packs and minimums; orders Draft → Sent → Confirmed → Received; drafts editable (quantities, lines) or deleted with the save bar; drafts older than 14 days stop counting as ordered; Receive items per line (partial, close the rest as short), reopen within 30 days; PDF (a size grid: one row per style and color, sizes as columns, style code, totals; lib/po-grid-shared) / CSV (one line per variant, or the size grid) / email to the supplier — never freight & duty; Shopify purchase orders read as "Shopify PO"; landed orders close themselves inside the arrival window | Growth (Free: read-only top-10 preview) |
| Order plan: Build purchase order (`/app/reorder/build?supplier=<key>[&from=&to=]`) | One purchase order per supplier per cycle: its lines due now (or in an Order calendar week) and due before its next order — up to the end of the supplier's order cycle (Settings → Suppliers "Order every … days", else the store's cycle) — each with its own order-by date and "Why this quantity", plus any of its products added by hand ("Add products"); editable and selectable lines, live units and cost (store and supplier currency), the supplier's minimums applied once to the whole order with a one-click top-up; "Create purchase order" (one Keha draft) or "Add to PO-00xx" (the supplier's fresh draft, one line per variant), after a confirm; opened from each Due now supplier card and each Order calendar supplier-week | Growth (Free: teaching lock with the supplier's own numbers) |
| Order plan: Order calendar (`/app/reorder/calendar`) | Every order for 13 weeks by week and supplier (order-by date, arrival, quantity, cost + freight & duty; unknown costs counted, never 0), the cash strip — each payment in the week it is paid (supplier payment terms: deposit when ordering, balance at shipment / on arrival / N days after; freight & duty on arrival; lib/cash-shared) with what is still due on open orders ("committed") — CSV; with a monthly budget (Settings → Defaults) each month's cash out against it and, over it, **Fit to budget**: the lowest-priority orders (money at stake per day ÷ days of stock) that could wait until next month without breaking a supplier minimum — a suggestion, nothing is changed; "Create purchase order" opens Due now for that supplier | Growth |
| Order plan: Purchase orders (`/app/reorder/orders`) | Keha drafts / sent / confirmed and Shopify purchase orders not received yet: ship date, arrival (confirmed ship date + the supplier's transit days, else the lead-time estimate), units still to come, age, old drafts and overdue arrivals flagged; sorted by arrival | Growth |
| Order plan: Season planner (`/app/reorder/season`; `/app/planner` redirects) | Scenarios (Black Friday, Christmas, custom dates; grow X %, revenue target or keep pace): demand per collection, order list with order-by dates, cash needed per week (chart + table), last year's same period; collection goals; accuracy scorecard ("Forecast accuracy"). Read-only: changes nothing in the store | Growth: 1 scenario · Pro: unlimited |
| Locations and stores | Settings → Locations: "Included in purchase orders" per location (every plan; POS stores count unless left out) and warehouse / store roles (Pro); per-location metrics; location switcher on Products, its CSV and Due now; transfer plan warehouse → stores on Due now (shown when two or more locations are planned), "Create transfer in Shopify" after a confirm creates a **draft** transfer (`inventoryTransferCreate`, idempotent) | Roles, per-location planning, transfers: Pro (the include toggle: every plan) |
| Supplier confirmation link (`/supplier/confirm/:token`) | Public page, no login: the supplier sees only that order, picks the ship date, downloads the PDF; expires 60 days after sending; rate-limited | Growth |
| Clearance | A Shopify discount (automatic or code) for dead stock / overstock, created only after a confirm; cash recovered tracked | Growth |
| Stock gaps (action kind `bridge`) | "Take preorders" opens Keha Preorder pre-filled when it is installed; otherwise a back-in-stock how-to | Growth |
| Settings | Defaults (lead time, cycle, safety stock, thresholds, year-over-year growth — off by default), Suppliers (email encrypted; lead time, transit time, order cycle — "Order every … days", else the store's, minimum per item — per size/color or per product, minimum order total in units, minimum order value, currency and exchange rate, case pack, hide prices from the supplier, payment terms — deposit % and when the rest is paid, freight & duty %; each supplier's measured delivery from received orders — "Usually 6 days late", on-time share, spread — which, from 3 deliveries, adds the lead-time variability to safety stock: z × √(P × σd² + d² × σL²); lib/lead-time-shared), Defaults' monthly budget for stock (optional), Locations, Alerts (weekly summary email recipients, instant alerts, Slack webhook encrypted) | Suppliers, Slack: Growth · Locations: include toggle every plan, roles Pro |
| Settings → Import & export (`/app/settings/import`; templates `/app/settings/import/suppliers.csv`, `/app/settings/import/product-settings.csv`) | Setup at scale: download the suppliers file (every Settings → Suppliers field, payment terms and freight & duty included) and the product settings file (supplier, case pack, Don't reorder and supplier code per variant) with the current values, edit them in a spreadsheet, upload; the check shows what will change (row, column, from → to), rows with problems (skipped, with line and column) and rows not found, and nothing is saved until **Import**, which re-checks the file and writes only the previewed changes (refused when the store changed since). Products match by variant_id, then sku, then handle (a handle row sets every variant); suppliers by name (new names added, none deleted). A column left out keeps its values, an empty cell clears; comma, semicolon or tab separated, up to 50,000 rows / 10 MB; the columns are one registry (`lib/setup-import-shared`) | Growth (`csvImport`; Free: the teaching lock with the column reference) |
| Weekly summary | No email provider (owner decision 2026-10-18, the default): Shopify Flow trigger "Weekly order plan ready" (every plan, once per store week; the merchant's workflow emails it — `docs/FLOW-TEMPLATES.md`); with a provider also the weekly summary email. 08:00 store time: "Due this week" first (one line per supplier: units, cash, order-by date, overdue flagged, Review order; the cash to pay in those 7 days when payment terms or open orders make it differ; Free: its top-10 preview, read only), a subject that leads with the job ("2 orders due this week · first by …") and the money at stake in the preheader, then the 4 numbers with week-on-week change, top 5 actions with buttons, last month's accuracy line, unsubscribe link (+ List-Unsubscribe); in the store's language; same summary to Slack | Free: top 10 · Growth+: full; Slack: Growth |
| Instant alerts | Hourly: a best seller will run out within its lead time, or a busy product out of stock; Slack on Growth, email only when a provider is configured (else by email through Flow's "Product needs reorder"); once per product per 7 days | All |
| Shopify Flow | Triggers "Weekly order plan ready" and "First order plan ready" (every plan), "Product needs reorder" and "Product became dead stock" (Growth) (`extensions/keha-inventory-flow`); template extensions to add after exporting the workflows: `docs/FLOW-TEMPLATES.md` | All / Growth |
| Purchase order to the supplier | "Open in your email": a mailto in the supplier's PO language (≤ 1,800 characters, "+N more lines in the order link"), from the merchant's own address, then Mark as ordered; "Email supplier" only with a provider; the supplier page offers PDF and CSV | Growth |
| Shopify Sidekick | App data extension (`extensions/keha-inventory-sidekick`, target `admin.app.tools.data`): six read-only tools — the 13-week order plan by supplier and week (the same forward plan as Due now and Order calendar), product stock, this week's actions, money at stake, open purchase orders, forecast accuracy — answered from the database by `/api/sidekick/:tool`; `[sidekick] extensions_summary` in both tomls | What each plan's screens show (Free: the read-only order-plan preview of the 10 most urgent products; no purchase orders or accuracy; no forecast fields; top 10 actions) |
| Accuracy | Monthly forecast snapshot and grading of last month (top 20 variants + store total); in the weekly summary email and the Season planner's scorecard | Growth |
| Privacy | No shopper data stored; GDPR webhooks; 48 h purge after uninstall; access log | All |
| Sample data (`POST /app/sample`) | While the store isn't ready, the Dashboard offers "Explore Keha with sample data": a simulated clothing store (`app/lib/sim`, 60 products, 14 months) under its own data key `<shop>#sample` — every screen reads it (`services/data-scope.server`), a banner on every page says so, store-changing actions (discounts, transfers, emailing / sending POs, Slack, weekly summary email, Flow, alerts, the review ask) are off; "Switch to my store" deletes it (as do shop/redact and the uninstall purge); Sidekick always answers from the real store | Shows at least Growth on every plan |

Every plan-card line in `PLAN_POINTS` is built; `tests/listing.test.ts` fails if the listing
ever marks one "Not built yet". Spec phase 4: the Sidekick data tools are built; ad-stock control,
linked stores and benchmarks are not started and need separate approval.

## Backtest (spec §16, Phase 0.3)

```bash
npm run backtest -- --shop <store>.myshopify.com --month 2026-09 --months 3
```

Replays the store's own history (this app's database, `DATABASE_URL`) up to the end of each
month M, forecasts M+1 with the real engine, and prints the top-20 and store-total absolute %
errors plus the 4 money numbers as of the end of M. Read-only; writes
`backtest-<shop>-<date>.json` in the current directory (gitignored: it holds store data). The
store must have installed the app with its consent. Maths: `app/lib/engine/backtest-shared.ts`.

## Store simulator (end-to-end simulation)

```bash
npm run sim:check                     # S store (60 products) through the app: counts, totals, plan
npm run sim:check -- --size M         # M store (600 products), report only (add --pipeline)
```

`app/lib/sim` simulates an apparel store for 14 months (seasons, Black Friday, suppliers with
minimums and case packs, stock-outs, backorders, returns, wholesale, open purchase orders) and
answers the sync's ShopifyQL reads; `services/sample-data.server` writes it through the sync's own
writers. `tests/e2e-sim` runs the real compute and every screen's loader on it and checks the
business invariants (one order-by date per variant, Due now = Dashboard = weekly summary email =
Sidekick, minimums met, …) on the in-memory database and — when reachable — real Postgres (S and M).

## App Store listing

`docs/listing/`: listing text (`LISTING.md`, limits enforced by `tests/listing.test.ts`),
screenshots, screencast script, reviewer instructions, draft protected-customer-data answers.
`/privacy` and `/terms` state only what the code does (`app/lib/legal.server.ts`, `tests/legal.test.tsx`).

## Gates (run after every change)

```bash
npm run typecheck   # react-router typegen && tsc --noEmit
npx vitest run
npm run build       # the only gate that catches a .server import in client code
```

In a sandbox without the Prisma engines download:

```bash
PRISMA_SCHEMA_ENGINE_BINARY=/tmp/x PRISMA_QUERY_ENGINE_LIBRARY=/tmp/x \
PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 npx prisma generate --no-engine
```

## Database changes

Real migrations only (`prisma/migrations`; `tests/migrations.test.ts` fails if the schema and
migrations disagree). Railway runs `prisma migrate deploy` on boot (`npm run setup`).

- On a machine with Prisma engines and a local Postgres: `npx prisma migrate dev --name <change>`.
- Add-only: never drop or rename a column without an impact note and approval (CHANGE-CONTROL I-4).

## Layout

```
app/
  shopify.server.ts        auth, App Pricing hooks, apiVersion 2026-10
  routes/                  thin routes (admin screens, webhooks, cron, health, legal)
  lib/*-shared.ts          pure logic + types (client-safe, unit-tested)
  lib/engine/*-shared.ts   the forecasting engine (spec §7) — pure functions
  models/*.server.ts       per-entity DB and Admin API reads/writes
  services/*.server.ts     workflows: sync, compute, email, pricing, GDPR, scheduler
  components/              Polaris web-component UI
extensions/
  keha-inventory-flow/     Shopify Flow triggers (2 × flow_trigger)
  keha-inventory-sidekick/ Sidekick app data tools (ui_extension, admin.app.tools.data)
tests/                     vitest: unit, SSR per screen, contracts, translation coverage
```

## Environment variables

Exactly the variables the code reads (`.env.example`; `tests/config.test.ts` and
`tests/readme.test.ts` keep the three lists equal). Secrets live in Railway variables.

| Variable | Purpose |
|---|---|
| `SHOPIFY_API_KEY` | App client ID (prod `5bc85cc9…`, dev `697e77fb…`) |
| `SHOPIFY_API_SECRET` | App secret; also the webhook HMAC key |
| `SHOPIFY_APP_URL` | `https://inventory.keha.io`; also builds supplier and email links |
| `SHOPIFY_APP_HANDLE` | `keha-inventory` (equals the toml `handle`) |
| `SHOPIFY_APP_GID` | Optional `gid://shopify/App/<id>` (skips a lookup in plan checks) |
| `SCOPES` | Equals `[access_scopes]` in both tomls |
| `SHOP_CUSTOM_DOMAIN` | Optional, dev stores on a custom domain only |
| `SHOPIFY_PARTNER_ORG_ID` | Partner org ID for App Pricing plan checks |
| `SHOPIFY_ORG_ID` | Fallback for `SHOPIFY_PARTNER_ORG_ID` |
| `SHOPIFY_PARTNER_API_TOKEN` | Partner API token ("Manage apps" + "View financials") |
| `DATABASE_URL` | Railway Postgres (private network); also read by `npm run backtest`. The app adds `connection_limit=10&pool_timeout=20` unless the URL sets them; behind PgBouncer add `pgbouncer=true` |
| `APP_ENCRYPTION_KEY` | 64 hex chars, AES-256-GCM for the Slack webhook and supplier emails. Required in production (without a valid key those secrets are not saved); rotating it is not supported (stored values must be entered again) |
| `NOVA_API` | Nova platform base URL |
| `NOVA_INGRESS_HMAC_SECRET` | Signs forwarded webhooks (`X-Nova-Signature`) |
| `NOVA_INSTALL_CONFIRM_SECRET` | Signs the install-confirm callback |
| `INVENTORY_CRON_SECRET` | Bearer token for `/cron/*` |
| `INVENTORY_DISABLE_INTERNAL_CRON` | `1` only when an external scheduler runs the jobs |
| `WORKER_MODE` | `all` (default: pages, timers and job workers in one service) · `web` (pages only) · `worker` (timers and jobs only) — see Scaling |
| `INVENTORY_WORKERS` | Background jobs run at once per instance (default 2) |
| `INVENTORY_EMAIL_API_URL` | Email API (default `https://api.resend.com/emails`); `/privacy` names the provider from it |
| `INVENTORY_EMAIL_API_KEY` | Optional (none by default, owner decision 2026-10-18): email API key. When set with `_FROM`, the app also sends the weekly summary email, instant-alert emails, "Email supplier" and data-request emails; without it everything works through Shopify Flow and the merchant's own email app (`/health` `config.email`: `flow` / `provider`) |
| `INVENTORY_EMAIL_FROM` | Verified sender, e.g. `Keha <mail@keha.io>` |
| `INVENTORY_LEGAL_NAME` | Company name on `/privacy` and `/terms` |
| `INVENTORY_SUPPORT_EMAIL` | Support / privacy contact (falls back to `support@keha.io`) |
| `INVENTORY_LISTING_URL` | App Store listing URL once live (falls back to `https://keha.io/inventory`) |

## Scaling (DB audit 2026-10-17)

- **Background work is a Postgres job queue** (`Job`, `JobLease`; `app/lib/jobs-shared.ts`): the hourly
  ticks only queue per-shop jobs (backfill, nightly, compute, alerts, accuracy, plan checks) and `INVENTORY_WORKERS` workers
  per instance run them, claimed with `FOR UPDATE SKIP LOCKED` together with a lease on the shop, so a
  job runs once and a shop's jobs one at a time across any number of instances. Installs queue their
  backfill. `/health` → `jobs` shows due / running / failing jobs and the oldest wait.
- **Production: run a second Railway service with `WORKER_MODE=worker`** (same repo and start command,
  same variables) and set the web service to `WORKER_MODE=web`, so syncs and compute never share an
  event loop with merchants' page loads (required before large stores install: compute logs a warning
  for a store above 5,000 variants in a `WORKER_MODE=all` production process — `docs/OPERATIONS.md`
  "Services"). `INVENTORY_WORKERS` loops share one process and one core: add CPU with worker replicas.
  Development needs no change (`WORKER_MODE` unset = `all`).
- **Connections:** each process uses at most 10 (`connection_limit`, overridable in `DATABASE_URL`);
  compute keeps at most 3 of its reads in flight. With PgBouncer (transaction mode) add
  `pgbouncer=true` to `DATABASE_URL` and run `prisma migrate deploy` against the direct URL — every
  statement is single-statement or a batch transaction, no session locks.
- **Fact tables for 1,000+ stores** (`docs/SCALE.md`, `docs/OPERATIONS.md`): daily sales, stock and visits
  live in compact, monthly-partitioned tables (`SalesFact`, `StockMonth` — one row per variant ×
  location × month —, `SessionsFact`) keyed by `Shop.num`, the variant's GID number and a `FactKey`
  dictionary; models and services read them through `services/facts-store.server` in their own ids.
  The store-wide `maintenance` job creates months ahead and drops months past retention (sales and
  visits 25 months, stock 430 days). VariantMetric, Variant and StockNow are written only when a row
  changed. Load test: `npm run loadtest:db -- --stores 100`.
- **Large stores:** stock history is streamed and written a few days at a time (250,000 rows); the
  1,000,000-row read cap splits the date range instead of failing; compute works in chunks of 2,000
  variants and reads stored first / last days (`Variant.firstStockDay` …, `VariantLocationDays`)
  instead of every variant's whole history. Invariants: `tests/scale.test.ts`.

## Config

- `shopify.app.toml` — production (never auto-updates URLs). `shopify.app.dev.toml` — the separate dev app.
- `.env.example` — every env var the code reads (a test keeps it in sync).
