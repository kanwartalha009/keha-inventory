# App review — testing instructions (Keha Inventory Intelligence)

Two parts: **A** is what Kanwar pastes into the Partner Dashboard "Testing instructions" field;
**B** is the checklist for Kanwar before pressing Submit. Every step was written from the code
on 2026-10-16 (task 2.7); labels are the app's English strings.

---

## A. Testing instructions (paste into the submission form)

**What the app does.** Keha reads a store's own products, stock, sales totals and store visits
and shows the money at stake (sales at risk, sales lost to sell-outs, cash stuck, sold-out
page visits), a ranked weekly to-do list, reorder plans with purchase orders, and a Monday
email. It has no storefront part and stores no shopper data.

**Test store requirements.**

1. Products with **Track quantity** on, at least one location that fulfils online orders.
2. **Sales history:** the numbers come from Shopify's own analytics (ShopifyQL), so a brand-new
   store with no orders shows the empty state "We need at least 14 days of sales to give
   advice". To see numbers and actions, use our demo store below, or a test store with
   at least 14 days of orders on tracked products.
3. Shopify Flow (free app) installed, only to see the two Flow triggers.

**Demo store with history:** `<demo-store>.myshopify.com` — collaborator access request or
staff login: **[Kanwar to provide]**. Storefront password (if asked): **[Kanwar to provide]**.

**Plans.** Pricing is Shopify App Pricing. After install, Shopify's plan page opens: pick
**Growth** (or **Pro**) — on a development / test store there is no charge. Free works too and
shows locked features with an explanation and an **Upgrade** button (nothing is hidden). To
switch later: **Plans** in the app menu → **Choose plan** (opens Shopify's plan page).

| Plan | Unlocks |
|---|---|
| Free | The four money numbers (refreshed monthly), the top 10 actions, the Monday email (top 10) |
| Growth | Daily refresh, every action, days of stock left and suggested order quantities, Reorder with suppliers, purchase orders (PDF / CSV / email) and the supplier confirmation link, the preorder bridge, Clear discounts, Fix details, Products CSV export, Slack, Shopify Flow triggers |
| Pro | Everything in Growth (the per-location features listed for Pro are not in this version) |

**Steps (Growth plan, store with history).**

1. Install the app and pick **Growth** on Shopify's plan page. You land on **Home**.
2. Home shows "Reading your store…" with progress per dataset (products, stock history, sales
   history, store visits). The newest 90 days are read first; the numbers appear when they are
   in (minutes on a small store).
3. **Home → money cards:** open "How we got this" on any card to see the inputs. A dash (—)
   means not enough data, never zero.
4. **Home → This week's actions:** switch tabs (All, Reorder, Bridge, Push, Fix, Clear). Each
   row's "…" menu has Snooze, Dismiss and Done.
5. **Clear** tab → **Create discount** → a confirm dialog shows the products and the
   percentage → confirm. The discount appears in Shopify → Discounts. Nothing is created
   without this confirm.
6. **Products:** the table (one row per variant; filters; **Export CSV**). Click a row: the
   product page shows 13 months of sales with sold-out days shaded and "How the forecast was
   built".
7. **Settings → Suppliers:** add a supplier with an email address you can read and assign it
   by vendor.
8. **Reorder:** products grouped by supplier with order-by dates → **Create order** → on the
   order: **Download PDF**, **Download CSV**, **Email supplier** (or **Copy link**).
9. Open the supplier link from the email (no login): pick a date → **Confirm ship date**. Back
   in the app the order shows the confirmed date, and **Products** shows "On order with Keha".
10. **Settings → Alerts:** Monday email recipients, instant alerts on/off; paste a Slack
    incoming-webhook link → **Send a test message**.
11. **Shopify Flow:** create a workflow with the trigger **Product needs reorder** or **Product
    went dead** (Keha Inventory Intelligence). The app fires them from its hourly job, once per
    product per episode, so a test workflow may need up to an hour after a product qualifies.
12. **Free plan check:** switch to Free on Shopify's plan page → **Reorder** shows what it does
    with an **Upgrade** button; the product page shows locked forecast fields.
13. **Uninstall:** all stored data for the store is deleted 48 hours later (immediately on
    Shopify's shop/redact).

**Why each permission (one line each).**

| Scope | Why |
|---|---|
| `read_products` | Products and variants (titles, SKUs, vendors, collections, prices, costs) — what the store sells. |
| `read_inventory` | Stock per location now and per day — in stock, running low, sold out. |
| `read_locations` | Which locations fulfil online orders (the online stock pool). |
| `read_reports` | ShopifyQL analytics: daily sales totals per variant / location / channel, stock history, sessions per landing page. |
| `read_inventory_purchase_orders` | Shopify purchase orders, so stock already ordered counts as incoming. |
| `write_inventory_transfers` | Reads the transfers linked to Shopify purchase orders (received units); creates a transfer only after the merchant confirms. |
| `write_discounts` | Creates the Clear discount, only after the merchant confirms. |

**Protected customer data — why Level 2 for `read_reports`.** The `shopifyqlQuery` API that
`read_reports` unlocks requires protected customer data access at Level 2. The app uses it
only for aggregate reports and never selects customer fields. The exact queries:

- `FROM sales SHOW net_items_sold, gross_sales, quantity_returned GROUP BY product_variant_id, pos_location_name, sales_channel TIMESERIES day`
  (and the same without returns / without the channel, as fallbacks);
- `FROM sales SHOW net_items_sold, gross_sales GROUP BY product_variant_id, sales_channel TIMESERIES day`;
- `FROM inventory_by_location SHOW ending_inventory_units_at_location, days_out_of_stock_at_location GROUP BY product_variant_id, inventory_location_name TIMESERIES day`;
- `FROM sessions SHOW sessions, sessions_that_completed_checkout GROUP BY landing_page_path, referrer_source TIMESERIES day`;
- `FROM sales SHOW orders, gross_sales TIMESERIES day`.

The app requests no `read_orders`, `read_customers` or `read_all_orders`, subscribes to no
`orders/*` webhooks, and stores no name, email, phone or address of any shopper.

**Contact during review:** **[Kanwar to provide]** (email + phone).

---

## B. Before submitting (Kanwar)

- [ ] **Blocker found in this pass:** Settings shows a **Locations** tab
      (`app/components/settings-tabs.tsx`) but `app/routes/app.settings_.locations.tsx` does
      not exist, so a reviewer who clicks it gets a 404. Fix (hide the tab until phase 3, or
      build it) before submitting.
- [ ] Decide what to submit with: the Planner (task 2.5) and every Pro line are not built; the
      plan cards must not list them (`LISTING.md` → Pricing). **[Kanwar to confirm]**
- [ ] Railway: `INVENTORY_EMAIL_API_KEY` and `INVENTORY_EMAIL_FROM` set (supplier emails,
      Monday email and data-request answers depend on them); `INVENTORY_SUPPORT_EMAIL`,
      `INVENTORY_LEGAL_NAME` set; `/health` shows sync fresh and `pricing.lastOkAt`.
- [ ] Partner Dashboard → App pricing: plans `free`, `growth` ($49 / $490), `pro` ($99 / $990),
      14-day trial on paid plans.
- [ ] Protected customer data form: Level 2 requested for `read_reports`, answers from
      `PCD-ANSWERS.md`, "log access" = Yes.
- [ ] `npm run deploy` (Flow extension) and release the version; open the app once to accept
      scopes.
- [ ] Demo store with ≥ 90 days of history ready, its access details in part A.
- [ ] Screencast recorded last (`SCREENCAST.md`), screenshots (`SCREENSHOTS.md`).
- [ ] Every listing claim checked once on the demo store (playbook mistake #18).
