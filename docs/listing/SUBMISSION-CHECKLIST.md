# App Store submission checklist — Keha Inventory Planner

Checked 2026-10-17 against the live shopify.dev pages, requirement by requirement:

- App Store requirements: https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements (1.1.1 – 5.11.13)
- Pass app review: https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review
- Privacy law compliance (mandatory webhooks): https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
- Listing best practices (field limits): https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices
- Built for Shopify (reference only, not needed to publish): https://shopify.dev/docs/apps/launch/built-for-shopify/requirements

The "quality checks" page linked from the requirements (`/docs/apps/launch/app-store-review/app-quality-checks`)
has no checklist of its own: it describes the periodic re-check (answer within 7 days, fix within 30).

Status: ✅ met (code or test proves it) · ⚠️ needs a live check on the released app · ❌ gap · 🧑 owner action ·
— not applicable (category the app is not in).

## Owner actions before submit (in this order)

1. **Deploy the current main and push the config**: Railway deploy, then `npm run deploy` and release the
   version, so `read_locales` (commit 4632c78) reaches Shopify. Open the app once on every installed store
   (dev store, demo store, design partners) and accept the new permission. Live `/health` on 2026-10-16 22:36 UTC
   still showed `"backfill:error":1` — the shopLocales failure this fixes.
2. **Turn on the plan check** on Railway: `SHOPIFY_PARTNER_API_TOKEN` and `SHOPIFY_PARTNER_ORG_ID` (or
   `SHOPIFY_ORG_ID`). Live `/health` shows `"pricing":{"configured":false}`: every plan change shows "Plan not
   checked yet" and nothing is locked — the exact reason a previous review failed 1.2.2 / 1.2.3
   (`app/services/app-pricing.server.ts:101`). Done when `/health` shows `pricing.lastOkAt`.
3. **No email provider needed** (owner decision 2026-10-18): leave `INVENTORY_EMAIL_API_KEY` /
   `INVENTORY_EMAIL_FROM` unset; `/health` shows `"config":{"email":"flow"}` — the normal setup, not a
   failure. Purchase orders go out from the merchant's own email app ("Open in your email"), the weekly
   summary and the first-plan notice reach the merchant by email through Shopify Flow triggers, and
   data requests are answered in the access log. **Instead: the Flow templates** — build the three
   workflows in the dev store, export each `.flow`, add the template extensions and deploy
   (`docs/FLOW-TEMPLATES.md`; they go through Flow's own review, which doesn't block the app version).
   Optional and not needed for review.
3b. **Worker service** on Railway: a second service from the same repo with `WORKER_MODE=worker`, and the web
   service on `WORKER_MODE=web` (`docs/OPERATIONS.md` "Services"). With one service (`all`), a large store's
   nightly compute shares the core with page loads; compute logs a warning above 5,000 variants.
4. **Legal name** on Railway: `INVENTORY_LEGAL_NAME` = the registered company. The live privacy and terms pages
   name the operator only as "Keha".
5. **Partner Dashboard → App pricing** (Shopify App Pricing): `free`, `growth` $49 / $490, `pro` $99 / $990,
   7-day trial on paid plans, exactly as `LISTING.md` → Pricing. Welcome link = `/app`.
6. **Partner Dashboard → API access → Protected customer data**: request Level 2 (needed by
   `shopifyqlQuery` / `read_reports`, shopify.dev states "Level 2 access to Customer data including name,
   address, phone, and email fields"); answers from `PCD-ANSWERS.md`, every **[Kanwar to confirm]** resolved.
7. **Partner Dashboard → Settings → Emergency developer contact** (phone + email) — requirement 4.5.6.
8. **Demo store** with ≥ 90 days of history (13 months for Planner seasonality), a warehouse and a POS store,
   two suppliers, one Planner scenario; put its URL and a staff/collaborator login that opens every feature
   into `REVIEWER.md` part A (4.5.4 / 4.5.5). Check the login works the day you submit.
9. **Listing form** (`LISTING.md`): name, subtitle, introduction, details, features, 5 search terms, category
   (Store management → Inventory), **languages = the 8 the admin supports** (English, Spanish, French, German,
   Italian, Portuguese, Dutch, Polish — 4.3.2), integrations (Shopify Flow, Slack), support email,
   privacy policy `https://inventory.keha.io/privacy`. Sales channel requirement: **not** "Merchant must have
   online store" (no storefront part, 4.3.1).
10. **Images**: icon 1200 × 1200 without text; 3–6 screenshots 1600 × 900 with no prices, no reviews, no
    Shopify logo, no browser chrome, each different (`SCREENSHOTS.md`, 4.2.2, 4.3.4, 4.3.6, 4.4.3–4.4.5).
11. **Screencast** last, on the released version (`SCREENCAST.md`, 4.5.3): English, setup and every core
    feature step by step; unlisted link in the form.
12. **Live click-through** of every ⚠️ row below on the released app — one fresh dev store with no data and
    the demo store — in Chrome incognito (third-party cookies blocked).
13. **Code fixes owned by other builders** (none blocks submission; see "Gaps in files I don't own").

## Requirements

### 1. Policy

| Requirement | Where in the docs | Status | Evidence | Fix |
|---|---|---|---|---|
| Use session tokens; work without third-party cookies or local storage (incl. Chrome incognito) | 1.1.1 | ✅ / ⚠️ | `authenticate.admin` on every admin loader (`app/routes/app.tsx:35`), library token exchange; `localStorage` only remembers a manual language choice inside try/catch, falling back to the detected language (`app/lib/i18n.tsx:128-146`); downloads use `fetch` with the session token (`app/components/download-button.tsx`) | Live: open every screen in incognito |
| Use Shopify checkout; don't bypass it | 1.1.2 | — | No checkout or payments | — |
| Themes only from the Theme Store | 1.1.3 | — | No themes | — |
| Only factual information (no fake data) | 1.1.4 | ✅ | Missing data shows "—", never 0 (I-5; `tests/home-ssr.test.tsx`); numbers come from the store's own data | — |
| Unique app (no duplicate of own apps) | 1.1.5 | ✅ | Keha Preorder is a different product; the bridge never names it unless installed (`app/lib/action-list-shared.ts:14-16`) | — |
| Single-merchant storefronts / no marketplaces | 1.1.6 | — | No storefront | — |
| Payment gateways via Payments API | 1.1.7 | — | — | — |
| POS apps only for Shopify POS | 1.1.8 | — | Reads POS locations through Shopify only | — |
| Buyer consent before charges | 1.1.9 | — | No buyer-facing part | — |
| Cheapest shipping as default | 1.1.10 | — | — | — |
| Browser extensions optional | 1.1.11 | — | None | — |
| Web-based (no desktop app) | 1.1.12 | ✅ | Embedded web app (`shopify.app.toml` `embedded = true`) | — |
| Duplicate only authorized product info | 1.1.13 | — | Doesn't copy products | — |
| No connecting merchants to agencies / freelancers | 1.1.14 | ⚠️ | `/install?ref=` (`app/routes/install.tsx`) only records a partner code and forwards to the listing; nothing in the admin connects a merchant to an agency | Keep partner attribution invisible in the admin; don't mention partners in the listing |
| Refunds only through the original processor | 1.1.15 | — | — | — |
| No capital lending | 1.1.16 | — | — | — |
| Bill through Shopify App Pricing / Billing API | 1.2.1 | ✅ | Shopify App Pricing; no off-platform charge, no `appSubscriptionCreate` (`app/services/app-pricing.server.ts:1-24`, `app/services/billing.server.ts:6`) | — |
| Implement correctly: accept, decline, re-approve on reinstall | 1.2.2 | 🧑 ⚠️ | Plan read from the Partner API on load, on return with `plan_handle` (`app/routes/app.tsx:41-47`) and every 6 h; no subscription = Free (`tests/plans.test.ts` "treats no subscription as Free"). **Live `/health`: `pricing.configured: false`** | Owner actions 2 and 5; live: install → pick Growth → decline once → reinstall → plan page again |
| Plan changes without support or reinstall; in charge history | 1.2.3 | 🧑 ⚠️ | Plans & billing → "Choose plan" opens Shopify's plan page (`app/routes/app.plans.tsx:60`, `window.open(url, "_top")` = top-frame navigation, not a popup) | Owner action 2; live: Growth → Pro → Free, check charge history |
| No incentives for reviews | 1.3.1 | ✅ | The app never asks for a review (no review prompt in any `app/lib/i18n-*.ts` string) | — |

### 2. Functionality

| Requirement | Where in the docs | Status | Evidence | Fix |
|---|---|---|---|---|
| No critical errors (no 404 / 500 / 3xx pages blocking review) | 2.1.1 | ⚠️ | SSR tests per screen (`tests/*-ssr.test.tsx`, `tests/settings.test.tsx`); `boundary.error` / `boundary.headers` on the admin layout (`app/routes/app.tsx:144-151`). Production backfill failed on `shopLocales` until 4632c78 | Owner action 1; live click-through (owner action 12) |
| No minor errors | 2.1.2 | ⚠️ | Same as above | Live click-through |
| Has a UI | 2.1.3 | ✅ | Six admin screens in `s-app-nav` (`app/routes/app.tsx:114-127`) | — |
| Data stays in sync with the admin | 2.1.4 | ✅ | Webhooks for stock, products, locations + nightly re-read (`app/routes/webhooks.*.tsx`, `tests/sync/*`); purchase orders and transfers read from Shopify | — |
| Uses Shopify APIs | 2.2.1 | ✅ | Admin GraphQL throughout (`tests/admin-schema.test.ts`) | — |
| Consistent embedded experience | 2.2.2 | ✅ | Every merchant flow is in the admin; the supplier confirmation page (`app/routes/supplier.confirm.$token.tsx`) is for suppliers, not merchants | — |
| Latest App Bridge, script before other scripts | 2.2.3 | ✅ | `AppProvider` renders `https://cdn.shopify.com/shopifycloud/app-bridge.js` (always latest) as the first `<script>` of the document, before Polaris and the app bundle (`app/routes/app.tsx:134`, `node_modules/@shopify/shopify-app-react-router/.../AppProvider.mjs:43,59`; `app/root.tsx` puts `<Scripts />` after `<Outlet />`) | BFS 3.1.1 wants it in `<head>`: see BFS notes |
| GraphQL Admin API only | 2.2.4 | ✅ | No REST call in `app/` (no `admin.rest`, no `/admin/api/*.json`); the Partner API call is the documented App Pricing read | — |
| Admin extensions feature-complete | 2.2.5 | — | No admin UI extensions (only Flow triggers in `extensions/keha-inventory-flow`) | — |
| No promotions in admin extensions | 2.2.6 | ✅ | None; and the in-app preorder bridge never names another app unless the merchant has it (`app/lib/action-list-shared.ts:14-16`) | — |
| Max modal only after merchant interaction | 2.2.7 | — | No max modal (`s-modal` only, `app/components/wc.tsx:89`) | — |
| Sidekick extension matches functionality | 2.2.8 | ✅ | `extensions/keha-inventory-sidekick`: six read-only tools (order plan, product stock, actions, money at stake, open purchase orders, forecast accuracy) — the same numbers as the admin (`tests/sidekick-endpoint.test.ts`); no tool changes the store (no mutation in `app/services/sidekick.server.ts`, I-1). The listing details say "It also answers in Shopify Sidekick" and `LISTING.md` maps it to the code (`tests/listing.test.ts`); Sidekick is not an Integration (it is part of the app) | — |
| No promotions / cross-selling in Sidekick | 2.2.9 | ✅ | `tests/sidekick-extension.test.ts` "no text Sidekick reads sells, urges or steers": the description, app summary, instructions, every tool and answer text pass the content-policy lint (no plan upsell, no other app, no competitor, no review ask) | — |
| Install only from Shopify surfaces (no shop-domain form) | 2.3.1 | ✅ | `/` and `/auth/login` never ask for a shop; they forward to the public page (`app/routes/_index/route.tsx`, `app/routes/auth.login/route.tsx`); `/install?ref=` forwards to the listing (`app/routes/install.tsx`) | — |
| OAuth immediately after install | 2.3.2 | ⚠️ | Shopify managed installation: scopes in `shopify.app.toml [access_scopes]`, no legacy install flow | Live: install from the listing on a fresh dev store |
| Redirect to the app UI after OAuth | 2.3.3 | ⚠️ | `application_url` + `/app`; `afterAuth` hook never throws (`app/shopify.server.ts:30-46`) | Live |
| OAuth again after reinstall | 2.3.4 | ⚠️ | Uninstall deletes sessions (`app/routes/webhooks.app.uninstalled.tsx:22-24`); reinstall within 48 h cancels the purge (`app/shopify.server.ts:33`, `tests/gdpr.test.ts:105`) | Live: uninstall → reinstall → permissions screen shown |

### 3. Security

| Requirement | Where in the docs | Status | Evidence | Fix |
|---|---|---|---|---|
| Valid TLS certificate | 3.1.1 | ✅ | `https://inventory.keha.io/privacy`, `/terms`, `/health` load over HTTPS (fetched 2026-10-17) | — |
| Request only necessary scopes | 3.2 (intro) | ✅ | **Machine-checked**: `tests/admin-scopes.test.ts` fails if a used field / webhook topic is not granted, or a requested scope is used by nothing (I-8). 8 scopes, each explained in `REVIEWER.md` and on `/privacy` (`tests/legal.test.tsx:35`, `tests/listing.test.ts:106`) | — |
| `read_all_orders`, `write_payment_mandate`, `write_checkout_extensions_apis`, `read_advanced_dom_pixel_events`, `read_checkout_extensions_chat` only if needed | 3.2.1 – 3.2.5 | ✅ | None requested (`shopify.app.toml` `scopes`) | — |
| Mandatory compliance webhooks subscribed | privacy-law-compliance | ✅ | `compliance_topics` for `customers/data_request`, `customers/redact`, `shop/redact` (`shopify.app.toml`), routes exist (`tests/config.test.ts`) | — |
| Compliance webhooks: 401 on a bad HMAC, 2xx when valid | privacy-law-compliance | ✅ | `tests/compliance-webhooks.test.ts` runs all three routes against a real `shopifyApp`: bad HMAC → 401 and nothing runs; valid → 200 and the handler runs | — |
| Act within 30 days; shop data deleted on `shop/redact` | privacy-law-compliance | ✅ | Data request answered at once in the access log (no customer data held; also by email to the owner when a provider is set — `tests/gdpr.test.ts` "without an email provider"); customer redact removes outbox copies; shop redact purges every shop table (`app/services/gdpr.server.ts`, `tests/gdpr.test.ts:123,148,193,206`); 500 on failure so Shopify retries | — |
| Uninstall cleanup | pass-app-review (data) | ✅ | Token deleted at once, all store data 48 h later (`app/routes/webhooks.app.uninstalled.tsx`, `app/routes/cron.purge-uninstalled.tsx`, hourly in `app/services/scheduler.server.ts`) | — |
| Protected customer data (Level 2 for `read_reports`) | pass-app-review; `queries/shopifyqlQuery` | 🧑 | Queries select no customer field (I-2, `REVIEWER.md` lists them); answers drafted in `PCD-ANSWERS.md` | Owner action 6 |

### 4. App Store listing

| Requirement | Where in the docs | Status | Evidence | Fix |
|---|---|---|---|---|
| Same name in Dev Dashboard and submission form | 4.1.1 | ✅ / 🧑 | `shopify.app.toml` `name` = listing name, ≤ 30 chars (`tests/config.test.ts`, `tests/listing.test.ts:39`) | Type it exactly in the form |
| Unique name leading with a brand identifier | 4.1.2 | ✅ | "Keha Inventory Planner" starts with the brand | — |
| Complete pricing info (trial, charges) | 4.2.1 | 🧑 | `LISTING.md` → Pricing (`tests/listing.test.ts:76`) | Owner action 5 |
| No pricing in images (incl. icon) | 4.2.2 | 🧑 | `SCREENSHOTS.md` rules (Plans & billing page never shot) | Owner action 10 |
| Pricing only in Pricing details | 4.2.3 | ✅ | `tests/listing.test.ts:60` (no price in listing text) | — |
| "Merchant must have online store" only for storefront apps | 4.3.1 | 🧑 | No theme extension | Leave it unticked |
| Languages = merchant UI languages | 4.3.2 | 🧑 | 8 languages (`app/lib/i18n.tsx:36`, `tests/i18n-coverage.test.ts`) | Owner action 9 |
| No stats, unsubstantiated claims, "the first / best / only" in text | 4.3.3 | ✅ | `tests/listing.test.ts` "makes no price, statistic, guarantee, AI or 'first / only' claim" (no `best` except "best sellers", `#1`, guarantee, AI, price, `the first`, `the only`) and "names no plan in the text" | — |
| Same for images | 4.3.4 | 🧑 | `SCREENSHOTS.md` (feature image has no numbers) | Owner action 10 |
| Accurate tags | 4.3.5 | 🧑 | `LISTING.md` → Categories (Orders and shipping → Inventory → Inventory optimization), Integrations, Search terms | Owner action 9 |
| No reviews / testimonials in images or text | 4.3.6 – 4.3.7 | ✅ / 🧑 | None in `LISTING.md` | Keep screenshots free of them |
| Geographic or API-permission requirements stated | 4.3.8 | ⚠️ | No geographic limit. Pro features need a POS location; Flow triggers need Shopify Flow (both in `REVIEWER.md`) | Live: confirm ShopifyQL `sales` / `sessions` answer on a Basic-plan store; if a dataset is plan-limited, say so in the details. Not verified here |
| App card subtitle: concise value, no keywords, no stats | 4.4.1 | ✅ | "Know what to order, from whom, by when and the cash it takes" (`LISTING.md`, ≤ 60 in `tests/listing.test.ts`) | — |
| App details explain functionality, no keyword stuffing | 4.4.2 | ✅ | ≤ 500 chars, prose (`tests/listing.test.ts:45`) | — |
| No Shopify brand misuse in graphics | 4.4.3 | 🧑 | `SCREENSHOTS.md` (no Shopify logo) | Owner action 10 |
| Images show the real UI, no browser chrome / logo-only | 4.4.4 | 🧑 | `SCREENSHOTS.md` shot list | Owner action 10 |
| Each image unique | 4.4.5 | 🧑 | 6 distinct screens planned (`SCREENSHOTS.md` storyboard: Dashboard, Due now, Order calendar, forecast, supplier page, Pro stores) | Owner action 10 |
| Don't reference your other apps in the listing | 4.4 (intro) | ✅ | `LISTING.md` never names another Keha app (`tests/listing.test.ts` "never names another Keha app"); the Integrations field lists Slack and Shopify Flow only; "Preorder bridge" works without any other app (back-in-stock how-to) | — |
| Sales channel classification | 4.5.1 – 4.5.2 | ✅ | Not a sales channel; no channel config in the tomls | — |
| Demo screencast in English, step by step | 4.5.3 | 🧑 | Script: `SCREENCAST.md` | Owner action 11 |
| Test credentials in testing instructions | 4.5.4 | 🧑 | `REVIEWER.md` part A has **[Kanwar to provide]** placeholders | Owner action 8 |
| Credentials valid, full access | 4.5.5 | 🧑 | — | Owner action 8 |
| Emergency developer contact | 4.5.6 | 🧑 | — | Owner action 7 |
| Support email and privacy policy URL | best-practices; listing form | ✅ / 🧑 | `/privacy` and `/terms` load (fetched 2026-10-17); support email from `INVENTORY_SUPPORT_EMAIL`, fallback `support@keha.io` (`app/lib/legal.server.ts:20`). The live page shows it through Cloudflare email obfuscation | Owner action 4; optional: turn off Cloudflare "Email Address Obfuscation" for `inventory.keha.io` so the address is plain text for reviewers and bots |
| Field limits: intro ≤ 100, details ≤ 500, feature ≤ 80, ≤ 5 search terms | best-practices | ✅ | `tests/listing.test.ts:45` | — |
| Screenshots 1600 × 900, 3–6, alt text | best-practices | 🧑 | `SCREENSHOTS.md` | Owner action 10 |

### 5. Category-specific

| Requirement | Where in the docs | Status | Evidence | Fix |
|---|---|---|---|---|
| Online store (theme app extensions, widgets, onboarding, branding, customer data) | 5.1.1 – 5.1.5 | — | No storefront part, no theme changes | — |
| Payment, payment facilitator | 5.2.1 – 5.3.3 | — | — | — |
| Purchase option (subscriptions, preorders) | 5.4.1 – 5.4.19 | — | Keha Inventory takes no preorders itself | — |
| Product sourcing | 5.5.1 – 5.5.5 | — | — | — |
| Checkout customization | 5.6.1 – 5.6.9 | — | — | — |
| Sales channel | 5.7.1 – 5.7.18 | — | — | — |
| Post purchase | 5.8.1 – 5.8.10 | — | — | — |
| Mobile app builders | 5.9.1 – 5.9.3 | — | — | — |
| Donation | 5.10.1 – 5.10.7 | — | — | — |
| Blockchain | 5.11.1 – 5.11.13 | — | — | — |

### Works on a store with no data, and onboarding

| Requirement | Where in the docs | Status | Evidence | Fix |
|---|---|---|---|---|
| UI works on install, no web errors, on an empty store | pass-app-review ("UI must work on install") | ✅ / ⚠️ | The Dashboard shows "Setting up your order plan" (stages, months read, time left, plain error copy, Import from a CSV) and the Setup guide (`app/components/sync-progress.tsx`, `tests/sync-progress-ssr.test.tsx`); with fewer than 14 days of sales, "Not enough sales yet to advise — Your first order plan needs 14 days of sales — expected on {date}." (`app/routes/app._index.tsx:142`, `tests/home-ssr.test.tsx:110,144`); nothing tracked: "No stock tracked yet" with **Open products in Shopify** (`app/routes/app._index.tsx:154`); Due now, Order calendar, the weekly summary email and Sidekick say why there is nothing to order yet; empty states in Products, Order plan, Season planner, Transfers SSR tests | Live on a fresh dev store (owner action 12) |
| Onboarding that guides core setup | BFS 4.2.2 (reference) | ✅ | Setup guide ticked from real state, hidden once done (`app/routes/app._index.tsx:91,233`) | — |

## Built for Shopify (reference — after 50 installs and 5 reviews)

| Requirement | Where in the docs | Status | Evidence | Fix |
|---|---|---|---|---|
| 50 net installs, 5 reviews, minimum rating | BFS 1.2.1 – 1.2.3 | 🧑 | — | After launch |
| LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms (p75, 100+ calls in 28 days) | BFS 2.1.1 – 2.1.3 | ⚠️ | App Bridge reports Web Vitals; the document waits for the full render (`app/entry.server.tsx:26`), locale cached per hour (`app/routes/app.tsx:28-31`) | Watch Partner Dashboard → Web performance after launch |
| App Bridge script in the `<head>` of every document | BFS 3.1.1 | ❌ | Rendered in `<body>` by `AppProvider` (React 18 doesn't hoist scripts) | `app/root.tsx`: add `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key={apiKey}>` as the first child of `<head>` for `/app` documents (needs the API key from a root loader), and drop it from `AppProvider` via its non-embedded path. Not needed for App Store approval (2.2.3 is met) |
| Key metrics on the home page | BFS 3.1.4, 4.2.3 | ✅ | Four money cards + sync status on Home | — |
| Nav: `s-app-nav`, no separate Home item | BFS 4.1.4 | ❌ | `app/routes/app.tsx:120` `<s-link href="/app">Home</s-link>` shows a "Home" item | `app/routes/app.tsx:120`: add `rel="home"` (shopify.dev app-nav: "When set, the link is hidden from the navigation menu") |
| Name doesn't truncate when pinned | BFS 4.1.3 | ⚠️ | 27 characters | Live: pin the app on desktop and look |
| Contextual save bar on forms | BFS 4.1.5 | ❌ | Settings forms save with buttons; no `data-save-bar` / `ui-save-bar` anywhere in `app/` | `app/routes/app.settings_.alerts.tsx`, `app.settings_.suppliers.tsx`, `app.settings_.locations.tsx`: wrap each settings `<form>` with `data-save-bar` (App Bridge save bar) so leaving with unsaved changes asks Save / Discard |
| Modals use `heading` and action slots | BFS 4.1.6 | ⚠️ | `s-modal heading=…` (`app/components/wc.tsx:89`) | Check every modal puts its buttons in `primary-action` / `secondary-actions` slots |
| Plan-gated features look disabled and name the plan | BFS 4.3.7 | ✅ | Locked pages and Upgrade banners (`app/components/plan.tsx:63`, `tests/plans-ssr.test.tsx`) | — |
| No auto-appearing modals, no pressure, no false claims | BFS 4.3.1 – 4.3.3 | ✅ | No modal opens without a click; listing test bans guarantees | — |

## Gaps in files I don't own (for their owners)

None of these blocks App Store approval; all are Built for Shopify items.

1. `app/routes/app.tsx:120` — `<s-link href="/app">Home</s-link>` → `<s-link href="/app" rel="home">Home</s-link>` (BFS 4.1.4).
2. `app/routes/app.settings_.alerts.tsx`, `app/routes/app.settings_.suppliers.tsx`, `app/routes/app.settings_.locations.tsx` —
   App Bridge contextual save bar (`<form data-save-bar …>`) on the settings forms (BFS 4.1.5).
3. `app/root.tsx` + `app/routes/app.tsx` — App Bridge script as the first element of `<head>` (BFS 3.1.1).
4. ~~Sidekick extension — 2.2.8 / 2.2.9 rows above~~ — met 2026-10-18 (listing details mention it; tools are read-only and pass the content-policy lint).
5. ~~`tests/listing.test.ts` — also ban `the first` / `the only`~~ — done 2026-10-17 (4.3.3).

## Summary

Each row counted once, by its first status.

- **App Store requirements (83 rows):** ✅ met 36 · ⚠️ live check 7 · ❌ gap 0 · 🧑 owner 17 · — not applicable 23.
- **Built for Shopify reference (10 rows):** ✅ 3 · ⚠️ 3 · ❌ 3 · 🧑 1.

Blocking before submit: owner actions 1–2 (deploy + accept `read_locales`; Partner API credentials for the plan
check) — both are visible failures on the live app today.
