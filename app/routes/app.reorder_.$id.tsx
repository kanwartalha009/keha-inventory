/**
 * One purchase order (/app/reorder/:id) — spec §5.3, J3, Growth.
 *
 * Keha orders move Draft → Sent → Confirmed → Received (or Cancelled), each
 * step behind a confirm. Downloads: PDF and CSV (`poExport`). "Email
 * supplier" sends the order with the supplier-page link and marks a draft
 * Sent. Once sent, the supplier confirmation link (`supplierConfirm`) can be
 * copied; it works for 60 days. Orders read from Shopify are read-only.
 */
import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { getOrder, hidePricesFor, transitionOrder, type OrderDetail } from "../models/reorder.server";
import { emailSupplier, type EmailSupplierResult } from "../services/po-email.server";
import { AppPage, KvRow } from "../components/ui";
import ConfirmModal from "../components/ConfirmModal";
import { DownloadButton } from "../components/download-button";
import { flag } from "../components/wc";
import { fill, useLocale } from "../lib/i18n";
import { formatCount, formatDay } from "../lib/dashboard-shared";
import { confirmUrl } from "../lib/po-email-shared";
import {
  canTransition,
  confirmLinkOpen,
  formatPrice,
  isPoStatus,
  lineVariant,
  poFileName,
  poStatusLabel,
  poStatusTone,
  poTotals,
  type PoStatus,
} from "../lib/purchase-order-shared";

export type OrderPageData = {
  order: OrderDetail;
  /** The supplier page URL while the link works (sent / confirmed, not expired); else null. */
  link: string | null;
  hidePrices: boolean;
  features: { poExport: boolean; supplierConfirm: boolean };
};

export const loader = async ({ request, params }: LoaderFunctionArgs): Promise<OrderPageData> => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.reorderPlan) throw new Response("Not found", { status: 404 });
  const order = await getOrder(session.shop, params.id ?? "");
  if (!order) throw new Response("Not found", { status: 404 });
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const open = confirmLinkOpen(
    { source: order.source, status: order.status, confirmExpiresAt: order.confirmExpiresAt },
    new Date(),
  );
  return {
    // The raw token never reaches the browser unless the link is usable.
    order: { ...order, confirmToken: "" },
    link: open && appUrl && features.supplierConfirm ? confirmUrl(appUrl, order.confirmToken) : null,
    hidePrices: hidePricesFor(order),
    features: { poExport: features.poExport, supplierConfirm: features.supplierConfirm },
  };
};

export type OrderAction =
  | { ok: true; intent: "transition"; to: PoStatus }
  | { ok: true; intent: "email"; markedSent: boolean }
  | { ok: false; error: string };

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.reorderPlan) return upgradeResponse("reorderPlan", "The reorder plan is on the Growth plan.");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  const id = params.id ?? "";
  if (body.intent === "transition" && isPoStatus(body.to)) {
    const r = await transitionOrder(session.shop, id, body.to);
    return (r.ok ? { ok: true, intent: "transition", to: body.to } : { ok: false, error: r.error }) satisfies OrderAction;
  }
  if (body.intent === "email") {
    if (!features.poExport) return upgradeResponse("poExport", "Emailing purchase orders is on the Growth plan.");
    const r: EmailSupplierResult = await emailSupplier(session.shop, id);
    return (r.ok ? { ok: true, intent: "email", markedSent: r.markedSent } : { ok: false, error: r.error }) satisfies OrderAction;
  }
  throw new Response("Bad request", { status: 400 });
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

type Pending = { kind: "transition"; to: PoStatus } | { kind: "email" };

export default function OrderPage() {
  const { t, locale } = useLocale();
  const data = useLoaderData<typeof loader>() as OrderPageData;
  const fetcher = useFetcher<OrderAction>();
  const [pending, setPending] = useState<Pending | null>(null);
  const [copied, setCopied] = useState(false);
  const { order, link, hidePrices, features } = data;
  const keha = order.source === "keha";
  const totals = poTotals(order.lines);
  const supplierName = order.supplier?.name ?? order.supplierName ?? t("No vendor");
  const busy = fetcher.state !== "idle";
  const can = (to: PoStatus) => keha && canTransition(order.status, to, order.source);
  const canEmail = keha && features.poExport && !!order.supplier?.hasEmail && ["draft", "sent", "confirmed"].includes(order.status);
  const run = (p: Pending) =>
    fetcher.submit((p.kind === "email" ? { intent: "email" } : { intent: "transition", to: p.to }) as never, {
      method: "post",
      encType: "application/json",
    });
  const result = fetcher.data;

  const button = (p: Pending, label: string, primary = false, critical = false) => (
    <s-button
      key={label}
      variant={primary ? "primary" : undefined}
      tone={critical ? "critical" : undefined}
      loading={flag(busy && primary)}
      disabled={flag(busy)}
      onClick={() => setPending(p)}
    >
      {label}
    </s-button>
  );

  const primary =
    order.status === "draft"
      ? canEmail
        ? button({ kind: "email" }, t("Email supplier"), true)
        : can("sent")
          ? button({ kind: "transition", to: "sent" }, t("Mark as sent"), true)
          : undefined
      : can("received")
        ? button({ kind: "transition", to: "received" }, t("Mark as received"), true)
        : undefined;
  const secondary = [
    keha && features.poExport ? (
      <DownloadButton key="pdf" url={`/app/reorder/${order.id}/pdf`} fileName={poFileName(order.number, "pdf")} label={t("Download PDF")} />
    ) : null,
    keha && features.poExport ? (
      <DownloadButton key="csv" url={`/app/reorder/${order.id}/csv`} fileName={poFileName(order.number, "csv")} label={t("Download CSV")} />
    ) : null,
    order.status === "draft" && canEmail && can("sent") ? button({ kind: "transition", to: "sent" }, t("Mark as sent")) : null,
    order.status !== "draft" && canEmail ? button({ kind: "email" }, t("Email again")) : null,
    can("confirmed") ? button({ kind: "transition", to: "confirmed" }, t("Mark as confirmed")) : null,
    can("cancelled") ? button({ kind: "transition", to: "cancelled" }, t("Cancel order"), false, true) : null,
  ].filter(Boolean);

  const confirmCopy = (p: Pending): { title: string; message: string; label: string; destructive: boolean } => {
    if (p.kind === "email")
      return {
        title: fill(t("Email {number} to {supplier}?"), { number: order.number, supplier: supplierName }),
        message:
          order.status === "draft"
            ? t("The supplier gets the order and a link to confirm the ship date. The order is marked as sent.")
            : t("The supplier gets the order and the link to confirm the ship date again."),
        label: t("Send email"),
        destructive: false,
      };
    switch (p.to) {
      case "sent":
        return {
          title: fill(t("Mark {number} as sent?"), { number: order.number }),
          message: t("Do this when you have sent the order yourself, for example as a PDF. The supplier link starts working and the expected arrival is set from the lead time."),
          label: t("Mark as sent"),
          destructive: false,
        };
      case "confirmed":
        return {
          title: fill(t("Mark {number} as confirmed?"), { number: order.number }),
          message: t("Do this when the supplier confirmed the order another way."),
          label: t("Mark as confirmed"),
          destructive: false,
        };
      case "received":
        return {
          title: fill(t("Mark {number} as received?"), { number: order.number }),
          message: t("The order closes and its units no longer count as on order. Receive the stock in Shopify as usual."),
          label: t("Mark as received"),
          destructive: false,
        };
      default:
        return {
          title: fill(t("Cancel {number}?"), { number: order.number }),
          message: t("The order closes and the supplier link stops working. This can't be undone."),
          label: t("Cancel order"),
          destructive: true,
        };
    }
  };
  const copy = pending ? confirmCopy(pending) : null;

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <AppPage
      heading={order.number}
      breadcrumb={{ label: t("Reorder"), to: "/app/reorder" }}
      meta={
        <s-stack direction="inline" gap="small-200">
          <s-badge tone={poStatusTone(order.status)}>{poStatusLabel(order.status, t)}</s-badge>
          {!keha && <s-badge tone="neutral">{t("From Shopify")}</s-badge>}
        </s-stack>
      }
      intro={supplierName}
      primaryAction={primary}
      secondaryActions={secondary}
    >
      {!keha && (
        <s-banner tone="info">{t("This order comes from Shopify. Change it in Shopify; we read it again every night.")}</s-banner>
      )}
      {result?.ok && result.intent === "email" && <s-banner tone="success">{t("Email sent to the supplier.")}</s-banner>}
      {result?.ok && result.intent === "transition" && (
        <s-banner tone="success">{fill(t("Order is now {status}."), { status: poStatusLabel(result.to, t) })}</s-banner>
      )}
      {result && !result.ok && <s-banner tone="critical">{orderError(result.error, t)}</s-banner>}

      <s-section heading={t("Order")}>
        <div className="keha-kv keha-kv--flush">
          <KvRow label={t("Supplier")} value={supplierName} />
          <KvRow label={t("Created")} value={formatDay(order.createdAt.slice(0, 10), locale)} />
          <KvRow label={t("Sent")} value={formatDay(order.sentAt?.slice(0, 10) ?? null, locale)} />
          <KvRow label={t("Expected arrival")} value={formatDay(order.expectedDate, locale)} />
          <KvRow label={t("Ship date confirmed by the supplier")} value={formatDay(order.confirmedShipDate, locale)} />
          {order.receivedAt && <KvRow label={t("Received")} value={formatDay(order.receivedAt.slice(0, 10), locale)} />}
          {order.cancelledAt && <KvRow label={t("Cancelled")} value={formatDay(order.cancelledAt.slice(0, 10), locale)} />}
        </div>
      </s-section>

      {keha && link && (
        <s-section heading={t("Supplier link")}>
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              {fill(
                hidePrices
                  ? t("Your supplier sees only this order, without prices, and picks the ship date. No login. Works until {date}.")
                  : t("Your supplier sees only this order and picks the ship date. No login. Works until {date}."),
                { date: formatDay(order.confirmExpiresAt?.slice(0, 10) ?? null, locale) },
              )}
            </s-paragraph>
            <s-text-field label={t("Supplier link")} labelAccessibilityVisibility="exclusive" value={link} readOnly />
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button icon="clipboard" onClick={copyLink}>
                {t("Copy link")}
              </s-button>
              {copied && <s-text color="subdued">{t("Copied")}</s-text>}
            </s-stack>
          </s-stack>
        </s-section>
      )}

      <s-section heading={t("Lines")} padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("Product")}</s-table-header>
            <s-table-header listSlot="labeled">{t("SKU")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Quantity")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Unit cost")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Line total")}</s-table-header>
            <s-table-header listSlot="labeled">{t("Received")}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {order.lines.map((l) => (
              <s-table-row key={l.variantId}>
                <s-table-cell>
                  <s-stack direction="block" gap="none">
                    <s-text fontWeight="medium">{l.productTitle || "—"}</s-text>
                    {lineVariant(l.variantTitle) && <s-text color="subdued">{lineVariant(l.variantTitle)}</s-text>}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{l.sku || "—"}</s-table-cell>
                <s-table-cell>{formatCount(l.qty, locale)}</s-table-cell>
                <s-table-cell>{formatPrice(l.unitCost, order.currency, locale)}</s-table-cell>
                <s-table-cell>{formatPrice(l.unitCost === null ? null : l.unitCost * l.qty, order.currency, locale)}</s-table-cell>
                <s-table-cell>{l.received === undefined ? "—" : formatCount(l.received, locale)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-box padding="base">
          <s-text fontWeight="medium">
            {`${fill(t("Units: {n}"), { n: formatCount(totals.units, locale) })} · ${fill(t("Cost: {amount}"), {
              amount: formatPrice(totals.cost, order.currency, locale),
            })}`}
          </s-text>
        </s-box>
      </s-section>

      <ConfirmModal
        open={!!pending}
        destructive={copy?.destructive ?? false}
        title={copy?.title ?? ""}
        message={copy?.message ?? ""}
        confirmLabel={copy?.label ?? ""}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) run(pending);
          setPending(null);
        }}
      />
    </AppPage>
  );
}

function orderError(code: string, t: (s: string) => string): string {
  switch (code) {
    case "noEmail":
      return t("This supplier has no email. Add one in Settings → Suppliers, or download the PDF and send it yourself.");
    case "noTransport":
    case "noAppUrl":
      return t("Email isn't set up for this app yet. Download the PDF and send it yourself.");
    case "failed":
      return t("The email didn't go out. Try again, or download the PDF and send it yourself.");
    case "changed":
      return t("This order changed in the meantime. Reload the page.");
    case "notAllowed":
      return t("That step isn't possible for this order any more.");
    default:
      return t("This order doesn't exist any more.");
  }
}
