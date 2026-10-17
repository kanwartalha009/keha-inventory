# Screenshots and feature image — Keha Inventory Intelligence

Rules (shopify.dev App Store requirements checklist, playbook §8):

- **Size:** 1600 × 900 px (16:9), PNG or JPEG. 3–6 desktop screenshots.
- **Content:** the real app UI, designed from real screens. No browser chrome, no customer
  data, no stock or model photos, no prices in screenshots.
- **Alt text:** required for every image; keep it ≤ 64 characters (playbook).
- **Feature image:** 1600 × 900, no pricing, no statistics, no Shopify logos, contrast ≥ 4.5:1.
- **Icon:** 1200 × 1200, no text.
- Capture in English first. Use the admin at 100 % zoom on a 1600 × 900 viewport (or 3200 × 1800
  at 2× and downscale), app content only.

## The store to set up (once, for every shot)

A development store whose data looks like a small real brand. The numbers come from the store's
own history, so it must have history before the shots are taken:

1. 40–80 products, 150–300 variants, **Track quantity on** for all of them, a cost per item on
   most (leave 2–3 without cost so a card shows "at retail price").
2. Locations: one warehouse that fulfils online orders ("Warehouse") and two shops selling
   through Shopify POS ("Madrid store", "Barcelona store") with their own stock and POS sales
   (only needed for the Pro shot 6).
3. **Sales history of at least 90 days** (the sales-rate windows are 28 / 56 / 90 days) placed as
   real test orders over time — ShopifyQL reads the store's own sales, and orders can't be
   back-dated. With fewer than 14 days in stock per variant, the Dashboard shows "We need at least 14
   days of sales…" instead of numbers. 13 months of history are needed before seasonality shows.
4. Store visits on product pages (open product URLs from a few devices over the weeks).
5. On the day of the shots:
   - 3–5 best sellers running low (days left shorter than the 14-day lead time);
   - 2 products fully sold out for a week or more, still getting visits;
   - 5–10 products with no sale for 90+ days and stock on hand (Clear);
   - one product with several sizes where ⅓ of the sizes are at 0 (Fix · missing sizes).
6. In the app: plan **Growth** (shots 1–5; **Pro** for shot 6); Settings → Suppliers: two suppliers ("Northwind Textiles", 21-day
   lead time; "Atlas Leather", 35 days) assigned by vendor; Settings → Alerts: Monday email on;
   Order plan → Season plan: one scenario "Black Friday 2026" (event Black Friday, target grow 20 %), saved and
   calculated; one collection goal; for shot 6, Settings → Locations: Warehouse = Warehouse,
   the two shops = Store. For shots 1–3, leave one supplier's best seller overdue (so "Order this
   week" shows an Overdue badge) and give one product no cost (the "lines without a cost price"
   note).
7. Wait for one nightly sync after the last change (03:00 store time) so the Dashboard shows fresh data.

**[Kanwar to confirm]** which store provides this history: a dev store filled over ≥ 90 days, or
a design-partner store with written consent to show its product names (no shopper data is ever
on screen). Product names, images and vendors in the shots must belong to whoever consents.

## Shot list

| # | Screen | Exact state | What must be visible | Alt text (≤ 64) |
|---|---|---|---|---|
| 1 | **Dashboard** (`/app`) | Growth plan; sync fresh | "Order this week" first: two suppliers with products, units, cash and order-by date (one **Overdue**), the **Review order** buttons, the 12-week cash strip; the 4 money cards below it (none "—") | `Order this week by supplier, and the cash needed` |
| 2 | **Order plan → Next 90 days** (`/app/reorder/calendar`) | Same store; the first week with orders open | The summary line (orders, units, cash for 13 weeks), the cash strip, week rows with suppliers, units, cash and order-by dates; inside the open week, a supplier with its lines and **Create order** | `Every order for the next 13 weeks, by week and supplier` |
| 3 | **Order plan → Order now** (`/app/reorder`) | Two suppliers with lines due today | The tab bar, suppliers grouped, order-by dates, editable quantities rounded to case packs, unit and cost totals | `Order now, grouped by supplier with order-by dates` |
| 4 | **Product detail** (`/app/products/<variant>`) — the spec's "Products drawer" is a page in the app | A best seller with a sold-out week in the last 13 months | The 13-month sales chart with sold-out days shaded, "How the forecast was built" (windows, days in stock, seasonal change, lead time, safety stock), days of stock left, order by, suggested qty | `13 months of sales with sold-out days shaded` |
| 5 | **Order plan → Season plan** (`/app/planner`) | The "Black Friday 2026" scenario open; at least 13 months of history so seasonality applies (otherwise the page says "Not enough sales history for these dates yet.") | "Cash needed per week" bar chart with its table, the order list with order-by dates grouped by supplier, demand per collection | `Season plan with the cash needed per week` |
| 6 (optional, pick one) | The **Monday email** (store language English, the Monday after the setup, shot as a designed frame around the real email — no inbox UI, no recipient address); *or* **Order now on Pro** (`/app/reorder`) with the location switcher on "Madrid store" and the "Transfers: warehouse → stores" section; *or* the **supplier confirmation page** (`/supplier/confirm/<token>`); *or* **Dashboard → Clear** with the "Create discount" dialog open | Email: subject with the amount at stake, the 4 numbers with week-on-week change, top 5 actions with buttons, the accuracy line, unsubscribe link; Pro: the store's own order advice and a transfer plan line from Warehouse; Supplier page: store name, order number, lines, date picker, "Confirm ship date"; Clear: the percentage and the products, before confirm | `Monday email with the week's top five actions` / `Move stock from the warehouse to a store` / `Supplier confirms the ship date from a link` / `Clear dead stock with a discount you confirm` |

Captions (5–8 words each, optional): reuse the alt text.

## Feature image (1600 × 900)

A designed composition: the Dashboard's "Order this week" block and the cash strip (values
blurred or replaced by "—" shapes, since statistics are not allowed), Keha mark top-left, one
line of copy: "Know what to order, from whom and when." No prices, no numbers, no Shopify logo.

## Before uploading

- [ ] Every image is exactly 1600 × 900.
- [ ] No price, plan price or trial text visible (the Plans page is never a screenshot).
- [ ] No shopper names, emails or order numbers anywhere (the app has none; check the email
      frame and any browser tabs).
- [ ] Alt text ≤ 64 characters each.
- [ ] Shots taken on the final handle `keha-inventory` and the released app version.
