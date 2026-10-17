# Keha Inventory Planner

Shopify app: *Keha turns a store's sales and stock into an order plan — what to order from each supplier, how many, the last day to order and the cash each week needs — plus a Monday to-do list (reorder, promote, fix, clear) ranked by money at stake.*

- **Plan of record:** `inventory-intelligence/KEHA-INVENTORY-INTELLIGENCE-SPEC-v1-2026-10-16.md` (Nova Apps Platform project).
- **Lessons and rules:** `platform/KEHA-SHOPIFY-APP-PLAYBOOK-2026-10-16.md` (same project).
- **Handle:** `keha-inventory` · **code slug:** `inventory` · **host:** `inventory.keha.io` · **Admin API:** 2026-10.
- **Plans:** Free / Growth $49 / Pro $99 (Shopify App Pricing handles `free`, `growth`, `pro`).

Built from the Encore (Keha Preorder) app kit (playbook §2): React Router 7, Polaris web components, Prisma + Postgres, Railway, vitest.

## What the app does today (phases 1–3)

| Area | What the merchant gets | Plan |
|---|---|---|
| Dashboard (`/app`) | "Order this week" first (per supplier: products, units, cash, order-by date, **Review order**) and the 13-week cash strip, from the forward order plan; then 4 money cards (sales at risk, sales lost to sell-outs, cash stuck, sold-out page visits) with "how we got this"; this week's actions (Reorder · Sold out · Promote · Fix · Clear) with mark as done / snooze / dismiss; setup guide (lead times, suppliers, costs, Monday email — shown first while the store is read); sync progress; Shopify's review request once after a success moment | Free: weekly refresh, top 10, order plan preview (top 10, read only) · Growth+: daily, all |
| Products (`/app/products`) | One row per variant (status, stock, incoming, sales per day while in stock, days left, order by, suggested qty), filters, CSV export; variant page with 13 months of sales (sold-out days shaded) and how the forecast was built | Forecast columns and CSV: Growth |
| Order plan: Order now (`/app/reorder`) | Everything due in the next 7 days, overdue included (the forward plan's orders, engine/forward-plan-shared ORDER_NOW_DAYS — the Dashboard's "Order this week"), grouped by supplier, each line on its own order-by date, with case packs and minimums; orders Draft → Sent → Confirmed → Received; drafts editable (quantities, lines) or deleted with the save bar; drafts older than 14 days stop counting as ordered; Receive items per line (partial, close the rest as short), re-open within 30 days; PDF / CSV / email to the supplier; Shopify purchase orders read as "From Shopify"; landed orders close themselves inside the arrival window | Growth (Free: read-only top-10 preview) |
| Order plan: Build supplier order (`/app/reorder/build?supplier=<key>[&from=&to=]`) | One purchase order per supplier per cycle: its lines due now (or in a Next 13 weeks week) and due before its next order — up to the end of the supplier's order cycle (Settings → Suppliers "Order every … days", else the store's cycle) — each with its own order-by date and "Why this quantity", plus any of its products added by hand ("Add products"); editable and selectable lines, live units and cost (store and supplier currency), the supplier's minimums applied once to the whole order with a one-click top-up; "Create draft order" (one Keha draft) or "Add to PO-00xx" (the supplier's fresh draft, one line per variant), after a confirm; opened from each Order now supplier card and each Next 13 weeks supplier-week | Growth (Free: teaching lock with the supplier's own numbers) |
| Order plan: Next 13 weeks (`/app/reorder/calendar`) | Every order for 13 weeks by week and supplier (order-by date, arrival, quantity, cash; unknown costs counted, never 0), the cash strip, CSV; "Create order" opens Order now for that supplier | Growth |
| Order plan: Open orders (`/app/reorder/orders`) | Keha drafts / sent / confirmed and Shopify purchase orders not received yet: ship date, arrival (confirmed ship date + the supplier's transit days, else the lead-time estimate), units still to come, age, old drafts and overdue arrivals flagged; sorted by arrival | Growth |
| Order plan: Season plan (`/app/reorder/season`; `/app/planner` redirects) | Scenarios (Black Friday, Christmas, custom dates; grow X %, revenue target or keep pace): demand per collection, order list with order-by dates, cash needed per week (chart + table), last year's same period; collection goals; accuracy scorecard ("How accurate we were"). Read-only: changes nothing in the store | Growth: 1 scenario · Pro: unlimited |
| Locations and stores | Settings → Locations: "Counts in supplier orders" per location (every plan; POS stores count unless left out) and warehouse / store roles (Pro); per-location metrics; location switcher on Products, its CSV and Order now; transfer plan warehouse → stores on Order now (shown when two or more locations are planned), "Create transfer in Shopify" after a confirm creates a **draft** transfer (`inventoryTransferCreate`, idempotent) | Roles, per-location planning, transfers: Pro (the include toggle: every plan) |
| Supplier link (`/supplier/confirm/:token`) | Public page, no login: the supplier sees only that order, picks the ship date, downloads the PDF; expires 60 days after sending; rate-limited | Growth |
| Clear | A Shopify discount (automatic or code) for dead / too-much stock, created only after a confirm; cash freed tracked | Growth |
| Sold out (action kind `bridge`) | "Take preorders for the gap" opens Keha Preorder pre-filled when it is installed; otherwise a back-in-stock how-to | Growth |
| Settings | Defaults (lead time, cycle, safety level, thresholds, growth assumption — off by default), Suppliers (email encrypted; lead time, transit time, order cycle — "Order every … days", else the store's, minimum per item — per size/colour or per product, minimum order total in units, minimum order value, currency and exchange rate, case pack, hide prices from the supplier), Locations, Alerts (Monday email recipients, instant alerts, Slack webhook encrypted) | Suppliers, Slack: Growth · Locations: include toggle every plan, roles Pro |
| Monday email | 08:00 store time: "Order this week" first (one line per supplier: units, cash, order-by date, overdue flagged, Review order; Free: its top-10 preview, read only), a subject that leads with the job ("2 orders due this week · first by …") and the money at stake in the preheader, then the 4 numbers with week-on-week change, top 5 actions with buttons, last month's accuracy line, unsubscribe link (+ List-Unsubscribe); in the store's language; same summary to Slack | Free: top 10 · Growth+: full; Slack: Growth |
| Instant alerts | Hourly: a best seller will run out within its lead time, or a busy product sold out; email on every plan, Slack on Growth; once per product per 7 days | All |
| Shopify Flow | Triggers "Product needs reorder" and "Product went dead" (`extensions/keha-inventory-flow`) | Growth |
| Shopify Sidekick | App data extension (`extensions/keha-inventory-sidekick`, target `admin.app.tools.data`): six read-only tools — the 13-week order plan by supplier and week (the same forward plan as Order now and Next 13 weeks), product stock, this week's actions, money at stake, open purchase orders, forecast accuracy — answered from the database by `/api/sidekick/:tool`; `[sidekick] extensions_summary` in both tomls | What each plan's screens show (Free: the read-only order-plan preview of the 10 most urgent products; no purchase orders or accuracy; no forecast fields; top 10 actions) |
| Accuracy | Monthly forecast snapshot and grading of last month (top 20 variants + store total); in the Monday email and the Season plan's scorecard | Growth |
| Privacy | No shopper data stored; GDPR webhooks; 48 h purge after uninstall; access log | All |

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
| `INVENTORY_EMAIL_API_KEY` | Email API key (Monday email, alerts, supplier emails, data-request answers) |
| `INVENTORY_EMAIL_FROM` | Verified sender, e.g. `Keha <mail@keha.io>` |
| `INVENTORY_LEGAL_NAME` | Company name on `/privacy` and `/terms` |
| `INVENTORY_SUPPORT_EMAIL` | Support / privacy contact (falls back to `support@keha.io`) |
| `INVENTORY_LISTING_URL` | App Store listing URL once live (falls back to `https://keha.io/inventory`) |

## Scaling (DB audit 2026-10-17)

- **Background work is a Postgres job queue** (`Job`, `JobLease`; `app/lib/jobs-shared.ts`): the hourly
  ticks only queue per-shop jobs (backfill, nightly, compute, alerts) and `INVENTORY_WORKERS` workers
  per instance run them, claimed with `FOR UPDATE SKIP LOCKED` together with a lease on the shop, so a
  job runs once and a shop's jobs one at a time across any number of instances. Installs queue their
  backfill. `/health` → `jobs` shows due / running / failing jobs and the oldest wait.
- **To scale: run a second Railway service with `WORKER_MODE=worker`** (same repo and start command,
  same variables) and set the web service to `WORKER_MODE=web`, so syncs and compute never share an
  event loop with merchants' page loads. Add worker services (or raise `INVENTORY_WORKERS`) as stores
  grow. Today's single service needs no change (`WORKER_MODE` unset = `all`).
- **Connections:** each process uses at most 10 (`connection_limit`, overridable in `DATABASE_URL`);
  compute keeps at most 3 of its reads in flight. With PgBouncer (transaction mode) add
  `pgbouncer=true` to `DATABASE_URL` and run `prisma migrate deploy` against the direct URL — every
  statement is single-statement or a batch transaction, no session locks.
- **Large stores:** stock history is streamed and written a few days at a time (250,000 rows); the
  1,000,000-row read cap splits the date range instead of failing; compute works in chunks of 2,000
  variants and reads stored first / last days (`Variant.firstStockDay` …, `VariantLocationDays`)
  instead of every variant's whole history. Invariants: `tests/scale.test.ts`.

## Config

- `shopify.app.toml` — production (never auto-updates URLs). `shopify.app.dev.toml` — the separate dev app.
- `.env.example` — every env var the code reads (a test keeps it in sync).
