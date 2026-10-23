# Screencast script — Keha Inventory Planner (review video)

Target: **about 7½ minutes** (trim the Pro part first if it runs long), English voice-over, 1600 × 900 or 1920 × 1080,
no music needed. Record it **last**: on the final handle `keha-inventory`, on the released app
version, after `/health` shows sync fresh and `pricing.lastOkAt` set (playbook §8, mistake #22).

Store: the store from `SCREENSHOTS.md` (sales history ≥ 90 days — 13 months for the Season planner's
seasonality — suppliers, a Season planner scenario, a warehouse and two POS stores set up). To show
install → first numbers honestly, use a second store with history where the app is **not**
installed yet, or cut from the install to the same store after its first sync and say so.
**[Kanwar to confirm]** which store and whether the cut is acceptable to him.

Before recording: a mailbox you can show for the supplier (not a real supplier), Slack test
channel connected, a Shopify Flow workflow (trigger **Weekly order plan ready**, action **Send internal
email**, Subject `{{ subject }}`, Message `{{ summaryText }}`) and the email it sent on the latest
Monday in the inbox. Keha sends no email of its own in production (no email provider): don't show
**Email supplier** or "Weekly summary email recipients" — those appear only with a provider.

| Time | On screen | Voice-over |
|---|---|---|
| 0:00 | Shopify admin, App Store listing, click **Install** | "This is Keha Inventory Planner. It plans your stock orders: what to order, from which supplier, by when, and the cash it takes. Every Monday it also ranks what to reorder, promote, fix or clear. Let's install it." |
| 0:20 | OAuth screen: the permissions list | "It asks to read products, stock, locations and Shopify's analytics reports. It never asks for orders or customers: sales come in as daily totals per product, so no shopper data is stored. It can create a discount, or on Pro a draft stock transfer, but only when you press confirm." |
| 0:45 | Shopify's plan page: Free / Growth / Pro; pick **Growth** (test store) | "Pricing is on Shopify's own plan page. Free shows the money, the top ten actions and a read-only preview of the ten most urgent products. I'll pick Growth for the full order plan." |
| 1:00 | Dashboard: "First sync in progress", "Setting up your order plan" with each stage, the months read and the time left | "Nothing is required to start. Keha reads your products, stock history, sales history and store visits. The newest ninety days come first, so numbers appear quickly; older months fill in behind." |
| 1:20 | (Cut, say "a few minutes later" on screen) Dashboard: **Your stock today** (the status boxes), **Money at stake**, then **This week** by supplier | "The Dashboard starts with your stock today: how many products to order now, how many to order soon, and how many are fine. Click a number to see those products. Order now means it's sold out, or it runs out before a new order could arrive. Below that, the money at stake: sales at risk in the next four weeks, and cash tied up in stock that doesn't move. Then this week: each supplier to order from, the units, the cash and why it can't wait." |
| 1:45 | Open the "How we got this" popover on *Sales at risk* | "Every number shows how we got it. Sales per day count only the days a product was in stock, so a sell-out never drags the forecast down. When data is missing you see a dash, never a zero." |
| 2:05 | **This week's actions**, then **See all actions** → the Actions page: **What sold-out products cost you**, tabs **All**, **Reorder**, **Product issues**, **Clearance** | "Below that, the top five things to do, stock first. The Actions page has the whole list, ranked by money, and what sold-out products already cost you. Each row says what to do, why, and what it's worth." |
| 2:25 | **Clearance** tab → **Create discount** → the confirm dialog → confirm → Shopify Discounts list shows it | "This product hasn't sold in over 90 days. I'll create a 20 percent discount. Nothing changes in the store until I confirm. There it is in Shopify's discounts." |
| 2:55 | A **Reorder** row → **Products** (status words, "How we plan" under the title) → the variant page: **What to do**, the 13-month chart, then open **Forecast details and settings** | "This best seller runs out before new stock could arrive. The product page answers first: what to do, how fast it sells, how long the stock lasts and how many to order by when. Then thirteen months of sales with out-of-stock days shaded. For planners, the forecast details are one click away: sales rate, seasonality, lead time and safety stock, each with a link to change it." |
| 3:30 | Dashboard **Review order** on a supplier → **Order plan → Due now** (that supplier only): order-by date, adjust a quantity, **Create purchase order** → confirm | "Review order opens Due now for that supplier. Suggested quantities come in whole case packs and respect the supplier's minimums; I can adjust any line, then create the order after I confirm." |
| 3:45 | **Order plan → Order calendar**: the summary line, the cash strip, open a week → a supplier's lines → **Create purchase order** | "Order calendar shows every order the forecast needs for thirteen weeks, by week and supplier, with the cash each week takes. A fast seller can need two or three orders in that time; each one starts as a draft I review in Due now." |
| 3:55 | **Download PDF**, **Size grid**, then **Open in your email** (the prepared message in your own email app) → send → **Mark as ordered** → confirm | "I can download it as a PDF or a size grid, or open it in my own email: the message is ready, in the supplier's language, with a link where they confirm. It goes from my own address, so replies come back to me. Then I mark it as ordered." |
| 4:15 | The supplier's inbox → open the email → the confirmation page → pick a date → **Confirm ship date** | "The supplier gets a link — no login. It shows only this order. They pick the ship date and confirm. The link stops working 60 days after the order was sent." |
| 4:45 | Back in the app: **Order plan → Purchase orders**, the order shows the confirmed date; **Products** shows "On order (Keha)" | "Back in Keha the order is confirmed, and the products show the stock on order. When the stock lands in Shopify, the order closes by itself." |
| 5:05 | **Order plan → Season planner**: the "Black Friday 2026" scenario → cash needed per week chart, order list, demand per collection | "The Season planner looks ahead to one event. I picked Black Friday and a 20 percent growth target. It turns last year's shape and today's sales into an order list with order-by dates, and the cash I'll need each week to pay for it." |
| 5:35 | Season planner: **Collection goals**, then **Forecast accuracy** | "I can set a goal share of revenue per collection and see the products holding it back. And Keha grades its own forecasts every month, out in the open." |
| 5:55 | Plans & billing → switch to **Pro** on Shopify's plan page; Settings → **Locations**: Warehouse and two stores | "On Pro, each warehouse and POS store gets its own plan. I mark which location is the warehouse and which are stores." |
| 6:15 | **Products** with the location switcher on a store; **Order plan → Due now** → "Transfers to stores" → **Create transfer in Shopify** → confirm → **Open the transfer in Shopify** | "Each store shows its own sales per day and days of stock. When a store runs low and the warehouse can spare stock, Keha proposes a transfer. After I confirm, it's created in Shopify as a draft; nothing moves until I mark it ready to ship." |
| 6:50 | Settings → **Alerts**: the **Weekly summary** card ("Get it by email with Shopify Flow", **Open Shopify Flow**), instant alerts, Slack connected → **Send a test message**; then Shopify Flow: a workflow with the trigger **Weekly order plan ready** and the action **Send internal email** | "Keha sends no email itself. The weekly summary and instant alerts are Shopify Flow triggers: here a workflow emails the summary to me every Monday. Instant alerts warn when a best seller will run out before new stock can arrive. On Growth and Pro the same summary also goes to Slack." |
| 7:10 | The email that Flow workflow sent, in the inbox | "And this is the weekly summary the workflow sent. The subject says what's due, and it opens with Due this week: each supplier with the units, the cash, the date to order by and whether it's Order now or Order soon, with a Review order link straight into that supplier's order. Below that are the same two numbers as the Dashboard with the change since last week, the top five things to do, and how accurate last month's forecast was." |
| 7:30 | Back on the Dashboard | "On Free you still get the money at stake, the top ten actions and the top ten orders to place; paid features show what they do and an Upgrade button. That's Keha Inventory Planner. Thanks for reviewing." |

Checklist after recording:

- [ ] About 7½ minutes, voice audible, English.
- [ ] Admin URL shows `/apps/keha-inventory`, not an old handle.
- [ ] No shopper data on screen; the supplier mailbox is a test address.
- [ ] Upload (Loom/YouTube unlisted, public link) and paste the link in the submission form.
