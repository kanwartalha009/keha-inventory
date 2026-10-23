# App review — testing instructions (Keha Inventory Planner)

Two parts: **A** is what Kanwar pastes into the Partner Dashboard "Testing instructions" field;
**B** is the checklist for Kanwar before pressing Submit. Every step was written from the code
on 2026-10-16 (task 2.7) and updated on 2026-10-17 for the Planner and Pro stores, for the Order plan,
for the UX pass (suppliers' transit time and minimums, locations on every plan, weekly summary "Due
this week", Done in the action menu) and for the merged build (Due now = the next 7 days,
editable drafts, receiving per line, reopen) and for the purchase order builder (one purchase
order per supplier per cycle) and for the supplier module (payment terms, freight & duty, the
monthly budget, measured delivery times, size-grid purchase orders); labels are the app's English strings.

---

## A. Testing instructions (paste into the submission form)

**What the app does.** Keha reads a store's own products, stock, sales totals and store visits
and plans its stock orders: what to order, from which supplier, by when, and the cash each week
needs over the next 13 weeks. Every product carries one status word with its reason (**Order
now**, **Order soon**, **OK**, **Too much**, **Not selling**, **Learning**, **Don't reorder**). It
also shows the money at stake (sales at risk in the next 4 weeks, cash tied up in slow stock), a
ranked weekly to-do list, purchase orders, and a weekly summary. It has no storefront part and stores no shopper data.

**How notifications work (no email service of our own).** Keha sends no email itself. Merchants get
its summaries by email **through Shopify Flow**: the app fires the triggers **Weekly order plan
ready** (every Monday from 08:00 store time, every plan), **First order plan ready** (once, when the
first plan is ready, every plan), and on Growth **Product needs reorder** / **Product became dead stock**;
a workflow with Flow's **Send internal email** action delivers them (Settings → Alerts explains this
and links to Flow). Purchase orders go to suppliers from the merchant's own email app: **Open in
your email** prepares the message (in the supplier's language, with the supplier confirmation link where the
supplier confirms the ship date and downloads the PDF or CSV), and the merchant then presses **Mark
as ordered**. Slack works as a direct integration (Growth).

**Test store requirements.**

1. Products with **Track quantity** on, at least one active location (every active location's
   stock is included in purchase orders unless it is left out in Settings → Locations).
2. **Sales history:** the numbers come from Shopify's own analytics (ShopifyQL), so a brand-new
   store with no orders shows the empty state "Your first order plan needs 14 days of sales —
   expected on <date>". To see numbers and actions, use our demo store below, or a
   test store with at least 14 days of orders on tracked products.
3. Shopify Flow (free app) installed, only to see the four Flow triggers.
4. For the Pro features: at least two active locations — one with spare stock to act as the
   warehouse, one selling through Shopify POS as a store — with stock of the same products.
5. For the Season planner's seasonality: 13 months of sales history (with less, the Season planner still works
   and says "Not enough sales history for these dates yet." where last year is missing).

**Demo store with history:** `<demo-store>.myshopify.com` — collaborator access request or
staff login: **[Kanwar to provide]**. Storefront password (if asked): **[Kanwar to provide]**.

**No sales history? Explore with sample data.** On a new test store the Dashboard shows a card
**Explore Keha with sample data** while it reads the store. **Explore with sample data** →
confirm **Load sample data** (about a minute): every screen then shows a simulated clothing store
(60 products, 14 months of sales, 5 suppliers, purchase orders), with a banner on every page:
"You're viewing sample data — nothing here is from your store." Sample data shows every Growth
feature whatever the plan (the banner says so). Nothing is read from or written to the Shopify
store: discounts, transfers, emailing / sending / receiving purchase orders, Slack, the weekly
summary email, Flow and alerts are switched off with a note (purchase orders can still be drafted, inside
the sample data). **Switch to my store** (in the banner) deletes the sample data and every screen
shows the store's own data again; once the store's own data is ready the banner offers it.
Sidekick always answers from the store's own data, never from sample data.

**Plans & billing.** Pricing is Shopify App Pricing. After install, Shopify's plan page opens: pick
**Growth** (or **Pro**) — on a development / test store there is no charge. Free works too and
shows locked features with an explanation and an **Upgrade** button (nothing is hidden). To
switch later: **Plans & billing** in the app menu → **Choose plan** (opens Shopify's plan page).
**On Free, the order plan is a top-10 preview:** the Dashboard and **Order plan → Due now** show
the 10 most urgent products (days of stock, order-by date, suggested quantity), read only. To see the
whole plan (Due now by supplier, Order calendar, purchase orders), pick **Growth** on Shopify's
plan page (**Plans & billing → Choose plan**; no charge on a development store) — the screens update at once.

| Plan | Unlocks |
|---|---|
| Free | A read-only preview of the order plan (the 10 most urgent products with days of stock, order-by date and suggested quantity, also in the weekly summary), the four money numbers (refreshed weekly), the top 10 actions, the weekly summary (top 10; by email through Shopify Flow's "Weekly order plan ready"), and Settings → Locations' "Included in purchase orders" toggle |
| Growth | Daily refresh, every action, days of stock and suggested order quantities, the full Order plan (Due now by supplier, Order calendar with its CSV, Purchase orders, Build purchase order), purchase orders (PDF / CSV / email) and the supplier confirmation link, what to do while a best seller is out of stock (back-in-stock sign-ups; the **Sold out** tab of the actions), Clear discounts, Fix details, Products CSV export, the Season planner (1 scenario) with collection goals and the accuracy scorecard, Slack, Shopify Flow triggers |
| Pro | Everything in Growth, plus warehouse / store roles in Settings → Locations, the location switcher on Products and Due now, the warehouse → stores transfer plan with draft transfers created in Shopify, and unlimited Season planner scenarios |

**Steps (Growth plan, store with history).**

1. Install the app: on its first open it sends you to Shopify's plan page (once). Pick **Growth**; you land on the **Dashboard**.
   The app menu is **Dashboard · Actions · Order plan · Products · Settings · Plans & billing**. Every page
   has a **How it works** button in its title bar: a panel that explains the page in plain words,
   with the store's own numbers where they exist (lead time, order days, a real line of Due now
   worked through) and links to the settings behind them.
2. The Dashboard says "First sync in progress" and shows **Setting up your order plan**: one row
   per stage (products, stock history, sales history, store visits, building your plan) with the
   months read, the time left (worked out from how fast the store is being read), what to do
   meanwhile (the **Setup guide** below it, or **Import from a CSV**), and "Your order plan
   appears here when it's ready" (with Shopify Flow, **First order plan ready** fires then). The newest 90 days are read first; the
   numbers appear when they are in, labelled "Based on the last 90 days so far" until the older
   months are read, and the header then shows the real update time.
3. **Dashboard → Your stock today** (top of the page): how many products carry each status word
   (**Order now**: sold out, or it runs out before a new order could arrive; **Order soon**: order
   within a week to keep a small buffer; **OK**; and **Too much**, **Not selling**, **Learning** when
   there are any). Each number opens Products filtered to those products. Below it, **Money at
   stake**: sales at risk in the next 4 weeks and cash tied up in slow stock, each with an info
   button ("How we got this") that shows the inputs. A dash (—) means not enough data, never zero.
   **Dashboard → This week** (below it): up to three plain sentences (what to order this week and
   the cash, sold-out products shoppers still look for, stock that doesn't move), then each
   supplier with orders due in the next 7 days — products, units, cash and its most urgent status
   word with the reason — with **Review order**, which opens Due now for that supplier at the
   planned quantities. Below it, the cash needed for the next 13 weeks with **See the order calendar**.
4. **Dashboard → This week's actions:** the top 5 actions, stock first (reorder and sold-out
   products before clearance and page fixes), and **See all … actions**, which opens the
   **Actions** page (also in the app menu). The Actions page also shows **What sold-out products
   cost you** (sales lost while sold out, last 90 days; sales missed on sold-out pages, last 30 days).
5. **Actions:** the whole list. Switch tabs (All, Reorder, Stock gaps, Promote, Product issues, Clearance).
   Each row's "…" menu has **Mark as done**, **Snooze 7 days**, **Dismiss** and **Why this action** (Undo
   appears after Done, Snooze and Dismiss).
6. **Clearance** tab → **Create discount** → a confirm dialog shows the products and the
   percentage → confirm. The discount appears in Shopify → Discounts. Nothing is created
   without this confirm.
7. **Products:** the table (one row per variant; the status word and its reason, how fast it
   sells in words — "2.3 a day", "about 3 a month"; filter by status word, collection, vendor;
   **Export CSV**). The store's planning rules are said once under the title ("How we plan: …",
   with **Change**). Click a row: the product page opens with **What to do** (the status, one plain
   sentence such as "Sells about 3 a month. 12 in stock, enough until about Dec 2. Order 6 by Oct
   30.", the stock numbers and **Add to purchase order**, which opens Due now with that product highlighted), then 13 months of sales with out-of-stock days shaded, then
   **Forecast details and settings** (collapsed: "How the forecast was built" with lead time,
   order days, in-stock target and safety stock, each with a **Change** link to the setting). On
   Due now, the info button on a line (**Why this quantity**) says it in a sentence whose numbers
   add up ("Sells 2 a day. The next 28 days need about 56, plus a buffer of 10. You have 5 in
   stock, so order 38."), with the formula under **Details**. **Order now** (red) is used only when
   a product is sold out or runs out before a new order could arrive; a product only below its
   buffer, or one whose stock-out an order already on the way ends, is **Order soon** (amber).
8. **Settings → Suppliers:** add a supplier with an email address you can read and assign it
   by vendor. Lead time is the total from placing the order to stock arriving; **Transit time**
   is the part from ship date to arrival (sea or air freight). Under **More options**: the
   minimum per item applies to each size/color or to each product (split across sizes by
   sales), a minimum order value in the supplier's currency, and — when that currency differs
   from the store's — the exchange rate. **Order enough for** is the days of stock each order from
   this supplier lasts after it arrives (empty = the store's setting); order quantities cover the lead time plus it.
   Also under **More options**: **Payment terms** (pay everything when ordering, or a **Deposit**
   with the rest at shipment, on arrival or some days after arrival) and **Freight & duty** (a % of
   the goods cost, paid on arrival). Once orders from this supplier are received, its row shows how
   it really delivers ("Usually 6 days late", on-time share and spread, from 3 deliveries; fewer:
   "2 deliveries measured").
   **Settings → Import & export** does the same for many suppliers and products at once:
   **Download CSV** (the current values), change a case pack or a supplier in the file, upload
   it; the check lists what will change and any row with a problem — nothing is saved until
   **Import {n} changes** (for example "Import 3 changes").
9. **Order plan → Due now:** everything due in the next 7 days (overdue included), grouped by
   supplier, each line on its own order-by date, with case packs and the supplier's minimums →
   **Create purchase order** → confirm (a draft; nothing is sent). On the draft: change quantities or
   remove lines and save with the save bar, or **Delete draft**; then **Download PDF**,
   **Download CSV**, **Size grid** (the CSV as a size grid), **Open in your email** (shows to, subject and the
   message; the button opens it in your own email app, from your address — on a long order the
   message lists the first lines and "+N more lines in the order link"; **Copy message** for
   webmail), then **Mark as ordered** (always its own confirm — opening the email never marks it as ordered).
   The PDF lists clothing and shoes as a size grid (one row per style and color, sizes as columns,
   the style code — the product page's **Supplier code**, else the start of the SKUs — and totals);
   it never shows freight & duty. A draft not sent
   within 14 days stops counting as ordered (a banner says so).
10. **Due now → Build purchase order** (on a supplier's card, inside "Due before next order" when
    it is there): one purchase order for everything that supplier needs until the next order — **Due now** and
    **Due before your next order** (each line with its own order-by date and "Why this quantity"),
    every line selected and editable; **Add products** adds any other product of that supplier.
    Units, cost and the supplier's minimums update as you type ("Add 24 units to reach … minimum",
    **Top up to the minimum**). **Order enough for** (in **This order**) changes the days this one order
    covers — Plan default, 30 to 180 days, or **Custom…** (7–365) — and every quantity is worked out
    again; the order keeps the choice ("Ordered for 150 days" on the purchase order) and the default
    stays as it is. The same picker is on each supplier's card in **Due now**. **Lead time** and
    **Order enough for** have a **Change** link to the setting behind them. **Create purchase order** → confirm: one draft with every line (nothing
    is sent). Back on Due now and Order calendar those lines are no longer due. Open the builder
    again: it offers **Add to PO-00xx** for that draft instead of a second one. With payment terms or
    freight & duty set for the supplier, **This order** shows them, the cost "+ freight & duty", and
    "If you order today: … deposit when you order · … at shipment, about <date> · …".
11. **Order plan → Order calendar:** every order for the next 13 weeks by week and supplier, with
    units, cash per week (a line without a cost price shows "—" and is counted, never 0) and
    order-by dates; open a week → a supplier → **Create purchase order** opens Due now with those lines
    (the order is still created only after the confirm there), **Build purchase order** opens the
    builder for that week. **Download CSV** exports the plan. The cash strip puts each payment in
    the week it is paid (the suppliers' payment terms; without terms, the week of the order) and
    shows what is still due on orders already sent ("Still due on open purchase orders"). With a **Monthly
    purchasing budget** (Settings → Defaults → More options) the **Monthly budget** card compares each
    month with it; a month over it has **Fit to budget**: the orders that could wait until next month
    (lowest priority first; never below a supplier's minimum), each with its risk — a suggestion,
    nothing changes.
12. Open the supplier confirmation link from the email (no login; it works once the order is marked as ordered; the
    page also has **Download the order as PDF / as CSV**): pick a date → **Confirm ship date**. Back
    in the app **Order plan → Purchase orders** shows the ship date and the arrival (ship date + the
    supplier's transit time), sorted by arrival, and **Products** shows "On order (Keha)".
    On the order, **Receive items** records a delivery per line ("Received 8 of 20 · 12 still to
    come"; only the rest counts as on order), or closes the rest as short. **Close order** (on any
    ordered or confirmed order) ends it when nothing more will come: nothing is received, the
    rest stops counting as on order, and an order closed with nothing delivered is left out of the
    supplier's measured lead time. A received, closed or
    canceled order can be reopened within 30 days (**Reopen order**). An order whose stock
    landed is received automatically (and says so, with the date).
13. **Settings → Defaults:** "How long do your suppliers take?" (the default lead time); under
    **More options**: Order enough for, Too much after, Not selling after, **Safety stock** (Low /
    Standard / High), **Year-over-year growth** (off and recommended by default, or add the store's
    year-over-year growth) and an optional **Monthly purchasing budget**. **Settings → Alerts:** the
    **Weekly summary** card ("Get it by email with Shopify Flow", **Open Shopify Flow**), instant
    alerts on/off (Slack; by email through Flow's "Product needs reorder" on Growth); paste a Slack
    incoming-webhook link → **Send a test message**. The weekly summary (Flow's "Summary text", and
    Slack) opens with **Due this week** (one line per supplier with units, cash and order-by date,
    flagged **Order now** / **Order soon**, **Review order**), then the same two money figures as
    the Dashboard, and its subject says what to order (for example "2 orders due this week · first
    by Wed, Oct 21", or "Lisbon Linen: order now · 40 units").
14. **Shopify Flow:** create a workflow with a Keha Inventory Planner trigger and the **Send
    internal email** action (Subject `{{ subject }}`, Message `{{ summaryText }}` for the two
    summary triggers). **Weekly order plan ready** fires on Mondays from 08:00 store time, once per
    store week; **First order plan ready** once per store, when the first plan is ready (on a
    fresh install); **Product needs reorder** / **Product became dead stock** (Growth) from the hourly job,
    once per product per episode, so a test workflow may need up to an hour after a product
    qualifies.
15. **Season planner (Growth):** **Order plan → Season planner** (`/app/reorder/season`) → **New scenario** → pick an event (Black
    Friday, Christmas or custom dates) and a target (grow X %, a revenue target, or keep pace) →
    **Save and calculate**. The scenario shows demand per collection, the order list with
    order-by dates, and **Cash needed per week** (chart and table). Below: **Collection goals**
    (pick a collection, set a goal share of revenue, **Save goal**) and **Forecast accuracy**
    (filled from the first graded month). On Growth a second scenario shows the Pro upgrade note.
16. **Pro:** switch to **Pro** on Shopify's plan page (no charge on a test store), then:
    1. **Settings → Locations:** set one location's role to Warehouse and one to Store → **Save**.
       Numbers per location appear after the next nightly refresh (03:00 store time). (On every
       plan, each location's **Included in purchase orders** toggle decides which stock is counted;
       POS stores count unless left out.)
    2. **Products** and **Order plan → Due now:** use the **Location** switcher to see one store's own sales per
       day, days of stock and order advice.
    3. **Due now → Transfers to stores** (shown once two or more locations are planned): adjust quantities → **Create transfer in
       Shopify** → confirm. The transfer is created as a **draft** in Shopify (**Open the transfer
       in Shopify**); nothing moves until you mark it ready to ship there. Pressing it again the
       same day creates nothing new.
    4. **Season planner:** more than one scenario can be kept.
17. **Free plan check:** switch to Free on Shopify's plan page → **Order plan → Due now** and
    the Dashboard show a read-only preview of the 10 most urgent products (days of stock, order-by
    date, suggested quantity) with an **Upgrade** button; Order calendar, Season planner and Purchase
    orders keep the tab bar and show what they do with an **Upgrade** button; Build purchase order
    (`/app/reorder/build?supplier=…`) shows what it does with that supplier's own numbers and **See plans**; the product page shows locked forecast fields;
    Settings → Locations keeps the **Included in purchase orders** toggle and shows the roles locked
    with "Pro plan".
18. **Uninstall:** all stored data for the store is deleted 48 hours later (immediately on
    Shopify's shop/redact).

**Try it in Sidekick.** Open Sidekick in the Shopify admin and ask, for example:

- "What do I need to reorder this week?"
- "When does the <product name> run out?" (use a product of the test store)
- "Which purchase orders are still open?"

Sidekick answers from the app's data (order-by dates, days of stock, expected arrivals)
and links to the matching page in the app. These tools only read: nothing changes in the store,
and purchase orders are still created and sent from the Order plan after a confirm. Open
purchase orders show the units still to come and the expected arrival. Each plan
gets what its own screens show (on Free: the 10 most urgent products of the order-plan preview, and no purchase-order list).

**Why each permission (one line each).**

| Scope | Why |
|---|---|
| `read_products` | Products and variants (titles, SKUs, vendors, collections, prices, costs) — what the store sells. |
| `read_inventory` | Stock per location now and per day — in stock, running low, out of stock. |
| `read_locations` | The store's locations: which are active (their stock is included in purchase orders unless the merchant leaves one out) and which fulfill online orders. |
| `read_locales` | The store's primary language, so owner emails, the supplier page and the admin open in it. |
| `read_reports` | ShopifyQL analytics: daily sales totals per variant / location / channel, stock history, sessions per landing page. |
| `read_inventory_purchase_orders` | Shopify purchase orders, so stock already ordered counts as incoming. |
| `write_inventory_transfers` | Reads the transfers linked to Shopify purchase orders (received units); on Pro, creates a draft transfer from a warehouse to a store only after the merchant confirms. |
| `write_discounts` | Creates the clearance discount, only after the merchant confirms. |

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

- [ ] Railway: no email provider needed (`/health` → `config.email` = `"flow"`; owner decision
      2026-10-18; Flow templates: `docs/FLOW-TEMPLATES.md`, optional); `INVENTORY_SUPPORT_EMAIL`,
      `INVENTORY_LEGAL_NAME` set; `/health` shows sync fresh and `pricing.lastOkAt`.
- [ ] Partner Dashboard → App pricing: plans `free`, `growth` ($49 / $490), `pro` ($99 / $990),
      7-day trial on paid plans.
- [ ] Protected customer data form: Level 2 requested for `read_reports`, answers from
      `PCD-ANSWERS.md`, "log access" = Yes.
- [ ] Railway: a separate worker service (`WORKER_MODE=worker`) and the web service on
      `WORKER_MODE=web` (`docs/OPERATIONS.md` "Services"), so the reviewer's page loads never wait
      for another store's nightly compute.
- [ ] `npm run deploy` (Flow extension) and release the version; open the app once to accept
      scopes.
- [ ] Demo store ready: ≥ 13 months of history (Season planner seasonality), a warehouse and a POS
      store with stock, one Season planner scenario; access details in part A.
- [ ] Screencast recorded last (`SCREENCAST.md`), screenshots (`SCREENSHOTS.md`).
- [ ] Every listing claim checked once on the demo store (playbook mistake #18).

---

## C. Sample data mode and the App Store requirements (checked 2026-10-17)

Sample data ("Explore with sample data") exists so a merchant — and the reviewer — can see the
whole product before a new store has 14 days of sales. Checked against the
[App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements):

| Requirement | How sample data meets it |
|---|---|
| 1.1.4 *Use only factual information* — apps must not falsify data to deceive merchants or buyers. | Sample data is never presented as the store's: a banner on every screen says "You're viewing sample data — nothing here is from your store.", it lives under its own data key (`<shop>#sample`), never mixes with the store's rows, and is never shown to buyers (no storefront part). Sidekick, emails, Slack, Flow and alerts never use it. |
| 1.3 *Honest review practices* — no fake or incentivised reviews. | Shopify's review prompt is never shown while sample data is on (and a sample "success moment" can't trigger it). No reviews or testimonials are generated. |
| 2 / 2.1.1 *Deliver the listed features without errors.* | Every screen runs on the sample store through the same code as a real store (the end-to-end simulation tests render each screen in English and German). |
| 4.5.4 / 4.5.5 *Testing instructions with working access to the full feature set.* | Part A says how to load it; it shows Growth's features on any plan, so a reviewer on Free still sees the whole product. A demo store with real history stays the primary path. |
| 4.3.3 / 4.3.4 *No stats or data in the listing or its images.* | Listing screenshots must not use sample-data numbers as claims; if a screenshot shows a sample-data screen, the banner stays visible. |
| 4.4.4 *Images show the app's actual UI.* | The sample-data screens are the real UI on simulated data. |

Uninstall and shop/redact delete the sample data with the store's own (`purgeShopData` purges
`<shop>#sample` too); "Switch to my store" deletes it at once.

