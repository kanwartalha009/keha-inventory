# Keha Inventory Intelligence tools

These tools read the store's stock planning data from the Keha Inventory Intelligence app. They are read-only: they never change the store.

## Which tool answers what

- **get_order_plan**: the order plan for the next 90 days: what to order, from which supplier, how many, by which date, when it arrives, and the cash needed (per week too, for windows over 14 days). For "today" use `within_days` 1, "this week" 7, "next month" 30, "the next 90 days" 90. Filter one supplier with `supplier`. Some stores get a shorter answer instead: the most urgent products with days left, order-by date and suggested quantity (`shows` says so); answer from that list.
- **get_product_stock**: one product or variant: status, stock on hand, incoming, days of stock left, order-by date, suggested order quantity. Search by product title, variant name or SKU.
- **get_action_list**: the week's ranked to-do list (reorder, bridge, push, fix, clear) with the amount at stake and the reason.
- **get_money_at_stake**: the store-level money numbers (sales at risk, sales lost to sell-outs, cash stuck, sold-out page visits) and the value of dead stock.
- **get_purchase_orders**: open purchase orders and when they are expected to arrive.
- **get_forecast_accuracy**: how far recent forecasts were from actual sales.

Common combinations:
- "When does X run out and should I reorder?" → get_product_stock, then get_order_plan with that product's supplier if it is running low.
- "How much cash do I need for stock next month?" → get_order_plan with `within_days` 30: `totals.cash`, and `cash_per_week` for the weeks.
- "Is stock already on the way?" → get_purchase_orders, and `incoming` / `on_order_with_keha` in get_product_stock.

## Reading the data

- Money is in the currency given next to it (`currency` or `store_currency`); never add amounts of different currencies together.
- `cost` and `cash` count only lines with a unit cost; `lines_without_cost` says how many lines have no cost, so the real amount is higher. Say so when it is set.
- A `null` value means not known yet (for example, not enough sales history). Say "not known yet", never zero. `days_left_why: "no recent sales"` means the product has stock but no recent sale to measure a pace from.
- Days of stock left, order-by dates, suggested quantities and money at stake are forecasts: say "about" ("runs out in about 12 days").
- Dates come as `YYYY-MM-DD` plus a readable label such as "Fri 24 Oct 2026 (in 7 days)". `overdue: true` (an order-by date in the past) means the order is already late: the lead time no longer covers the gap, so it is due today.
- Status words are the app's own: Out, Running low, Healthy, Too much, Dead, Not enough data.
- `note` says when a list was shortened; the full list is in the app page given by `url`.
- `message` means there is nothing to show for this question; pass it on as it is.

## Answers

- For any reorder answer, give the order-by date next to each supplier or product.
- Name products and suppliers as returned.
- Each result has a `url` (an `app:` link) to the page in the app where the merchant can see the details: a supplier's `url` opens Order now with those lines, the order plan's `url` opens the 90-day calendar, and purchase orders open under Open orders. Purchase orders are created and sent from those pages, after the merchant reviews and confirms them; these tools don't create them.
