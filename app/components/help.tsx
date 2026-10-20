/**
 * "How it works" (Kanwar 2026-10-18): every main page has a button that opens a panel explaining
 * the page in plain words, with this store's own numbers where they exist, and links to the
 * setting behind each number. Content is built per page from the page's own loader data.
 */
import { fill, useLocale } from "../lib/i18n";
import { formatCount } from "../lib/dashboard-shared";
import type { OrderWhy } from "../lib/engine/forward-plan-shared";
import { useLinkProps } from "./wc";

export type HelpLink = { label: string; to: string };
export type HelpSection = { title: string; paragraphs: string[] };
export type HelpContent = { sections: HelpSection[]; links: HelpLink[] };

/** The panel body (AppPage opens it in a large dialog). */
export function HelpBody({
  content,
  onNavigate,
}: {
  content: HelpContent;
  /** Close the dialog, then go to `to` (AppPage): a page change must never happen while it is shown (2026-10-20). */
  onNavigate?: (to: string) => void;
}) {
  const { t } = useLocale();
  const linkProps = useLinkProps();
  const link = (to: string) => {
    const p = linkProps(to);
    return {
      ...p,
      onClick: (e: Event) => {
        const me = e as unknown as MouseEvent;
        if (!onNavigate || me.metaKey || me.ctrlKey || me.shiftKey || me.button === 1) return p.onClick(e);
        e.preventDefault();
        onNavigate(to);
      },
    };
  };
  return (
    <s-stack direction="block" gap="base">
      {content.sections.map((s) => (
        <s-stack key={s.title} direction="block" gap="small-200">
          <s-heading>{s.title}</s-heading>
          {s.paragraphs.map((p) => (
            <s-paragraph key={p}>{p}</s-paragraph>
          ))}
        </s-stack>
      ))}
      {content.links.length > 0 && (
        <s-stack direction="block" gap="small-200">
          <s-heading>{t("Change how it works")}</s-heading>
          {content.links.map((l) => (
            <s-link key={l.to + l.label} {...link(l.to)}>
              {l.label}
            </s-link>
          ))}
        </s-stack>
      )}
    </s-stack>
  );
}

type T = (s: string) => string;

/** Dashboard: what each part is, and the store's own lead time, order days and cost coverage. */
export function dashboardHelp(t: T, locale: string, d: { leadTimeDays: number; cycleDays: number | null; costPercent: number | null; supplierCount: number }): HelpContent {
  const how = [
    t("We read your sales and stock every night. Sales per day only count the days a product was in stock, so a sell-out never makes it look slow."),
    d.cycleDays
      ? fill(t("An order arrives after the lead time ({lead} days unless a supplier has its own) and covers {cycle} days of sales after that, plus safety stock for surprises."), {
          lead: formatCount(d.leadTimeDays, locale),
          cycle: formatCount(d.cycleDays, locale),
        })
      : fill(t("An order arrives after the lead time ({lead} days unless a supplier has its own) and lasts the days set under Order enough for, plus safety stock for surprises."), {
          lead: formatCount(d.leadTimeDays, locale),
        }),
  ];
  if (d.costPercent !== null && d.costPercent < 100)
    how.push(fill(t("Cost prices are known for {pct}% of your products. The rest are left out of cash totals until you add a cost in Shopify."), { pct: formatCount(Math.round(d.costPercent), locale) }));
  return {
    sections: [
      {
        title: t("What you see here"),
        paragraphs: [
          t("This week says what to do now. Each tile opens the place to do it. Below the tiles, the money at stake shows sales you could lose, sales already lost to sold-out products and cash tied up in stock that isn't selling."),
          t("Due this week lists the orders to place, by supplier. The bars show the cash your orders need over the next 13 weeks."),
          t("This week's actions shows the top 5 to-dos, ranked by the money at stake. The whole list is on the Actions page."),
        ],
      },
      { title: t("How your numbers are worked out"), paragraphs: how },
    ],
    links: [
      { label: t("Default lead time, Order enough for and safety stock"), to: STORE_SETTINGS },
      { label: d.supplierCount > 0 ? t("Suppliers: lead times, case packs and minimums") : t("Add your suppliers"), to: "/app/settings/suppliers" },
    ],
  };
}

/** Due now's example: the first line ordered today that has the plan's terms. */
export function dueNowExample(
  groups: readonly { lines: readonly { productTitle: string; variantTitle: string; why: readonly OrderWhy[]; suggested: number }[] }[],
): { product: string; why: OrderWhy; qty: number } | null {
  for (const g of groups)
    for (const l of g.lines) {
      const why = l.why[0];
      if (why && why.day === 0) {
        const v = l.variantTitle && l.variantTitle !== "Default Title" ? l.variantTitle : null;
        return { product: v ? `${l.productTitle} · ${v}` : l.productTitle, why, qty: l.suggested };
      }
    }
  return null;
}

/** Due now: how a quantity is reached, with a real line of this store as the example. */
export function dueNowHelp(t: T, locale: string, example: { product: string; why: OrderWhy; qty: number } | null): HelpContent {
  const n = (v: number, digits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v);
  const how = [
    t("A quantity is the sales expected until the next order arrives, plus safety stock, minus what you have and what is already on order. It is then rounded up to the case pack and the supplier's minimums."),
  ];
  if (example)
    how.push(
      fill(
        (example.why.missed ?? 0) >= 0.5
          ? t("Example from your store — {product}: it sells {rate} a day. Over the next {days} days that is {demand}. Add safety stock {safety}, take away {onHand} on hand, {onOrder} on order and {missed} it can't sell while out of stock before the order arrives, and you need {need}: ordered as {qty}.")
          : t("Example from your store — {product}: it sells {rate} a day. Over the next {days} days that is {demand}. Add safety stock {safety}, take away {onHand} on hand and {onOrder} on order, and you need {need}: ordered as {qty}."),
        {
        product: example.product,
        rate: n(example.why.rate * example.why.season * example.why.growth, 2),
        days: n(example.why.days),
        demand: n(example.why.demand),
        safety: n(example.why.safety),
        onHand: n(example.why.onHand),
        onOrder: n(example.why.onOrder),
        missed: n(example.why.missed ?? 0),
        need: n(Math.max(0, example.why.need)),
        qty: n(example.qty),
        },
      ),
    );
  return {
    sections: [
      {
        title: t("What you see here"),
        paragraphs: [
          t("Everything to order in the next 7 days, one card per supplier. Each line has its order-by date: the last day to order before it runs low."),
          t("Change any quantity, pick how many days the order should cover with Order enough for, then create the purchase order. Nothing reaches your supplier until you send it."),
        ],
      },
      { title: t("How quantities are worked out"), paragraphs: how },
    ],
    links: [
      { label: t("Suppliers: lead times, case packs and minimums"), to: "/app/settings/suppliers" },
      { label: t("Default lead time, Order enough for and safety stock"), to: STORE_SETTINGS },
    ],
  };
}

export function calendarHelp(t: T): HelpContent {
  return {
    sections: [
      {
        title: t("What you see here"),
        paragraphs: [
          t("Every order the plan expects over the next 13 weeks, week by week, with the cash each week needs."),
          t("Open a week to see its suppliers and products. Build purchase order starts one of those orders early."),
          t("Lines without a cost price aren't in the cash totals. Add the cost per item in Shopify to include them."),
        ],
      },
    ],
    links: [
      { label: t("Due now"), to: "/app/reorder" },
      { label: t("Default lead time, Order enough for and safety stock"), to: STORE_SETTINGS },
    ],
  };
}

/** The Actions page (0286): the whole to-do list, by tab. */
export function actionsHelp(t: T): HelpContent {
  return {
    sections: [
      {
        title: t("What each tab means"),
        paragraphs: [
          t("Reorder: products that run out before a new order would arrive."),
          t("Stock gaps: sold-out products shoppers still look for. Reorder them or take preorders."),
          t("Promote: products with plenty of stock that sell well when people see them."),
          t("Product issues: missing sizes, weak product pages, high returns and falling best sellers."),
          t("Clearance: stock that isn't selling. A discount turns it back into cash."),
        ],
      },
      {
        title: t("How the list works"),
        paragraphs: [
          t("Every action shows the money at stake, and the list is ranked by it. Why this action, in the ··· menu, shows the numbers behind it."),
          t("Mark as done, Snooze 7 days or Dismiss takes an action off the list. A dismissed action comes back if the money at stake doubles."),
          t("The list is worked out again every night from your sales and stock."),
        ],
      },
    ],
    links: [
      { label: t("Dashboard"), to: "/app" },
      { label: t("Due now"), to: "/app/reorder" },
    ],
  };
}

export function productsHelp(t: T): HelpContent {
  return {
    sections: [
      {
        title: t("What each status means"),
        paragraphs: [
          t("Out of stock: nothing left to sell."),
          t("Low stock: it runs out before a new order would arrive. Order it now."),
          t("In stock: enough until the next order."),
          t("Overstock: far more than you will sell before the next order."),
          t("Dead stock: no sale for the days set in Settings (90 by default) while you still have stock. A discount clears it."),
          t("Insufficient data: not enough days in stock with sales to forecast yet."),
        ],
      },
      {
        title: t("What you see here"),
        paragraphs: [t("One row per variant. Click a row to see 13 months of sales, the days it was out of stock and how its forecast was built.")],
      },
    ],
    links: [
      { label: t("Default lead time, Order enough for and safety stock"), to: STORE_SETTINGS },
      { label: t("Suppliers: lead times, case packs and minimums"), to: "/app/settings/suppliers" },
    ],
  };
}

export function purchaseOrdersHelp(t: T): HelpContent {
  return {
    sections: [
      {
        title: t("How a purchase order moves"),
        paragraphs: [
          t("Draft: not sent yet. Change or delete it freely. Its units count as on order for 14 days, so they aren't suggested twice."),
          t("Ordered: you sent it to the supplier. Its units count as on order until they arrive."),
          t("Confirmed: the supplier confirmed a ship date."),
          t("Receive items when goods arrive; part of an order is fine. Close order when nothing more will come."),
          t("Cancel order if it won't be delivered at all. A closed or canceled order can be reopened within 30 days."),
        ],
      },
    ],
    links: [{ label: t("Due now"), to: "/app/reorder" }],
  };
}

/** Settings links shared by the panels (S4: the setting behind each number, one click away). */
const STORE_SETTINGS = "/app/settings?more=1";
const SUPPLIER_SETTINGS = "/app/settings/suppliers";

/** Season planner: what a scenario is and how its numbers are built. */
export function seasonHelp(t: T): HelpContent {
  return {
    sections: [
      {
        title: t("What you see here"),
        paragraphs: [
          t("A scenario is a period you plan for: a season, a sale or a growth target. Give it dates and the growth you expect."),
          t("For that period you see the expected sales and revenue, what to order and by when, and the cash needed each week."),
          t("Results are calculated when you save. Nothing in your store changes."),
        ],
      },
      {
        title: t("How the numbers are worked out"),
        paragraphs: [
          t("Expected sales are sales per day while in stock, times last year's season for those weeks, times your growth."),
          t("Collection goals compare each collection's share of revenue with the share you set, so you see where to push."),
        ],
      },
    ],
    links: [
      { label: t("Order calendar"), to: "/app/reorder/calendar" },
      { label: t("Default lead time, Order enough for and safety stock"), to: STORE_SETTINGS },
    ],
  };
}

/** Product detail: the chart, the forecast terms, and what can be changed on the page. */
export function productDetailHelp(t: T, locale: string, d: { leadTimeDays: number | null; cycleDays: number | null; fromSupplier: boolean }): HelpContent {
  const how = [t("How the forecast was built lists every number the forecast used: the sales windows, the season, the trend, the lead time, Order enough for and the safety stock.")];
  if (d.leadTimeDays !== null && d.cycleDays !== null)
    how.push(
      fill(t("An order for this product takes {lead} days to arrive and is sized to last {cycle} days after that, plus safety stock."), {
        lead: formatCount(d.leadTimeDays, locale),
        cycle: formatCount(d.cycleDays, locale),
      }),
    );
  return {
    sections: [
      {
        title: t("What you see here"),
        paragraphs: [
          t("13 months of sales per day. Shaded days were out of stock: they never count as slow days."),
          ...how,
        ],
      },
      {
        title: t("What you can change here"),
        paragraphs: [
          t("Case size and supplier code are saved for this product and used on its purchase orders."),
          t("Forecast like another product while this one is new and has few days in stock."),
          t("Don't reorder keeps the product in your stock numbers but never puts it in an order."),
        ],
      },
    ],
    links: d.fromSupplier
      ? [
          { label: t("Suppliers: lead times, case packs and minimums"), to: SUPPLIER_SETTINGS },
          { label: t("Default lead time, Order enough for and safety stock"), to: STORE_SETTINGS },
        ]
      : [
          { label: t("Default lead time, Order enough for and safety stock"), to: STORE_SETTINGS },
          { label: t("Suppliers: lead times, case packs and minimums"), to: SUPPLIER_SETTINGS },
        ],
  };
}

/** Build purchase order: one supplier's lines, the quantities and what Create does. */
export function buildOrderHelp(t: T): HelpContent {
  return {
    sections: [
      {
        title: t("What you see here"),
        paragraphs: [
          t("Every product due from this supplier now and before your next order, each with a suggested quantity."),
          t("Quantities are rounded to the case pack and topped up to the supplier's minimum. The info button on a line shows the sum."),
        ],
      },
      {
        title: t("What you can change here"),
        paragraphs: [
          t("Change any quantity, or untick a line to leave it out. Add products adds any product from this supplier, at any quantity."),
          t("Order enough for changes the days this one order covers. Your default stays as it is."),
          t("Create purchase order saves a draft. Nothing goes to the supplier until you send it."),
        ],
      },
    ],
    links: [
      { label: t("Suppliers: lead times, case packs and minimums"), to: SUPPLIER_SETTINGS },
      { label: t("Default lead time, Order enough for and safety stock"), to: STORE_SETTINGS },
    ],
  };
}

export type SettingsHelpTab = "defaults" | "suppliers" | "locations" | "alerts" | "import";

/** Settings: one panel per tab, in plain words. */
export function settingsHelp(t: T, tab: SettingsHelpTab): HelpContent {
  const after = t("After you save, the numbers are worked out again: the order plan and product statuses use your change within a few minutes.");
  switch (tab) {
    case "defaults":
      return {
        sections: [
          {
            title: t("What each setting does"),
            paragraphs: [
              t("Default lead time: days from placing an order to the stock arriving. Used until a supplier has its own."),
              t("Order enough for: days of stock each order lasts after it arrives. You can change it for a single order when you build it."),
              t("Safety stock: extra stock for surprises. Higher means fewer sell-outs and more cash tied up in stock."),
              t("Overstock and dead stock: when a product is flagged for too much stock, or for no sales."),
              after,
            ],
          },
        ],
        links: [{ label: t("Suppliers: lead times, case packs and minimums"), to: SUPPLIER_SETTINGS }],
      };
    case "suppliers":
      return {
        sections: [
          {
            title: t("What a supplier changes"),
            paragraphs: [
              t("A supplier's lead time, Order enough for, minimums and case pack replace your store defaults for every product it delivers."),
              t("Products match a supplier by vendor, or you assign them one by one."),
              t("Once a few orders have arrived, the measured lead time is shown, and you can use it with one click."),
              after,
            ],
          },
        ],
        links: [{ label: t("Default lead time, Order enough for and safety stock"), to: STORE_SETTINGS }],
      };
    case "locations":
      return {
        sections: [
          {
            title: t("How this is used"),
            paragraphs: [
              t("Purchase orders, daily sales and days of stock are worked out from the stock in every included location."),
              t("Leave a location out when its stock isn't for sale, for example a returns room."),
            ],
          },
        ],
        links: [],
      };
    case "alerts":
      return {
        sections: [
          {
            title: t("What you get"),
            paragraphs: [
              t("Every Monday at 08:00 in your store's time zone: the money at stake and what to do this week."),
              t("When a best seller will run out before new stock can arrive, or a busy product sells out."),
              t("Slack gets the same weekly summary and alerts when it's connected."),
            ],
          },
        ],
        links: [],
      };
    case "import":
      return {
        sections: [
          {
            title: t("How importing works"),
            paragraphs: [
              t("Download the file, fill it in a spreadsheet and upload it. We check it and show what will change before anything is saved."),
              t("Suppliers and products not in the file stay as they are."),
              t("Leave a column out to keep its values. An empty cell clears the value."),
            ],
          },
        ],
        links: [{ label: t("Suppliers"), to: SUPPLIER_SETTINGS }],
      };
  }
}

/** Plans & billing. */
export function plansHelp(t: T): HelpContent {
  return {
    sections: [
      {
        title: t("What each plan includes"),
        paragraphs: [
          t("Start free with your 10 most urgent products. Growth plans every order by supplier, with purchase orders and the cash per week. Pro plans each warehouse and store."),
          t("Billed through Shopify. Choose, change or cancel your plan on Shopify's plan page any time. A downgrade never deletes your data."),
        ],
      },
    ],
    links: [],
  };
}
