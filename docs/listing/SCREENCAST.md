# Screencast script — Keha Inventory Planner (review video)

Target: **about 7½ minutes** (Shopify asks for 3–8; trim the Pro part first if it runs long), English voice-over, 1600 × 900 or 1920 × 1080,
no music needed. Record it **last**: on the final handle `keha-inventory`, on the released app
version, after `/health` shows sync fresh and `pricing.lastOkAt` set (playbook §8, mistake #22).

Store: the store from `SCREENSHOTS.md` (sales history ≥ 90 days — 13 months for the Season plan's
seasonality — suppliers, a Season plan scenario, a warehouse and two POS stores set up). To show
install → first numbers honestly, use a second store with history where the app is **not**
installed yet, or cut from the install to the same store after its first sync and say so.
**[Kanwar to confirm]** which store and whether the cut is acceptable to him.

Before recording: a mailbox you can show for the supplier (not a real supplier), Slack test
channel connected, the Monday email of the latest Monday in the inbox.

| Time | On screen | Voice-over |
|---|---|---|
| 0:00 | Shopify admin, App Store listing, click **Install** | "This is Keha Inventory Planner. It plans your stock orders: what to order, from which supplier, by when, and the cash it takes. Every Monday it also ranks what to reorder, promote, fix or clear. Let's install it." |
| 0:20 | OAuth screen: the permissions list | "It asks to read products, stock, locations and Shopify's analytics reports. It never asks for orders or customers: sales come in as daily totals per product, so no shopper data is stored. It can create a discount, or on Pro a draft stock transfer, but only when you press confirm." |
| 0:45 | Shopify's plan page: Free / Growth / Pro; pick **Growth** (test store) | "Pricing is on Shopify's own plan page. Free shows the money, the top ten actions and a read-only preview of the ten most urgent orders. I'll pick Growth for the full order plan." |
| 1:00 | Dashboard: "First sync in progress", "Reading your store…" with a progress bar per dataset | "There's nothing to set up. Keha reads your products, stock history, sales history and store visits. The newest ninety days come first, so numbers appear quickly; older months fill in behind." |
| 1:20 | (Cut, say "a few minutes later" on screen) Dashboard: **Order this week** by supplier, the 12-week cash strip, then the 4 money cards | "The Dashboard starts with what to order this week: each supplier, how many products and units, the cash it takes and the date to order by. The strip shows the cash needed for the next twelve weeks. Below are the four numbers. Sales at risk in the next 28 days. Sales lost to sell-outs over the last 90. Cash stuck in stock that doesn't move. And the value of visits that landed on sold-out product pages." |
| 1:45 | Open the "How we got this" popover on *Sales lost to sell-outs* | "Every number shows how we got it. Sales per day count only the days a product was in stock, so a sell-out never drags the forecast down. When data is missing you see a dash, never a zero." |
| 2:05 | The action list, tab **All**, then **Reorder**, **Fix**, **Clear** | "Further down is this week's to-do list, ranked by money. Each row says what to do, why, and what it's worth." |
| 2:25 | **Clear** tab → **Create discount** → the confirm dialog → confirm → Shopify Discounts list shows it | "This product hasn't sold in over 90 days. I'll create a 20 percent discount. Nothing changes in the store until I confirm. There it is in Shopify's discounts." |
| 2:55 | A **Reorder** row → **Products** → the variant page: 13-month chart, "How the forecast was built" | "This best seller runs out before new stock could arrive. The product page shows thirteen months of sales with sold-out days shaded, and how the order quantity was built: sales rate, seasonality, lead time and safety stock." |
| 3:30 | Dashboard **Review order** on a supplier → **Order plan → Order now** (that supplier only): order-by date, adjust a quantity, **Create order** → confirm | "Review order opens Order now for that supplier. Suggested quantities come in whole case packs and respect the supplier's minimums; I can adjust any line, then create the order after I confirm." |
| 3:45 | **Order plan → Next 90 days**: the summary line, the cash strip, open a week → a supplier's lines → **Create order** | "Next 90 days shows every order the forecast needs for thirteen weeks, by week and supplier, with the cash each week takes. A fast seller can need two or three orders in that time; each one starts as a draft I review in Order now." |
| 3:55 | **Download PDF**, **Download CSV**, then **Email supplier** | "I can download it as a PDF or CSV, or email it straight to the supplier. Replies come back to the store's own email." |
| 4:15 | The supplier's inbox → open the email → the confirmation page → pick a date → **Confirm ship date** | "The supplier gets a link — no login. It shows only this order. They pick the ship date and confirm. The link stops working 60 days after the order was sent." |
| 4:45 | Back in the app: **Order plan → Open orders**, the order shows the confirmed date; **Products** shows "On order with Keha" | "Back in Keha the order is confirmed, and the products show the stock on order. When the stock lands in Shopify, the order closes by itself." |
| 5:05 | **Order plan → Season plan**: the "Black Friday 2026" scenario → cash needed per week chart, order list, demand per collection | "The Season plan looks ahead to one event. I picked Black Friday and a 20 percent growth target. It turns last year's shape and today's sales into an order list with order-by dates, and the cash I'll need each week to pay for it." |
| 5:35 | Season plan: **Collection goals**, then **How accurate we were** | "I can set a goal share of revenue per collection and see the products holding it back. And Keha grades its own forecasts every month, out in the open." |
| 5:55 | Plans → switch to **Pro** on Shopify's plan page; Settings → **Locations**: Warehouse and two stores | "On Pro, each warehouse and POS store gets its own plan. I mark which location is the warehouse and which are stores." |
| 6:15 | **Products** with the location switcher on a store; **Order plan → Order now** → "Transfers: warehouse → stores" → **Create transfer in Shopify** → confirm → **Open the transfer in Shopify** | "Each store shows its own sales per day and days left. When a store runs low and the warehouse can spare stock, Keha proposes a transfer. After I confirm, it's created in Shopify as a draft; nothing moves until I mark it ready to ship." |
| 6:50 | Settings → **Alerts**: Monday email recipients, instant alerts, Slack connected → **Send a test message** | "Alerts: the Monday email goes to the store owner by default. Instant alerts warn when a best seller will run out before new stock can arrive. On Growth and Pro the same summary goes to Slack." |
| 7:10 | The Monday email in the inbox | "And this is the Monday email: the four numbers with the change since last week, the top five actions with buttons straight into the app, and how accurate last month's forecast was." |
| 7:30 | Back on the Dashboard | "On Free you still get the four numbers, the top ten actions and the top ten orders to place; paid features show what they do and an Upgrade button. That's Keha Inventory Planner. Thanks for reviewing." |

Checklist after recording:

- [ ] 3–8 minutes, voice audible, English.
- [ ] Admin URL shows `/apps/keha-inventory`, not an old handle.
- [ ] No shopper data on screen; the supplier mailbox is a test address.
- [ ] Upload (Loom/YouTube unlisted, public link) and paste the link in the submission form.
