/**
 * Transfers: warehouse → stores, on the Reorder screen (spec §4 J7; Pro `transfers`).
 *
 * One card per origin → destination with editable quantities and "Create transfer in
 * Shopify" → a confirm dialog → POST /app/transfers. The transfer is created as a draft in
 * Shopify; after creation the card links to it in the Shopify admin. Below Pro the section
 * stays visible with what it does and the plans link (plan locks teach, they don't hide).
 */
import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { fill, useLocale } from "../lib/i18n";
import { formatCount, formatDay } from "../lib/dashboard-shared";
import { variantName } from "../lib/products-shared";
import { quantitiesKey } from "../lib/quantities-key-shared";
import { readQty } from "../lib/reorder-shared";
import { transferAdminHref, type RecentTransfer, type TransferGroup, type TransferLine } from "../lib/transfers-shared";
import type { TransfersResult } from "../routes/app.transfers";
import ConfirmModal from "./ConfirmModal";
import { SampleOffNote, useSample } from "./sample";
import { featureCopy, planTag } from "./plan";
import { EmptyState, FormCard, HeaderLabel, ProductThumb } from "./ui";
import { flag, useLinkProps, val } from "./wc";

export type TransfersView = {
  enabled: boolean;
  groups: TransferGroup[];
  recent: RecentTransfer[];
  hasWarehouse: boolean;
  hasStore: boolean;
};

export const LOCKED_TRANSFERS: TransfersView = { enabled: false, groups: [], recent: [], hasWarehouse: false, hasStore: false };

export function TransfersSection({ view }: { view: TransfersView }) {
  const { t } = useLocale();
  const link = useLinkProps();
  const heading = t("Transfers: warehouse → stores");
  if (!view.enabled) {
    const copy = featureCopy("transfers", t);
    return (
      <FormCard
        title={heading}
        sub={copy.body}
        action={
          <span className="keha-inline">
            <s-badge icon="lock" tone="info">
              {planTag("transfers", t)}
            </s-badge>
            <s-button {...link("/app/plans?upgrade=transfers")}>{t("See plans")}</s-button>
          </span>
        }
      />
    );
  }
  if (!view.hasWarehouse || !view.hasStore) {
    return (
      <FormCard
        title={heading}
        sub={t("Mark at least one warehouse and one store in Settings → Locations to get a transfer plan.")}
        action={<s-button {...link("/app/settings/locations")}>{t("Set up warehouses and stores")}</s-button>}
      />
    );
  }
  return (
    <>
      {view.groups.length === 0 ? (
        <FormCard title={heading}>
          <EmptyState
            heading={t("Nothing to move right now")}
            body={t("Stores that are running low get stock from a warehouse that has more than it needs itself.")}
          />
        </FormCard>
      ) : (
        view.groups.map((g) => <TransferCard key={g.key} group={g} heading={heading} />)
      )}
      {view.recent.length > 0 && <RecentTransfers rows={view.recent} />}
    </>
  );
}

function TransferCard({ group, heading }: { group: TransferGroup; heading: string }) {
  const { t, locale } = useLocale();
  const fetcher = useFetcher<TransfersResult>();
  // Reset typed quantities only when the proposal changes, not on every loader revalidation.
  const resetKey = quantitiesKey(group.key, group.lines.map((l) => [l.variantId, l.qty] as const));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => Object.fromEntries(group.lines.map((l) => [l.variantId, String(l.qty)])), [resetKey]);
  const [qty, setQty] = useState<Record<string, string>>(initial);
  const [confirm, setConfirm] = useState(false);
  const sample = useSample().on;
  useEffect(() => setQty(initial), [initial]);
  const q = (id: string) => readQty(qty[id]);
  const units = group.lines.reduce((a, l) => a + q(l.variantId), 0);
  const route = `${group.originName} → ${group.destinationName}`;
  const result = fetcher.data;

  return (
    <FormCard title={`${heading} · ${route}`}>
      <s-stack direction="block" gap="base">
        {result?.ok && (
          <s-banner tone="success">
            <s-stack direction="block" gap="small-200">
              <s-text>
                {result.existing
                  ? t("This transfer was already created today. Nothing new was created.")
                  : result.name
                    ? fill(t("Draft transfer {name} created in Shopify. Mark it as ready to ship there when the stock leaves."), { name: result.name })
                    : t("Draft transfer created in Shopify. Mark it as ready to ship there when the stock leaves.")}
              </s-text>
              <s-link href={result.href} target="_top">
                {t("Open the transfer in Shopify")}
              </s-link>
            </s-stack>
          </s-banner>
        )}
        {result && !result.ok && result.error === "shopify" && (
          <s-banner tone="critical" heading={t("Shopify didn't create the transfer")}>
            {result.userErrors.map((m, i) => (
              <s-paragraph key={i}>{m}</s-paragraph>
            ))}
          </s-banner>
        )}
        {result && !result.ok && result.error === "gone" && (
          <s-banner tone="warning">{t("This list changed. Reload the page and try again.")}</s-banner>
        )}
        {result && !result.ok && result.error === "over_spare" && (
          <s-banner tone="warning">{t("More than the warehouse can spare.")}</s-banner>
        )}
        {result && !result.ok && result.error === "empty" && (
          <s-banner tone="warning">{t("Enter a quantity for at least one product.")}</s-banner>
        )}
        {result && !result.ok && (result.error === "failed" || result.error === "bad_request") && (
          <s-banner tone="critical">{t("The transfer couldn't be created. Try again.")}</s-banner>
        )}
        {result && !result.ok && result.error === "upgrade" && (
          <s-banner tone="info">{featureCopy("transfers", t).body}</s-banner>
        )}
        <SampleOffNote>{t("Transfers are off in sample data — nothing is created in your store.")}</SampleOffNote>
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("Product")}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">{fill(t("Stock at {location}"), { location: group.destinationName })}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              <HeaderLabel id={`keha-tleft-${group.key}`} label={t("Days left")} hint={t("Days of stock left")} />
            </s-table-header>
            <s-table-header listSlot="labeled" format="numeric">{fill(t("Spare at {location}"), { location: group.originName })}</s-table-header>
            <s-table-header>{t("Quantity")}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {group.lines.map((l) => (
              <LineRow key={l.variantId} l={l} value={qty[l.variantId] ?? ""} onChange={(v) => setQty((s) => ({ ...s, [l.variantId]: v }))} locale={locale} />
            ))}
          </s-table-body>
        </s-table>
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-text fontWeight="medium">{fill(t("Units: {n}"), { n: formatCount(units, locale) })}</s-text>
          <s-button variant="primary" disabled={flag(units === 0 || sample)} loading={flag(fetcher.state !== "idle")} onClick={() => setConfirm(true)}>
            {t("Create transfer in Shopify")}
          </s-button>
        </s-stack>
      </s-stack>
      <ConfirmModal
        open={confirm}
        destructive={false}
        title={fill(t("Create a transfer from {origin} to {destination}?"), { origin: group.originName, destination: group.destinationName })}
        message={fill(t("{n} units. Keha creates it as a draft in Shopify: nothing moves until you mark it as ready to ship there."), {
          n: formatCount(units, locale),
        })}
        confirmLabel={t("Create transfer")}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          const quantities = Object.fromEntries(group.lines.map((l) => [l.variantId, q(l.variantId)]));
          fetcher.submit({ originId: group.originId, destinationId: group.destinationId, quantities } as never, {
            method: "post",
            action: "/app/transfers",
            encType: "application/json",
          });
        }}
      />
    </FormCard>
  );
}

function LineRow({ l, value, onChange, locale }: { l: TransferLine; value: string; onChange: (v: string) => void; locale: string }) {
  const { t } = useLocale();
  const variant = variantName(l.variantTitle);
  const sub = [variant, l.sku].filter(Boolean).join(" · ");
  const days = l.storeDaysLeft === null ? "—" : formatCount(Math.max(0, Math.floor(l.storeDaysLeft)), locale);
  const over = readQty(value) > l.originSpare;
  return (
    <s-table-row>
      <s-table-cell>
        <div className="keha-cell-product">
          <ProductThumb src={l.image} alt={l.productTitle} size={40} />
          <s-stack direction="block" gap="none">
            <s-text fontWeight="medium">{l.productTitle}</s-text>
            {sub && <s-text color="subdued">{sub}</s-text>}
          </s-stack>
        </div>
      </s-table-cell>
      <s-table-cell>{formatCount(l.storeOnHand, locale)}</s-table-cell>
      <s-table-cell>{days}</s-table-cell>
      <s-table-cell>{formatCount(l.originSpare, locale)}</s-table-cell>
      <s-table-cell>
        <s-number-field
          label={fill(t("Quantity for {product}"), { product: [l.productTitle, variant].filter(Boolean).join(" — ") })}
          labelAccessibilityVisibility="exclusive"
          value={value}
          min={0}
          step={1}
          details={fill(t("The store needs {n}."), { n: formatCount(l.need, locale) })}
          error={over ? t("More than the warehouse can spare.") : undefined}
          onInput={(e) => onChange(val(e))}
        />
      </s-table-cell>
    </s-table-row>
  );
}

function RecentTransfers({ rows }: { rows: RecentTransfer[] }) {
  const { t, locale } = useLocale();
  return (
    <FormCard flush title={t("Transfers created with Keha")}>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">{t("Transfer")}</s-table-header>
          <s-table-header listSlot="labeled" format="numeric">{t("Units")}</s-table-header>
          <s-table-header listSlot="labeled">{t("Created")}</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {rows.map((r) => (
            <s-table-row key={r.id}>
              <s-table-cell>
                <s-link href={transferAdminHref(r.shopifyTransferId)} target="_top">
                  {`${r.originName} → ${r.destinationName}`}
                </s-link>
              </s-table-cell>
              <s-table-cell>{formatCount(r.units, locale)}</s-table-cell>
              <s-table-cell>{formatDay(r.createdAt.slice(0, 10), locale)}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </FormCard>
  );
}
