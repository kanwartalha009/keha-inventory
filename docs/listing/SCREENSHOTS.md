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
   back-dated. With fewer than 14 days in stock per variant, Home shows "We need at least 14
   days of sales…" instead of numbers. 13 months of history are needed before seasonality shows.
4. Store visits on product pages (open product URLs from a few devices over the weeks).
5. On the day of the shots:
   - 3–5 best sellers running low (days left shorter than the 14-day lead time);
   - 2 products fully sold out for a week or more, still getting visits;
   - 5–10 products with no sale for 90+ days and stock on hand (Clear);
   - one product with several sizes where ⅓ of the sizes are at 0 (Fix · missing sizes).
6. In the app: plan **Growth** (shots 1–5; **Pro** for shot 6); Settings → Suppliers: two suppliers ("Northwind Textiles", 21-day
   lead time; "Atlas Leather", 35 days) assigned by vendor; Settings → Alerts: Monday email on;
   Planner: one scenario "Black Friday 2026" (event Black Friday, target grow 20 %), saved and
   calculated; one collection goal; for shot 6, Settings → Locations: Warehouse = Warehouse,
   the two shops = Store.
7. Wait for one nightly sync after the last change (03:00 store time) so Home shows fresh data.

**[Kanwar to confirm]** which store provides this history: a dev store filled over ≥ 90 days, or
a design-partner store with written consent to show its product names (no shopper data is ever
on screen). Product names, images and vendors in the shots must belong to whoever consents.

## Shot list

| # | Screen | Exact state | What must be visible | Alt text (≤ 64) |
|---|---|---|---|---|
| 1 | **Home** (`/app`) | Growth plan; sync fresh; "This week" tab **All** | The 4 money cards with values (none "—"), one "how we got this" popover open on *Sales lost to sell-outs*, 6–8 action rows of mixed kinds (Reorder, Bridge, Clear, Fix) with their € figures and buttons | `Money at stake and this week's ranked actions` |
| 2 | **Product detail** (`/app/products/<variant>`) — the spec's "Products drawer" is a page in the app | A best seller with a sold-out week in the last 13 months | The 13-month sales chart with sold-out days shaded, "How the forecast was built" (windows, days in stock, seasonal change, lead time, safety stock), days of stock left, order by, suggested qty | `13 months of sales with sold-out days shaded` |
| 3 | **Reorder** (`/app/reorder`) | Two suppliers with lines due; one order already created and confirmed by the supplier | Suppliers grouped, order-by dates, editable quantities rounded to case packs, unit and cost totals, an open order with "Ship date confirmed by the supplier" | `Reorder plan grouped by supplier with order-by dates` |
| 4 | **Planner** (`/app/planner`) | The "Black Friday 2026" scenario open; at least 13 months of history so seasonality applies (otherwise the page says "Not enough sales history for these dates yet.") | "Cash needed per week" bar chart with its table, the order list with order-by dates grouped by supplier, demand per collection | `Season plan with the cash needed per week` |
| 5 | **Monday email** | Store language English; the email of the Monday after the setup | Subject with the amount at stake, the 4 numbers with week-on-week change, top 5 actions with buttons, the accuracy line, unsubscribe link. Shot as a designed frame around the real email (no inbox UI, no recipient address) | `Monday email with the week's top five actions` |
| 6 (optional, pick one) | **Reorder on Pro** (`/app/reorder`) with the location switcher on "Madrid store" and the "Transfers: warehouse → stores" section; *or* the **supplier confirmation page** (`/supplier/confirm/<token>`); *or* **Home → Clear** with the "Create discount" dialog open | Pro: the store's own order advice and a transfer plan line from Warehouse; Supplier page: store name, order number, lines, date picker, "Confirm ship date"; Clear: the percentage and the products, before confirm | `Move stock from the warehouse to a store` / `Supplier confirms the ship date from a link` / `Clear dead stock with a discount you confirm` |

Captions (5–8 words each, optional): reuse the alt text.

## Feature image (1600 × 900)

A designed composition: the Home money cards (values blurred or replaced by "—" shapes, since
statistics are not allowed) over the action list, Keha mark top-left, one line of copy:
"Know what to reorder, push, fix and clear." No prices, no numbers, no Shopify logo.

## Before uploading

- [ ] Every image is exactly 1600 × 900.
- [ ] No price, plan price or trial text visible (the Plans page is never a screenshot).
- [ ] No shopper names, emails or order numbers anywhere (the app has none; check the email
      frame and any browser tabs).
- [ ] Alt text ≤ 64 characters each.
- [ ] Shots taken on the final handle `keha-inventory` and the released app version.
