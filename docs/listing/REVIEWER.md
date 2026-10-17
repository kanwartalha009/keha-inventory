# App review — testing instructions (Keha Inventory Intelligence)

Two parts: **A** is what Kanwar pastes into the Partner Dashboard "Testing instructions" field;
**B** is the checklist for Kanwar before pressing Submit. Every step was written from the code
on 2026-10-16 (task 2.7) and updated on 2026-10-17 for the Planner and Pro stores, for the Order plan
and for the UX pass (suppliers' transit time and minimums, locations on every plan, Monday "Order
this week", Done in the action menu); labels are the app's English strings.

---

## A. Testing instructions (paste into the submission form)

**What the app does.** Keha reads a store's own products, stock, sales totals and store visits
and plans its stock orders: what to order, from which supplier, by when, and the cash each week
needs over the next 13 weeks. It also shows the money at stake (sales at risk, sales lost to
sell-outs, cash stuck, sold-out page visits), a ranked weekly to-do list, purchase orders, and a
Monday email. It has no storefront part and stores no shopper data.

**Test store requirements.**

1. Products with **Track quantity** on, at least one location that fulfils online orders.
2. **Sales history:** the numbers come from Shopify's own analytics (ShopifyQL), so a brand-new
   store with no orders shows the empty state "Your first order plan needs 14 days of sales —
   we'll show it here on <date>". To see numbers and actions, use our demo store below, or a
   test store with at least 14 days of orders on tracked products.
3. Shopify Flow (free app) installed, only to see the two Flow triggers.
4. For the Pro features: at least two active locations — one with spare stock to act as the
   warehouse, one selling through Shopify POS as a store — with stock of the same products.
5. For the Season plan's seasonality: 13 months of sales history (with less, the Season plan still works
   and says "Not enough sales history for these dates yet." where last year is missing).

**Demo store with history:** `<demo-store>.myshopify.com` — collaborator access request or
staff login: **[Kanwar to provide]**. Storefront password (if asked): **[Kanwar to provide]**.

**Plans.** Pricing is Shopify App Pricing. After install, Shopify's plan page opens: pick
**Growth** (or **Pro**) — on a development / test store there is no charge. Free works too and
shows locked features with an explanation and an **Upgrade** button (nothing is hidden). To
switch later: **Plans** in the app menu → **Choose plan** (opens Shopify's plan page).

| Plan | Unlocks |
|---|---|
| Free | A read-only preview of the order plan (the 10 most urgent products with days left, order-by date and suggested quantity, also in the Monday email), the four money numbers (refreshed weekly), the top 10 actions, the Monday email (top 10), and Settings → Locations' "Counts in supplier orders" toggle |
| Growth | Daily refresh, every action, days of stock left and suggested order quantities, the full Order plan (Order now by supplier, Next 90 days with its CSV, Open orders), purchase orders (PDF / CSV / email) and the supplier confirmation link, the preorder bridge, Clear discounts, Fix details, Products CSV export, the Season plan (1 scenario) with collection goals and the accuracy scorecard, Slack, Shopify Flow triggers |
| Pro | Everything in Growth, plus warehouse / store roles in Settings → Locations, the location switcher on Products and Order now, the warehouse → stores transfer plan with draft transfers created in Shopify, and unlimited Season plan scenarios |

**Steps (Growth plan, store with history).**

1. Install the app and pick **Growth** on Shopify's plan page. You land on the **Dashboard**.
   The app menu is **Dashboard · Order plan · Products · Settings · Plans**.
2. The Dashboard says "First sync in progress" and shows the **Setup guide** first (Lead times,
   Suppliers, Product costs, Monday email), then "Reading your store…" with progress per dataset
   (products, stock history, sales history, store visits). The newest 90 days are read first; the
   numbers appear when they are in (minutes on a small store), and the header then shows the
   real update time.
3. **Dashboard → Order this week** (first on the page): each supplier with orders due in the
   next 7 days (overdue ones included) — products, units, cash and order-by date — with
   **Review order**, which opens Order now for that supplier at the planned quantities. Below it,
   the cash needed for the next 12 weeks with **See the next 90 days**.
4. **Dashboard → money cards:** open "How we got this" on any card to see the inputs. A dash (—)
   means not enough data, never zero.
5. **Dashboard → This week's actions:** switch tabs (All, Reorder, Bridge, Promote, Fix, Clear).
   Each row's "…" menu has **Mark as done**, **Snooze 7 days**, **Dismiss** and **Why** (Undo
   appears after Done, Snooze and Dismiss).
6. **Clear** tab → **Create discount** → a confirm dialog shows the products and the
   percentage → confirm. The discount appears in Shopify → Discounts. Nothing is created
   without this confirm.
7. **Products:** the table (one row per variant; filters; **Export CSV**). Click a row: the
   product page shows 13 months of sales with sold-out days shaded and "How the forecast was
   built".
8. **Settings → Suppliers:** add a supplier with an email address you can read and assign it
   by vendor. Lead time is the total from placing the order to stock arriving; **Transit time**
   is the part from ship date to arrival (sea or air freight). Under **More options**: the
   minimum per item applies to each size/colour or to each product (split across sizes by
   sales), a minimum order value in the supplier's currency, and — when that currency differs
   from the store's — the exchange rate.
9. **Order plan → Order now:** what to order today, grouped by supplier with order-by dates →
   **Create order** → confirm (a draft; nothing is sent) → on the order: **Download PDF**,
   **Download CSV**, **Email supplier** (or **Copy link**).
10. **Order plan → Next 90 days:** every order for the next 13 weeks by week and supplier, with
    units, cash per week (a line without a cost price shows "—" and is counted, never 0) and
    order-by dates; open a week → a supplier → **Create order** opens Order now with those lines
    (the order is still created only after the confirm there). **Download CSV** exports the plan.
11. Open the supplier link from the email (no login): pick a date → **Confirm ship date**. Back
    in the app **Order plan → Open orders** shows the confirmed date, and **Products** shows "On
    order with Keha".
12. **Settings → Alerts:** Monday email recipients, instant alerts on/off; paste a Slack
    incoming-webhook link → **Send a test message**. The Monday email opens with **Order this
    week** (one line per supplier with units, cash and order-by date, **Review order**), and its
    subject says what to order (for example "2 orders due this week · first by Wed, Oct 21").
13. **Shopify Flow:** create a workflow with the trigger **Product needs reorder** or **Product
    went dead** (Keha Inventory Intelligence). The app fires them from its hourly job, once per
    product per episode, so a test workflow may need up to an hour after a product qualifies.
14. **Season plan (Growth):** **Order plan → Season plan** → **New scenario** → pick an event (Black
    Friday, Christmas or custom dates) and a target (grow X %, a revenue target, or keep pace) →
    **Save and calculate**. The scenario shows demand per collection, the order list with
    order-by dates, and **Cash needed per week** (chart and table). Below: **Collection goals**
    (pick a collection, set a goal share of revenue, **Save goal**) and **How accurate we were**
    (filled from the first graded month). On Growth a second scenario shows the Pro upgrade note.
15. **Pro:** switch to **Pro** on Shopify's plan page (no charge on a test store), then:
    1. **Settings → Locations:** set one location's role to Warehouse and one to Store → **Save**.
       Numbers per location appear after the next nightly refresh (03:00 store time). (On every
       plan, each location's **Counts in supplier orders** toggle decides which stock is counted;
       POS stores count unless left out.)
    2. **Products** and **Order plan → Order now:** use the **Location** switcher to see one store's own sales per
       day, days left and order advice.
    3. **Order now → Transfers: warehouse → stores** (shown once two or more locations are planned): adjust quantities → **Create transfer in
       Shopify** → confirm. The transfer is created as a **draft** in Shopify (**Open the transfer
       in Shopify**); nothing moves until you mark it ready to ship there. Pressing it again the
       same day creates nothing new.
    4. **Season plan:** more than one scenario can be kept.
16. **Free plan check:** switch to Free on Shopify's plan page → **Order plan → Order now** and
    the Dashboard show a read-only preview of the 10 most urgent products (days left, order-by
    date, suggested quantity) with an **Upgrade** button; Next 90 days, Season plan and Open
    orders keep the tab bar and show what they do with an **Upgrade** button; the product page shows locked forecast fields;
    Settings → Locations keeps the **Counts in supplier orders** toggle and shows the roles locked
    with "Pro plan".
17. **Uninstall:** all stored data for the store is deleted 48 hours later (immediately on
    Shopify's shop/redact).

**Try it in Sidekick.** Open Sidekick in the Shopify admin and ask, for example:

- "What do I need to reorder this week?"
- "When does the <product name> run out?" (use a product of the test store)
- "Which purchase orders are still open?"

Sidekick answers from the app's data (order-by dates, days of stock left, expected arrivals)
and links to the matching page in the app. These tools only read: nothing changes in the store,
and purchase orders are still created and sent from the Reorder page after a confirm. Each plan
gets what its own screens show (on Free: the 10 most urgent products of the order-plan preview, and no purchase-order list).

**Why each permission (one line each).**

| Scope | Why |
|---|---|
| `read_products` | Products and variants (titles, SKUs, vendors, collections, prices, costs) — what the store sells. |
| `read_inventory` | Stock per location now and per day — in stock, running low, sold out. |
| `read_locations` | The store's locations: which are active and which fulfil online orders, so their stock is counted in supplier orders. |
| `read_locales` | The store's primary language, so owner emails, the supplier page and the admin open in it. |
| `read_reports` | ShopifyQL analytics: daily sales totals per variant / location / channel, stock history, sessions per landing page. |
| `read_inventory_purchase_orders` | Shopify purchase orders, so stock already ordered counts as incoming. |
| `write_inventory_transfers` | Reads the transfers linked to Shopify purchase orders (received units); on Pro, creates a draft transfer from a warehouse to a store only after the merchant confirms. |
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

- [ ] Railway: `INVENTORY_EMAIL_API_KEY` and `INVENTORY_EMAIL_FROM` set (supplier emails,
      Monday email and data-request answers depend on them); `INVENTORY_SUPPORT_EMAIL`,
      `INVENTORY_LEGAL_NAME` set; `/health` shows sync fresh and `pricing.lastOkAt`.
- [ ] Partner Dashboard → App pricing: plans `free`, `growth` ($49 / $490), `pro` ($99 / $990),
      14-day trial on paid plans.
- [ ] Protected customer data form: Level 2 requested for `read_reports`, answers from
      `PCD-ANSWERS.md`, "log access" = Yes.
- [ ] `npm run deploy` (Flow extension) and release the version; open the app once to accept
      scopes.
- [ ] Demo store ready: ≥ 13 months of history (Season plan seasonality), a warehouse and a POS
      store with stock, one Season plan scenario; access details in part A.
- [ ] Screencast recorded last (`SCREENCAST.md`), screenshots (`SCREENSHOTS.md`).
- [ ] Every listing claim checked once on the demo store (playbook mistake #18).
