/**
 * Order plan · supplier order builder (/app/reorder/build?supplier=<key>[&from=&to=]) —
 * consolidated supplier purchase order (Kanwar 2026-10-17). Growth (`reorderPlan`; every action
 * checks the plan on the server too).
 *
 * One purchase order per supplier per cycle: for the supplier, from the same forward plan as
 * Order now and Next 13 weeks (lib/supplier-order-shared, models/supplier-order.server):
 *  - "Due now" — its lines due in the next 7 days, overdue included (or, opened from Next 13
 *    weeks, its lines of that week), selected;
 *  - "Due before your next order" — its later lines up to the end of its order cycle (Settings →
 *    Suppliers "Order every … days", else the store's cycle), selected, each with its own date;
 *  - "Add products" — any of its products, any quantity.
 * Quantities are editable; units, cost (store currency, and the supplier's with an exchange rate)
 * and the supplier's minimums (per style, units, money) update live, with what is missing and a
 * one-click top-up (the forward plan's own top-up functions). Each planned line keeps "Why this
 * quantity" and its order-by date. "Create draft order" (confirm with units and cost) saves ONE
 * Keha draft with every selected line and opens it; with a fresh draft for the supplier, "Add to
 * PO-00xx" adds the lines to it instead. Nothing is sent until the merchant emails the order or
 * marks it sent. The draft counts as ordered (under 14 days), so its lines leave Order now and
 * Next 13 weeks.
 *
 * Free: the teaching lock with the supplier's own numbers (products, units, cash; no lines).
 * The page gates itself (ORDER_PLAN_PATHS).
 */
import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { addToSupplierDraft, createSupplierDraft, loadSupplierOrder, type SupplierOrderResult } from "../models/supplier-order.server";
import { AppPage, EmptyState, FormCard, HeaderLabel, KvRow, ProductThumb } from "../components/ui";
import { DueLabel, WhyPopover } from "../components/order-plan";
import { planTag } from "../components/plan";
import ConfirmModal from "../components/ConfirmModal";
import { flag, isChecked, useLinkProps, val } from "../components/wc";
import { fill, useLocale } from "../lib/i18n";
import { formatAmount, formatCount, formatDay } from "../lib/dashboard-shared";
import { daysBetween } from "../lib/engine/dates-shared";
import { variantName } from "../lib/products-shared";
import { formatPrice } from "../lib/purchase-order-shared";
import { quantitiesKey } from "../lib/quantities-key-shared";
import { formatDayRange } from "../lib/order-plan-shared";
import { groupTitle, readQty } from "../lib/reorder-shared";
import {
  addedLine,
  builderTeaser,
  builderTotals,
  minimumStatus,
  readBuilderLink,
  readBuilderQuantities,
  sortBuilderLines,
  topUpOrder,
  type AddableProduct,
  type BuilderLine,
  type BuilderSection,
  type BuilderTeaser,
  type QtyLine,
  type SupplierOrderView,
} from "../lib/supplier-order-shared";
import type { BuilderProductsData } from "./app.reorder_.build_.products";

export type BuilderPageData =
  | { enabled: true; view: SupplierOrderView | null; today: string }
  | { enabled: false; teaser: BuilderTeaser | null };

export const loader = async ({ request }: LoaderFunctionArgs): Promise<BuilderPageData> => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  const link = readBuilderLink(new URL(request.url).searchParams);
  const load = link ? await loadSupplierOrder(session.shop, link.supplierKey, link.range) : null;
  // Free: the lock teaches with this supplier's own numbers; no line, product or price is sent.
  if (!features.reorderPlan) return { enabled: false, teaser: load && load.view.lines.length ? builderTeaser(load.view) : null };
  return { enabled: true, view: load?.view ?? null, today: load?.today ?? new Date().toISOString().slice(0, 10) };
};

export type BuilderAction = SupplierOrderResult;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.reorderPlan) return upgradeResponse("reorderPlan", "The order plan is on the Growth plan.");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  const key = typeof body.supplier === "string" && /^(supplier|vendor):/.test(body.supplier) && body.supplier.length <= 300 ? body.supplier : null;
  if (!key) throw new Response("Bad request", { status: 400 });
  const quantities = readBuilderQuantities(body.quantities);
  if (body.intent === "create") return (await createSupplierDraft(session.shop, key, quantities)) satisfies BuilderAction;
  if (body.intent === "add" && typeof body.draftId === "string" && body.draftId.length <= 100) {
    return (await addToSupplierDraft(session.shop, key, body.draftId, quantities, body.version)) satisfies BuilderAction;
  }
  throw new Response("Bad request", { status: 400 });
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

/** After a draft is created or added to, the page opens it: re-reading the plan first is wasted work. */
export const shouldRevalidate: ShouldRevalidateFunction = ({ actionResult, defaultShouldRevalidate }) => {
  const r = actionResult as BuilderAction | undefined;
  return r?.ok ? false : defaultShouldRevalidate;
};

export default function SupplierOrderBuilder() {
  const { t } = useLocale();
  const data = useLoaderData<typeof loader>() as BuilderPageData;
  if (!data.enabled) {
    return (
      <AppPage heading={t("Order plan")} breadcrumb={{ label: t("Order now"), to: "/app/reorder" }}>
        <BuilderLock teaser={data.teaser} />
      </AppPage>
    );
  }
  if (!data.view) {
    return (
      <AppPage heading={t("Build supplier order")} breadcrumb={{ label: t("Order now"), to: "/app/reorder" }}>
        <s-section>
          <EmptyState body={t("This supplier doesn't exist any more. Reload the page.")} />
        </s-section>
      </AppPage>
    );
  }
  return <Builder view={data.view} today={data.today} />;
}

/** The plan lock: what the builder does, the supplier's own numbers, and the way to the plans (I-6). */
function BuilderLock({ teaser }: { teaser: BuilderTeaser | null }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  return (
    <s-section>
      <s-empty-state heading={`${t("Build supplier order")} · ${planTag("reorderPlan", t)}`}>
        <s-paragraph slot="subheading">
          {t("Pick a supplier and get one purchase order with everything due before your next order to it, topped up to its minimums.")}
        </s-paragraph>
        {teaser && (
          <s-paragraph>
            {fill(t("{supplier}: {n} products to order in the next {days} days — {units} units, {cash}. Growth puts them in one purchase order."), {
              supplier: groupTitle(teaser, t),
              n: formatCount(teaser.products, locale),
              days: formatCount(teaser.cycleDays, locale),
              units: formatCount(teaser.units, locale),
              cash: formatAmount(teaser.cash, teaser.currency, locale),
            })}
          </s-paragraph>
        )}
        <s-button slot="primary-action" variant="primary" {...link("/app/plans?upgrade=reorderPlan")}>
          {t("See plans")}
        </s-button>
      </s-empty-state>
    </s-section>
  );
}

/** Store amount, and the supplier's when its currency differs and the rate is known: "€1,200 · $1,300". */
function money(store: number | null, supplier: number | null, view: Pick<SupplierOrderView, "currency" | "storeCurrency">, locale: string): string {
  const a = formatPrice(store, view.storeCurrency, locale);
  if (view.currency === view.storeCurrency || supplier === null || store === null) return a;
  return `${a} · ${formatPrice(supplier, view.currency, locale)}`;
}

function Builder({ view, today }: { view: SupplierOrderView; today: string }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const navigate = useNavigate();
  const fetcher = useFetcher<BuilderAction>();
  const products = useFetcher<BuilderProductsData>();
  const title = groupTitle(view, t);
  // Lines added by hand (client side until the draft is created).
  const [added, setAdded] = useState<BuilderLine[]>([]);
  const lines = useMemo(() => sortBuilderLines([...view.lines, ...added.filter((a) => !view.lines.some((l) => l.variantId === a.variantId))]), [view, added]);
  // Reset typed quantities only when the plan's lines change, not on every revalidation.
  const resetKey = quantitiesKey(view.key, view.lines.map((l) => [l.variantId, l.suggested] as const));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => Object.fromEntries(view.lines.map((l) => [l.variantId, String(l.suggested)])), [resetKey]);
  const [qty, setQty] = useState<Record<string, string>>(initial);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<"create" | "add" | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    setQty(initial);
    setOff({});
  }, [initial]);
  useEffect(() => {
    const d = fetcher.data;
    if (d && d.ok) navigate(`/app/reorder/${d.id}`);
  }, [fetcher.data, navigate]);

  const qtyLines: QtyLine[] = lines.map((l) => ({ ...l, qty: off[l.variantId] ? 0 : readQty(qty[l.variantId]) }));
  const totals = builderTotals(view, qtyLines);
  const status = minimumStatus(view, qtyLines);
  const costText = money(totals.cost, totals.supplierCost, view, locale);
  const busy = fetcher.state !== "idle";
  const failed = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const draft = view.draft;
  const quantities = () => Object.fromEntries(qtyLines.filter((l) => l.qty > 0).map((l) => [l.variantId, l.qty]));
  const submit = (intent: "create" | "add") =>
    fetcher.submit(
      { intent, supplier: view.key, quantities: quantities(), ...(intent === "add" && draft ? { draftId: draft.id, version: draft.updatedAt } : {}) } as never,
      { method: "post", encType: "application/json" },
    );
  const topUp = () => {
    const next = topUpOrder(view, qtyLines);
    setQty((s) => ({ ...s, ...Object.fromEntries(qtyLines.map((l, i) => [l.variantId, String(next[i])])) }));
  };
  const search = (text: string) => {
    setQ(text);
    products.load(`/app/reorder/build/products?${new URLSearchParams({ supplier: view.key, q: text.trim() }).toString()}`);
  };
  // "Add products" opens with the supplier's first products; typing narrows them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => search(""), [view.key]);
  const add = (p: AddableProduct) => {
    const l = addedLine(p);
    setAdded((a) => [...a.filter((x) => x.variantId !== l.variantId), l]);
    setQty((s) => ({ ...s, [l.variantId]: String(l.suggested) }));
    setOff((o) => ({ ...o, [l.variantId]: false }));
  };
  const remove = (id: string) => setAdded((a) => a.filter((x) => x.variantId !== id));

  const leadLabel = fill(view.leadTimeSource === "supplier" ? t("{n} days (supplier)") : t("{n} days (store default)"), { n: formatCount(view.leadTimeDays, locale) });
  const cycleLabel = fill(view.cycleSource === "supplier" ? t("{n} days (supplier)") : t("{n} days (store default)"), { n: formatCount(view.cycleDays, locale) });
  const windowDays = daysBetween(today, view.cycleTo) + 1;
  const sections: { id: BuilderSection; title: string; sub: string }[] = [
    {
      id: "due",
      title: view.range ? fill(t("Due {date}"), { date: formatDayRange(view.dueFrom, view.dueTo, locale) }) : t("Due now"),
      sub: view.range ? t("The orders of the week you opened.") : t("Orders due in the next 7 days, overdue ones included."),
    },
    {
      id: "cycle",
      title: t("Due before your next order"),
      sub: fill(t("Due by {date}. Order them now and send one order instead of several."), { date: formatDay(view.cycleTo, locale) }),
    },
    { id: "added", title: t("Added by you"), sub: t("Products you added to this order.") },
  ];
  const planned = lines.filter((l) => l.section !== "added").length;
  const minimumsText = [
    view.minOrderScope === "product" && view.minOrder ? fill(t("{n} per product"), { n: formatCount(view.minOrder, locale) }) : null,
    view.minOrderTotal ? fill(t("{n} per order"), { n: formatCount(view.minOrderTotal, locale) }) : null,
    view.minOrderValue ? fill(t("{money} minimum"), { money: formatAmount(view.minOrderValue, view.currency, locale) }) : null,
  ].filter(Boolean);

  return (
    <AppPage
      heading={fill(t("Order from {supplier}"), { supplier: title })}
      breadcrumb={{ label: t("Order now"), to: "/app/reorder" }}
      meta={view.kind === "vendor" ? <s-badge tone="neutral">{t("No supplier — grouped by vendor")}</s-badge> : undefined}
      intro={t("One purchase order for everything this supplier needs until your next order. Change quantities or add products, then create the draft. Nothing is sent until you email it or mark it as sent.")}
      primaryAction={
        <s-button variant="primary" disabled={flag(totals.units === 0 || busy)} loading={flag(busy)} onClick={() => setConfirm("create")}>
          {t("Create draft order")}
        </s-button>
      }
      secondaryActions={
        draft
          ? [
              <s-button key="add" disabled={flag(totals.units === 0 || busy)} onClick={() => setConfirm("add")}>
                {fill(t("Add to {number}"), { number: draft.number })}
              </s-button>,
            ]
          : undefined
      }
    >
      {draft && (
        <s-banner tone="info">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>
              {fill(t("{number} is already a draft for {supplier} ({units} units, created {date}). Add these lines to it, or create a new draft."), {
                number: draft.number,
                supplier: title,
                units: formatCount(draft.units, locale),
                date: formatDay(draft.createdAt.slice(0, 10), locale),
              })}
            </s-text>
            <s-link {...link(`/app/reorder/${draft.id}`)}>{fill(t("Open {number}"), { number: draft.number })}</s-link>
          </s-stack>
        </s-banner>
      )}
      {failed === "changed" && <s-banner tone="warning">{t("This draft changed or was sent in the meantime. Reload the page.")}</s-banner>}
      {(failed === "gone" || failed === "notFound" || failed === "notAllowed") && <s-banner tone="warning">{t("This list changed. Reload the page and try again.")}</s-banner>}
      {failed === "empty" && <s-banner tone="warning">{t("Enter a quantity for at least one product.")}</s-banner>}

      <FormCard
        title={t("This order")}
        sub={fill(t("Covers what is due until {date}. Your next order to {supplier} is due after that."), { date: formatDay(view.cycleTo, locale), supplier: title })}
      >
        <s-stack direction="block" gap="base">
          <div className="keha-kv keha-kv--flush">
            <KvRow label={t("Lead time")} value={leadLabel} />
            <KvRow
              label={t("Order every")}
              value={
                <span className="keha-inline">
                  <span>{cycleLabel}</span>
                  {view.kind === "supplier" && view.supplierId && (
                    <s-link {...link(`/app/settings/suppliers?edit=${encodeURIComponent(view.supplierId)}`)}>{t("Change")}</s-link>
                  )}
                </span>
              }
            />
          </div>
          <s-stack direction="block" gap="none">
            <s-text fontWeight="medium">{`${fill(t("Units: {n}"), { n: formatCount(totals.units, locale) })} · ${fill(t("Cost: {amount}"), { amount: costText })}`}</s-text>
            {totals.missingCost > 0 && <s-text color="subdued">{fill(t("{n} lines without a cost price"), { n: formatCount(totals.missingCost, locale) })}</s-text>}
          </s-stack>
          <MinimumBox view={view} title={title} status={status} minimumsText={minimumsText as string[]} empty={totals.units === 0} onTopUp={topUp} />
        </s-stack>
      </FormCard>

      {planned === 0 && (
        <s-section>
          <EmptyState body={fill(t("Nothing is due from {supplier} before {date}. Add products to order anyway."), { supplier: title, date: formatDay(view.cycleTo, locale) })} />
        </s-section>
      )}
      {sections.map((s) => {
        const mine = lines.filter((l) => l.section === s.id);
        if (!mine.length) return null;
        return (
          <FormCard key={s.id} flush title={s.title} sub={s.sub}>
            <s-table>
              <s-table-header-row>
                <s-table-header>
                  <HeaderLabel id={`keha-b-inc-${s.id}`} label={t("Include")} />
                </s-table-header>
                <s-table-header listSlot="primary">{t("Product")}</s-table-header>
                <s-table-header listSlot="labeled">
                  <HeaderLabel id={`keha-b-by-${s.id}`} label={t("Order by")} />
                </s-table-header>
                <s-table-header>{t("Quantity")}</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">{t("Unit cost")}</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">{t("Line total")}</s-table-header>
                <s-table-header>
                  <HeaderLabel id={`keha-b-act-${s.id}`} label={t("Actions")} />
                </s-table-header>
              </s-table-header-row>
              <s-table-body>
                {mine.map((l) => (
                  <BuilderRow
                    key={l.variantId}
                    l={l}
                    view={view}
                    today={today}
                    windowDays={windowDays}
                    value={qty[l.variantId] ?? ""}
                    included={!off[l.variantId]}
                    onInclude={(v) => setOff((o) => ({ ...o, [l.variantId]: !v }))}
                    onChange={(v) => setQty((x) => ({ ...x, [l.variantId]: v }))}
                    onRemove={l.section === "added" ? () => remove(l.variantId) : undefined}
                  />
                ))}
              </s-table-body>
            </s-table>
          </FormCard>
        );
      })}

      <FormCard title={t("Add products")} sub={fill(t("Any product from {supplier}, at any quantity."), { supplier: title })}>
        <s-stack direction="block" gap="base">
          <s-search-field
            label={t("Search")}
            labelAccessibilityVisibility="exclusive"
            placeholder={t("Product, variant or SKU")}
            value={q}
            onChange={(e) => search(val(e))}
          />
          {products.data && !products.data.ok && <s-text color="subdued">{t("This list changed. Reload the page and try again.")}</s-text>}
          {products.data?.ok && products.data.products.length === 0 && <s-text color="subdued">{t("No products from this supplier match.")}</s-text>}
          {products.data?.ok && products.data.products.length > 0 && (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">{t("Product")}</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">{t("Unit cost")}</s-table-header>
                <s-table-header>
                  <HeaderLabel id="keha-b-add" label={t("Actions")} />
                </s-table-header>
              </s-table-header-row>
              <s-table-body>
                {products.data.products.map((p) => {
                  const variant = variantName(p.variantTitle);
                  const name = [p.productTitle, variant].filter(Boolean).join(" — ");
                  const inOrder = lines.some((l) => l.variantId === p.variantId);
                  return (
                    <s-table-row key={p.variantId}>
                      <s-table-cell>
                        <s-stack direction="block" gap="none">
                          <s-text fontWeight="medium">{p.productTitle}</s-text>
                          {(variant || p.sku) && <s-text color="subdued">{[variant, p.sku].filter(Boolean).join(" · ")}</s-text>}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>{money(p.unitCostStore, null, view, locale)}</s-table-cell>
                      <s-table-cell>
                        {inOrder ? (
                          <s-badge tone="info">{t("In this order")}</s-badge>
                        ) : (
                          <s-button variant="secondary" onClick={() => add(p)} accessibilityLabel={`${t("Add to this order")}: ${name}`}>
                            {t("Add to this order")}
                          </s-button>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </FormCard>

      <ConfirmModal
        open={confirm === "create"}
        destructive={false}
        title={fill(t("Create a draft order for {supplier}?"), { supplier: title })}
        message={[
          fill(t("{n} units, {cost}. Nothing is sent to the supplier until you email the order or mark it as sent."), { n: formatCount(totals.units, locale), cost: costText }),
          totals.missingCost > 0 ? fill(t("{n} lines without a cost price are not in this total."), { n: formatCount(totals.missingCost, locale) }) : null,
        ]
          .filter(Boolean)
          .join(" ")}
        confirmLabel={t("Create draft order")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          submit("create");
        }}
      />
      {draft && (
        <ConfirmModal
          open={confirm === "add"}
          destructive={false}
          title={fill(t("Add these lines to {number}?"), { number: draft.number })}
          message={fill(t("{n} units, {cost}, go onto the draft {number}. A product already on it gets the units added to its line. Nothing is sent to the supplier."), {
            n: formatCount(totals.units, locale),
            cost: costText,
            number: draft.number,
          })}
          confirmLabel={fill(t("Add to {number}"), { number: draft.number })}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            submit("add");
          }}
        />
      )}
    </AppPage>
  );
}

/** The supplier's minimums against the order as it stands: met, or what is missing, with the one-click top-up. */
function MinimumBox({
  view,
  title,
  status,
  minimumsText,
  empty,
  onTopUp,
}: {
  view: SupplierOrderView;
  title: string;
  status: ReturnType<typeof minimumStatus>;
  minimumsText: string[];
  empty: boolean;
  onTopUp: () => void;
}) {
  const { t, locale } = useLocale();
  if (!status.any) return null;
  const missingStyleUnits = status.styles.reduce((a, s) => a + s.missing, 0);
  const short = !status.met && !empty;
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          {status.met || empty ? (
            !empty && <s-badge tone="success">{t("Minimum reached")}</s-badge>
          ) : (
            <s-badge tone="warning">{t("Below the minimum")}</s-badge>
          )}
          {minimumsText.length > 0 && <s-text color="subdued">{fill(t("{supplier}'s minimums: {list}."), { supplier: title, list: minimumsText.join(" · ") })}</s-text>}
        </s-stack>
        {short && status.units && status.units.missing > 0 && (
          <s-text>
            {fill(t("Add {n} units to reach {supplier}'s minimum of {min} units."), {
              n: formatCount(status.units.missing, locale),
              supplier: title,
              min: formatCount(status.units.min, locale),
            })}
          </s-text>
        )}
        {short && status.value && status.value.missing > 0 && (
          <s-text>
            {fill(t("Add {amount} to reach {supplier}'s minimum order value of {min}."), {
              amount: formatPrice(status.value.missing, view.storeCurrency, locale),
              supplier: title,
              min: formatPrice(status.value.min, view.storeCurrency, locale),
            })}
          </s-text>
        )}
        {short && status.styles.length > 0 && (
          <s-text>
            {fill(t("{n} styles are below the minimum of {min} units per style: add {units} units."), {
              n: formatCount(status.styles.length, locale),
              min: formatCount(view.minOrder, locale),
              units: formatCount(missingStyleUnits, locale),
            })}
          </s-text>
        )}
        {status.valueUnknown && (
          <s-text color="subdued">
            {fill(t("{supplier}'s minimum order value ({min}) isn't applied: add an exchange rate in Settings → Suppliers."), {
              supplier: title,
              min: formatPrice(view.minOrderValue, view.currency, locale),
            })}
          </s-text>
        )}
        {short && (
          <s-stack direction="inline">
            <s-button variant="secondary" onClick={onTopUp}>
              {t("Top up to the minimum")}
            </s-button>
          </s-stack>
        )}
      </s-stack>
    </s-box>
  );
}

function BuilderRow({
  l,
  view,
  today,
  windowDays,
  value,
  included,
  onInclude,
  onChange,
  onRemove,
}: {
  l: BuilderLine;
  view: SupplierOrderView;
  today: string;
  windowDays: number;
  value: string;
  included: boolean;
  onInclude: (v: boolean) => void;
  onChange: (v: string) => void;
  onRemove?: () => void;
}) {
  const { t, locale } = useLocale();
  const variant = variantName(l.variantTitle);
  const sub = [variant, l.sku].filter(Boolean).join(" · ");
  const name = [l.productTitle, variant].filter(Boolean).join(" — ");
  const n = included ? readQty(value) : 0;
  const details = [
    l.pack ? fill(t("Cases of {n}"), { n: formatCount(l.pack, locale) }) : null,
    l.moq ? fill(t("Minimum {n} per item"), { n: formatCount(l.moq, locale) }) : null,
    l.topUp > 0 ? fill(t("+{n} to reach the minimum"), { n: formatCount(l.topUp, locale) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const sameCur = view.currency === view.storeCurrency;
  const unitSupplier = !sameCur && l.unitCostStore !== null && view.exchangeRate ? l.unitCostStore / view.exchangeRate : null;
  const tag = l.variantId.replace(/\D/g, "");
  return (
    <s-table-row>
      <s-table-cell>
        <s-checkbox
          label={fill(t("Include {product}"), { product: name })}
          labelAccessibilityVisibility="exclusive"
          checked={flag(included)}
          onChange={(e) => onInclude(isChecked(e))}
        />
      </s-table-cell>
      <s-table-cell>
        <div className="keha-cell-product">
          <ProductThumb src={l.image} alt={l.productTitle} size={40} />
          <s-stack direction="block" gap="none">
            <s-text fontWeight="medium">{l.productTitle}</s-text>
            {sub && <s-text color="subdued">{sub}</s-text>}
            {l.noReorder && <s-badge tone="neutral">{t("Not reordered")}</s-badge>}
          </s-stack>
        </div>
      </s-table-cell>
      <s-table-cell>{l.section === "added" ? "—" : <DueLabel deadline={l.orderBy} overdue={l.overdue} today={today} />}</s-table-cell>
      <s-table-cell>
        <s-number-field
          label={fill(t("Quantity for {product}"), { product: name })}
          labelAccessibilityVisibility="exclusive"
          value={value}
          min={0}
          step={1}
          disabled={flag(!included)}
          details={details || undefined}
          onInput={(e) => onChange(val(e))}
        />
      </s-table-cell>
      <s-table-cell>{money(l.unitCostStore, unitSupplier, view, locale)}</s-table-cell>
      <s-table-cell>{money(l.unitCostStore === null || n === 0 ? null : l.unitCostStore * n, unitSupplier === null || n === 0 ? null : unitSupplier * n, view, locale)}</s-table-cell>
      <s-table-cell>
        <span className="keha-inline">
          {l.section !== "added" && (
            <WhyPopover id={`keha-b-why-${tag}`} title={name} whys={l.why} lastYear={l.lastYear} qty={l.suggested} today={today} days={l.why.every((w) => w.day < 7) ? 7 : windowDays} />
          )}
          {onRemove && <s-button variant="tertiary" icon="delete" accessibilityLabel={fill(t("Remove {product}"), { product: name })} onClick={onRemove} />}
        </span>
      </s-table-cell>
    </s-table-row>
  );
}
