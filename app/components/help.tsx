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
export function HelpBody({ content }: { content: HelpContent }) {
  const { t } = useLocale();
  const link = useLinkProps();
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
          t("This week in 30 seconds says what to do now. Each tile opens the place to do it."),
          t("Due this week lists the orders to place, by supplier. The bars show the cash your orders need over the next 13 weeks."),
          t("Money at stake shows sales you could lose, sales already lost to sold-out products and cash tied up in stock that isn't selling."),
          t("This week's actions is the full to-do list, ranked by the money at stake."),
        ],
      },
      { title: t("How your numbers are worked out"), paragraphs: how },
    ],
    links: [
      { label: t("Default lead time, order days and safety stock"), to: "/app/settings" },
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
      { label: t("Default lead time, order days and safety stock"), to: "/app/settings" },
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
      { label: t("Default lead time, order days and safety stock"), to: "/app/settings" },
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
          t("Dead stock: no sale in 90 days while you still have stock. A discount clears it."),
          t("Insufficient data: not enough days in stock with sales to forecast yet."),
        ],
      },
      {
        title: t("What you see here"),
        paragraphs: [t("One row per variant. Click a row to see 13 months of sales, the days it was out of stock and how its forecast was built.")],
      },
    ],
    links: [
      { label: t("Default lead time, order days and safety stock"), to: "/app/settings" },
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
