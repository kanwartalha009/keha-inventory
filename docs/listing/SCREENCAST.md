# Screencast script — Keha Inventory Intelligence (review video)

Target: **5–6 minutes** (Shopify asks for 3–8), English voice-over, 1600 × 900 or 1920 × 1080,
no music needed. Record it **last**: on the final handle `keha-inventory`, on the released app
version, after `/health` shows sync fresh and `pricing.lastOkAt` set (playbook §8, mistake #22).

Store: the store from `SCREENSHOTS.md` (sales history ≥ 90 days, suppliers set up). To show
install → first numbers honestly, use a second store with history where the app is **not**
installed yet, or cut from the install to the same store after its first sync and say so.
**[Kanwar to confirm]** which store and whether the cut is acceptable to him.

Before recording: a mailbox you can show for the supplier (not a real supplier), Slack test
channel connected, the Monday email of the latest Monday in the inbox.

| Time | On screen | Voice-over |
|---|---|---|
| 0:00 | Shopify admin, App Store listing, click **Install** | "This is Keha Inventory Intelligence. Every Monday it tells you what to do with each product — reorder, push, fix or clear — and how much money is at stake. Let's install it." |
| 0:20 | OAuth screen: the permissions list | "It asks to read products, stock, locations and Shopify's analytics reports. It never asks for orders or customers: sales come in as daily totals per product, so no shopper data is stored. It can create a discount or a stock transfer, but only when you press confirm." |
| 0:45 | Shopify's plan page: Free / Growth / Pro; pick **Growth** (test store) | "Pricing is on Shopify's own plan page. Free shows the money and the top ten actions. I'll pick Growth for the full list and reordering." |
| 1:00 | Home: "Reading your store…" with a progress bar per dataset | "There's nothing to set up. Keha reads your products, stock history, sales history and store visits. The newest ninety days come first, so numbers appear quickly; older months fill in behind." |
| 1:20 | (Cut, say "a few minutes later" on screen) Home with the 4 money cards | "Here are the four numbers. Sales at risk in the next 28 days. Sales lost to sell-outs over the last 90. Cash stuck in stock that doesn't move. And the value of visits that landed on sold-out product pages." |
| 1:45 | Open the "How we got this" popover on *Sales lost to sell-outs* | "Every number shows how we got it. Sales per day count only the days a product was in stock, so a sell-out never drags the forecast down. When data is missing you see a dash, never a zero." |
| 2:05 | The action list, tab **All**, then **Reorder**, **Fix**, **Clear** | "Below is this week's to-do list, ranked by money. Each row says what to do, why, and what it's worth." |
| 2:25 | **Clear** tab → **Create discount** → the confirm dialog → confirm → Shopify Discounts list shows it | "This product hasn't sold in over 90 days. I'll create a 20 percent discount. Nothing changes in the store until I confirm. There it is in Shopify's discounts." |
| 2:55 | A **Reorder** row → **Products** → the variant page: 13-month chart, "How the forecast was built" | "This best seller runs out before new stock could arrive. The product page shows thirteen months of sales with sold-out days shaded, and how the order quantity was built: sales rate, seasonality, lead time and safety stock." |
| 3:30 | **Reorder**: grouped by supplier, order-by date, adjust a quantity, **Create order** | "Reorder groups everything by supplier, with the date to order by. Suggested quantities come in whole case packs and respect the supplier's minimums; I can adjust any line, then create the order." |
| 3:55 | **Download PDF**, **Download CSV**, then **Email supplier** | "I can download it as a PDF or CSV, or email it straight to the supplier. Replies come back to the store's own email." |
| 4:15 | The supplier's inbox → open the email → the confirmation page → pick a date → **Confirm ship date** | "The supplier gets a link — no login. It shows only this order. They pick the ship date and confirm. The link stops working 60 days after the order was sent." |
| 4:45 | Back in the app: the order shows the confirmed date; **Products** shows "On order with Keha" | "Back in Keha the order is confirmed, and the products show the stock on order. When the stock lands in Shopify, the order closes by itself." |
| 5:05 | Settings → **Alerts**: Monday email recipients, instant alerts, Slack connected → **Send a test message** | "Alerts: the Monday email goes to the store owner by default. Instant alerts warn when a best seller will run out before new stock can arrive. On Growth the same summary goes to Slack." |
| 5:25 | The Monday email in the inbox | "And this is the Monday email: the four numbers with the change since last week, the top five actions with buttons straight into the app, and how accurate last month's forecast was." |
| 5:45 | Plans page in the app; switch the view to Free features (locks) | "On Free you still get the four numbers and the top ten actions; paid features show what they do and an Upgrade button." |
| 6:00 | End on Home | "That's Keha Inventory Intelligence. Thanks for reviewing." |

Not in the video because it isn't built yet: the season planner, per-location planning and
transfers (Pro). Don't show or mention them until they ship.

Checklist after recording:

- [ ] 3–8 minutes, voice audible, English.
- [ ] Admin URL shows `/apps/keha-inventory`, not an old handle.
- [ ] No shopper data on screen; the supplier mailbox is a test address.
- [ ] Upload (Loom/YouTube unlisted, public link) and paste the link in the submission form.
