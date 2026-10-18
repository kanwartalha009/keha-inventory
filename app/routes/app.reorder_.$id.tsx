/**
 * One purchase order (/app/reorder/:id) — spec §5.3, J3, Growth.
 *
 * Keha orders move Draft → Sent → Confirmed → Received (or Cancelled), each
 * step behind a confirm. Downloads: PDF and CSV (`poExport`). "Open in your
 * email" (owner decision 2026-10-18: no paid email provider) builds the order
 * as a mailto link for the merchant's own email app, in the supplier's PO
 * language, with the supplier-page link; afterwards the merchant marks a
 * draft Sent with its own confirm (never automatically). When an email
 * provider is configured, "Email supplier" (sent by the app, marks a draft
 * Sent) stays the primary button and "Open in your email" is secondary.
 * Once sent, the supplier confirmation link (`supplierConfirm`) can be
 * copied; it works for 60 days. Orders read from Shopify are read-only.
 *
 * Merchant audit 2026-10-17:
 *  - Drafts are edited in place (quantities, remove lines; contextual save bar) and can be
 *    deleted. Sent orders stay read-only: the supplier already has them (email, PDF, link),
 *    and a silent change would make Keha and the supplier disagree. A short delivery is
 *    handled by receiving what came and closing the rest as short.
 *  - "Receive items" records what arrived per line (default = what's still to come); the order
 *    stays open ("Partially received", derived) until everything is in or the rest is closed
 *    as short. Keha orders never reach Shopify (Admin API 2026-10 has no purchase-order
 *    create), so the stock is still received in Shopify as usual.
 *  - A received (also automatically received) or cancelled order can be re-opened for 30 days.
 *  - Drafts older than 14 days no longer count as ordered (banner); overdue arrivals are flagged.
 *  - Ship date and arrival (ship + transit days); prices in the supplier's currency when it has
 *    an exchange rate, with the store-currency total; the supplier's minimums are checked.
 */
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateApp } from "../services/data-scope.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import {
  deleteDraft,
  getOrder,
  hidePricesFor,
  receiveOrder,
  reopenOrder,
  shipToChoices,
  shopBasics,
  transitionOrder,
  updateDraft,
  type OrderDetail,
} from "../models/reorder.server";
import { PoDetailsFields, type ShipToChoice } from "../components/po-details";
import { defaultShipTo, type ShipToLocation } from "../lib/po-document-shared";
import { emailSupplier, supplierMailtoFor, type EmailSupplierResult, type MailtoResult } from "../services/po-email.server";
import { emailTransportConfigured } from "../services/email.server";
import { AppPage, FormCard, FormSaveBar, KvRow, sameValues } from "../components/ui";
import { LockedPage } from "../components/plan";
import { SampleOffNote, useSample } from "../components/sample";
import ConfirmModal from "../components/ConfirmModal";
import { DownloadButton } from "../components/download-button";
import { Modal, flag, isChecked, val } from "../components/wc";
import { fill, useLocale, plural } from "../lib/i18n";
import { formatCount, formatDay, todayIn } from "../lib/dashboard-shared";
import { SUPPLIER_EMAIL_COOLDOWN_MS, SUPPLIER_EMAIL_DAILY_CAP, confirmUrl } from "../lib/po-email-shared";
import { DRAFT_EXPIRY_DAYS, poCountsAsOrdered } from "../lib/supplier-shared";
import {
  REOPEN_DAYS,
  canTransition,
  confirmLinkOpen,
  convertCost,
  formatPrice,
  isPoStatus,
  lineRemaining,
  lineVariant,
  orderMinimums,
  poFileName,
  poProgress,
  poStatusBadge,
  poStatusLabel,
  poTotals,
  pricingFor,
  reopenTarget,
  shortUnits,
  wasAutoReceived,
  type PoStatus,
} from "../lib/purchase-order-shared";

/**
 * `enabled: false` = the plan has no reorder plan (Free): nothing about the
 * order is sent, and the page shows the teaching lock with "See plans" (the
 * app layout does the same for /app/reorder/*) instead of a bare 404.
 */
export type OrderPageData = OrderPageView | { enabled: false };

export type OrderPageView = {
  enabled: true;
  order: OrderDetail;
  /** The supplier page URL while the link works (sent / confirmed, not expired); else null. */
  link: string | null;
  hidePrices: boolean;
  features: { poExport: boolean; supplierConfirm: boolean };
  /** An email provider is configured: "Email supplier" (sent by the app) is offered next to "Open in your email". */
  emailProvider?: boolean;
  /** Today in the store's time zone ("YYYY-MM-DD"), for overdue arrivals. */
  today?: string;
  /** A draft older than 14 days: no longer counted as ordered. */
  stale?: boolean;
  /** The status re-opening goes back to, while it's possible (30 days); else null. */
  reopenTo?: PoStatus | null;
  /** Ship-to choices (active locations) and the one the order goes to (its own, else the default). */
  shipTo?: { choices: ShipToChoice[]; current: string | null };
};

const DAY_MS = 86_400_000;

export const loader = async ({ request, params }: LoaderFunctionArgs): Promise<OrderPageData> => {
  const { shop } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  // Locked page (app.tsx shows the plan page): send nothing, like /app/reorder.
  if (!features.reorderPlan) return { enabled: false };
  const order = await getOrder(shop, params.id ?? "");
  if (!order) throw new Response("Not found", { status: 404 });
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const now = new Date();
  const open = confirmLinkOpen({ source: order.source, status: order.status, confirmExpiresAt: order.confirmExpiresAt }, now);
  return {
    enabled: true,
    // The raw token never reaches the browser unless the link is usable.
    order: { ...order, confirmToken: "" },
    link: open && appUrl && features.supplierConfirm ? confirmUrl(appUrl, order.confirmToken) : null,
    hidePrices: hidePricesFor(order),
    features: { poExport: features.poExport, supplierConfirm: features.supplierConfirm },
    emailProvider: emailTransportConfigured(),
    today: todayIn((await shopBasics(shop)).timezone, now),
    stale: order.source === "keha" && order.status === "draft" && !poCountsAsOrdered({ status: "draft", createdAt: new Date(order.createdAt) }, now),
    reopenTo: reopenTarget(order, now),
    shipTo: shipToOf(await shipToChoices(shop), order.shipToLocationId ?? null),
  };
};

/** The active locations, and the order's ship-to: its own while it is a known location, else the default. */
function shipToOf(locations: ShipToLocation[], own: string | null): { choices: ShipToChoice[]; current: string | null } {
  const choices = locations.filter((l) => l.active || l.id === own).map((l) => ({ id: l.id, name: l.name }));
  return { choices, current: own && choices.some((c) => c.id === own) ? own : defaultShipTo(locations) };
}

export type OrderAction =
  | { ok: true; intent: "transition"; to: PoStatus }
  | { ok: true; intent: "email"; markedSent: boolean }
  | { ok: true; intent: "compose"; mailto: Extract<MailtoResult, { ok: true }>["mailto"]; draft: boolean; hasLink: boolean }
  | { ok: true; intent: "edit" }
  | { ok: true; intent: "delete" }
  | { ok: true; intent: "receive" }
  | { ok: true; intent: "reopen"; to: PoStatus }
  | { ok: false; error: string };

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop, sample } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  if (!features.reorderPlan) return upgradeResponse("reorderPlan", "The order plan is on the Growth plan.");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  const id = params.id ?? "";
  // Sample data: the whole order workflow works on the sample store's own rows (database only);
  // only what would reach a supplier — the app's email and the mailto — stays off.
  if (sample && (body.intent === "email" || body.intent === "compose")) return { ok: false, error: "sample" } satisfies OrderAction;
  switch (body.intent) {
    case "transition": {
      if (!isPoStatus(body.to)) break;
      const r = await transitionOrder(shop, id, body.to);
      return (r.ok ? { ok: true, intent: "transition", to: body.to } : { ok: false, error: r.error }) satisfies OrderAction;
    }
    case "email": {
      if (!features.poExport) return upgradeResponse("poExport", "Emailing purchase orders is on the Growth plan.");
      const r: EmailSupplierResult = await emailSupplier(shop, id);
      return (r.ok ? { ok: true, intent: "email", markedSent: r.markedSent } : { ok: false, error: r.error }) satisfies OrderAction;
    }
    case "compose": {
      if (!features.poExport) return upgradeResponse("poExport", "Emailing purchase orders is on the Growth plan.");
      const r = await supplierMailtoFor(shop, id, features.supplierConfirm);
      return (r.ok ? { ok: true, intent: "compose", mailto: r.mailto, draft: r.draft, hasLink: r.hasLink } : { ok: false, error: r.error }) satisfies OrderAction;
    }
    case "edit": {
      const r = await updateDraft(shop, id, body.quantities, body.version, { shipTo: body.shipTo, note: body.note });
      return (r.ok ? { ok: true, intent: "edit" } : { ok: false, error: r.error }) satisfies OrderAction;
    }
    case "delete": {
      const r = await deleteDraft(shop, id);
      return (r.ok ? { ok: true, intent: "delete" } : { ok: false, error: r.error }) satisfies OrderAction;
    }
    case "receive": {
      const r = await receiveOrder(shop, id, body.received, body.closeShort === true, body.version);
      return (r.ok ? { ok: true, intent: "receive" } : { ok: false, error: r.error }) satisfies OrderAction;
    }
    case "reopen": {
      const r = await reopenOrder(shop, id);
      return (r.ok ? { ok: true, intent: "reopen", to: r.to } : { ok: false, error: r.error }) satisfies OrderAction;
    }
  }
  throw new Response("Bad request", { status: 400 });
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

/** After deleting a draft the page navigates to Open orders; re-reading the deleted order would 404 first. */
export const shouldRevalidate: ShouldRevalidateFunction = ({ actionResult, defaultShouldRevalidate }) => {
  const r = actionResult as OrderAction | undefined;
  return r?.ok && r.intent === "delete" ? false : defaultShouldRevalidate;
};

type Pending =
  | { kind: "transition"; to: PoStatus }
  | { kind: "email" }
  | { kind: "delete" }
  | { kind: "close" }
  | { kind: "reopen"; to: PoStatus };

export default function OrderPage() {
  const data = useLoaderData<typeof loader>() as OrderPageData;
  if (!data.enabled) return <LockedPage feature="reorderPlan" />;
  return <OrderView data={data} />;
}

/** A whole number ≥ 0 typed in a quantity field; null when it isn't one. */
const wholeOrNull = (s: string): number | null => (/^\d{1,7}$/.test(s.trim()) ? Number(s.trim()) : null);

function OrderView({ data }: { data: OrderPageView }) {
  const { t, locale } = useLocale();
  const fetcher = useFetcher<OrderAction>();
  // "Open in your email": its own fetcher, so building the email never shows as the page's result banner.
  const composeFetcher = useFetcher<OrderAction>();
  const [composing, setComposing] = useState(false);
  const [opened, setOpened] = useState(false);
  const [copiedMessage, setCopiedMessage] = useState(false);
  const navigate = useNavigate();
  const [pending, setPending] = useState<Pending | null>(null);
  const [copied, setCopied] = useState(false);
  const { order, link, hidePrices, features } = data;
  const keha = order.source === "keha";
  const draft = keha && order.status === "draft";
  const supplierName = order.supplier?.name ?? order.supplierName ?? t("No vendor");
  const busy = fetcher.state !== "idle";
  const submitted = (fetcher.json as { intent?: string } | undefined)?.intent;
  const result = fetcher.data;
  const pricing = pricingFor(order);

  // ── Draft quantities (contextual save bar, docs/DESIGN-RULES.md §13) ──
  const savedQty = order.lines.map((l) => String(l.qty));
  const savedKey = JSON.stringify(savedQty);
  const [qty, setQty] = useState<string[]>(savedQty);
  useEffect(() => setQty(JSON.parse(savedKey) as string[]), [savedKey]);
  const parsed = qty.map(wholeOrNull);
  // Ship-to and the note (merchant audit 2026-10-18): saved with the quantities.
  const savedShipTo = data.shipTo?.current ?? "";
  const savedNote = order.note ?? "";
  const [shipTo, setShipTo] = useState(savedShipTo);
  const [note, setNote] = useState(savedNote);
  useEffect(() => setShipTo(savedShipTo), [savedShipTo]);
  useEffect(() => setNote(savedNote), [savedNote]);
  const dirty = draft && (!sameValues(qty, savedQty) || shipTo !== savedShipTo || note !== savedNote);
  const allRemoved = draft && parsed.every((n) => n === 0);
  const invalid = parsed.some((n) => n === null);
  const saving = busy && submitted === "edit";
  const liveLines = order.lines.map((l, i) => (draft ? { ...l, qty: parsed[i] ?? 0 } : l));
  const saveDraft = () => {
    if (invalid || allRemoved) return;
    fetcher.submit({ intent: "edit", quantities: parsed, version: order.updatedAt, shipTo: shipTo || null, note } as never, { method: "post", encType: "application/json" });
  };

  // ── Receiving ──
  const [receiving, setReceiving] = useState(false);
  const [rec, setRec] = useState<string[]>([]);
  const [closeShort, setCloseShort] = useState(false);
  const openReceive = () => {
    setRec(order.lines.map((l) => String(lineRemaining(l))));
    setCloseShort(false);
    setReceiving(true);
  };
  const recParsed = rec.map(wholeOrNull);
  const recInvalid = recParsed.some((n) => n === null);
  const recNothing = !closeShort && recParsed.every((n) => !n);
  const submitReceive = () => {
    if (recInvalid || recNothing) return;
    fetcher.submit({ intent: "receive", received: recParsed, closeShort, version: order.updatedAt } as never, {
      method: "post",
      encType: "application/json",
    });
    setReceiving(false);
  };

  useEffect(() => {
    if (result?.ok && result.intent === "delete") navigate("/app/reorder/orders", { replace: true });
  }, [result, navigate]);

  const can = (to: PoStatus) => keha && canTransition(order.status, to, order.source);
  const openStatus = ["draft", "sent", "confirmed"].includes(order.status);
  // Sent by the app: only with an email provider configured (owner decision 2026-10-18: none by default).
  const canEmail = !!data.emailProvider && keha && features.poExport && !!order.supplier?.hasEmail && openStatus;
  // The merchant's own email app (mailto): always, also without a saved supplier email (they type it there).
  const canCompose = keha && features.poExport && openStatus;
  const openCompose = () => {
    setOpened(false);
    setCopiedMessage(false);
    setComposing(true);
    composeFetcher.submit({ intent: "compose" } as never, { method: "post", encType: "application/json" });
  };
  const canReceive = keha && (order.status === "sent" || order.status === "confirmed");
  const reopenTo = keha ? (data.reopenTo ?? null) : null;
  const run = (p: Pending) =>
    fetcher.submit(
      (p.kind === "email"
        ? { intent: "email" }
        : p.kind === "delete"
          ? { intent: "delete" }
          : p.kind === "reopen"
            ? { intent: "reopen" }
            : p.kind === "close"
              ? // "Close order": nothing more arrives — receive nothing now and close the rest as short.
                { intent: "receive", received: order.lines.map(() => 0), closeShort: true, version: order.updatedAt }
              : { intent: "transition", to: p.to }) as never,
      { method: "post", encType: "application/json" },
    );

  // Sample data: everything but what would reach a supplier (the app's email, "Open in your email").
  const sample = useSample().on;
  const button = (p: Pending | (() => void), label: string, primary = false, critical = false, disabled = false) => (
    <s-button
      key={label}
      variant={primary ? "primary" : undefined}
      tone={critical ? "critical" : undefined}
      loading={flag(busy && primary)}
      disabled={flag(busy || disabled || (sample && (p === openCompose || (typeof p !== "function" && p.kind === "email"))))}
      onClick={() => (typeof p === "function" ? p() : setPending(p))}
    >
      {label}
    </s-button>
  );

  // Sending a draft with unsaved quantity changes would send the old ones: save first.
  const primary = draft
    ? canEmail
      ? button({ kind: "email" }, t("Email supplier"), true, false, dirty)
      : canCompose
        ? button(openCompose, t("Open in your email"), true, false, dirty)
        : can("sent")
          ? button({ kind: "transition", to: "sent" }, t("Mark as ordered"), true, false, dirty)
          : undefined
    : canReceive
      ? button(openReceive, t("Receive items"), true)
      : reopenTo
        ? button({ kind: "reopen", to: reopenTo }, t("Reopen order"), true)
        : undefined;
  const secondary = [
    keha && features.poExport ? (
      <DownloadButton key="pdf" url={`/app/reorder/${order.id}/pdf`} fileName={poFileName(order.number, "pdf")} label={t("Download PDF")} />
    ) : null,
    keha && features.poExport ? (
      <DownloadButton key="csv" url={`/app/reorder/${order.id}/csv`} fileName={poFileName(order.number, "csv")} label={t("Download CSV")} />
    ) : null,
    // Supplier module: one row per style and colour, sizes as columns (the flat CSV stays above).
    keha && features.poExport ? (
      <DownloadButton key="csv-grid" url={`/app/reorder/${order.id}/csv?layout=grid`} fileName={poFileName(`${order.number}-grid`, "csv")} label={t("Download CSV (size grid)")} />
    ) : null,
    draft && (canEmail || canCompose) && can("sent") ? button({ kind: "transition", to: "sent" }, t("Mark as ordered"), false, false, dirty) : null,
    // With a provider the app's own send stays first; "Open in your email" is the second way.
    canCompose && (canEmail || !draft) ? button(openCompose, t("Open in your email"), false, false, dirty) : null,
    !draft && canEmail ? button({ kind: "email" }, t("Email again")) : null,
    can("confirmed") ? button({ kind: "transition", to: "confirmed" }, t("Mark as confirmed")) : null,
    // Drafts were never sent: delete them. Sent orders are cancelled (and can be re-opened for 30 days).
    draft ? button({ kind: "delete" }, t("Delete draft"), false, true) : null,
    // An open order that won't be completed: close it with what arrived (Shopify's "Close").
    canReceive ? button({ kind: "close" }, t("Close order")) : null,
    !draft && can("cancelled") ? button({ kind: "transition", to: "cancelled" }, t("Cancel order"), false, true) : null,
  ].filter(Boolean);

  const confirmCopy = (p: Pending): { title: string; message: string; label: string; destructive: boolean } => {
    if (p.kind === "email")
      return {
        title: fill(t("Email {number} to {supplier}?"), { number: order.number, supplier: supplierName }),
        message:
          order.status === "draft"
            ? t("The supplier gets the order and a link to confirm the ship date. The order is marked as ordered.")
            : t("The supplier gets the order and the link to confirm the ship date again."),
        label: t("Send email"),
        destructive: false,
      };
    if (p.kind === "delete")
      return {
        title: fill(t("Delete {number}?"), { number: order.number }),
        message: t("The draft and its lines are deleted. It was never sent, so your supplier doesn't know about it. This can't be undone."),
        label: t("Delete draft"),
        destructive: true,
      };
    if (p.kind === "close") {
      const arrived = poProgress(order.lines);
      return {
        title: fill(t("Close {number}?"), { number: order.number }),
        message:
          arrived.received > 0
            ? fill(
                plural(
                  arrived.remaining,
                  t("The order closes with what arrived. The 1 unit still to come no longer counts as on order. You can reopen it within {days} days."),
                  t("The order closes with what arrived. The {n} units still to come no longer count as on order. You can reopen it within {days} days."),
                ),
                { n: formatCount(arrived.remaining, locale), days: REOPEN_DAYS },
              )
            : fill(t("Nothing has arrived yet. The order closes and its units no longer count as on order. Keha doesn't tell the supplier, so let them know yourself. You can reopen it within {days} days."), {
                days: REOPEN_DAYS,
              }),
        label: t("Close order"),
        destructive: false,
      };
    }
    if (p.kind === "reopen")
      return {
        title: fill(t("Reopen {number}?"), { number: order.number }),
        message:
          order.status === "received"
            ? fill(t("The order goes back to {status} and its units count as on order again. Received units go back to what they were before it closed."), {
                status: poStatusLabel(p.to, t),
              })
            : fill(t("The order goes back to {status} and its units count as on order again."), { status: poStatusLabel(p.to, t) }),
        label: t("Reopen order"),
        destructive: false,
      };
    switch (p.to) {
      case "sent":
        return {
          title: fill(t("Mark {number} as ordered?"), { number: order.number }),
          message: t("Do this when you have sent the order yourself, for example as a PDF. The supplier confirmation link starts working and the expected arrival is set from the lead time."),
          label: t("Mark as ordered"),
          destructive: false,
        };
      case "confirmed":
        return {
          title: fill(t("Mark {number} as confirmed?"), { number: order.number }),
          message: t("Do this when the supplier confirmed the order another way."),
          label: t("Mark as confirmed"),
          destructive: false,
        };
      default:
        return {
          title: fill(t("Cancel {number}?"), { number: order.number }),
          message: fill(t("The order closes and the supplier confirmation link stops working. Keha doesn't tell the supplier, so let them know yourself. You can reopen it within {days} days."), {
            days: REOPEN_DAYS,
          }),
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

  const badge = poStatusBadge(order, t);
  const totals = poTotals(liveLines);
  const progress = poProgress(order.lines);
  const money = (storeAmount: number | null) => formatPrice(convertCost(storeAmount, pricing.factor), pricing.currency, locale);
  const overdue = keha && (order.status === "sent" || order.status === "confirmed") && !!order.arrival && !!data.today && order.arrival < data.today;
  const auto = keha && wasAutoReceived(order);
  const short = keha ? shortUnits(order) : 0;
  const mins = draft ? orderMinimums(liveLines, order.supplier, pricing, order.storeCurrency) : null;
  const reopenUntil = (closedAt: string | null) =>
    closedAt ? formatDay(new Date(new Date(closedAt).getTime() + REOPEN_DAYS * DAY_MS).toISOString().slice(0, 10), locale) : "—";

  const delivery = (() => {
    if (order.confirmedShipDate)
      return fill(t("Ships {ship} · arrives ~{arrival}"), {
        ship: formatDay(order.confirmedShipDate, locale),
        arrival: formatDay(order.arrival, locale),
      });
    if (order.arrival) return fill(t("Arrives ~{arrival} · ship date not confirmed yet"), { arrival: formatDay(order.arrival, locale) });
    if (draft && order.supplier) return fill(t("About {days} days after you send it"), { days: order.supplier.leadTimeDays });
    return "—";
  })();

  return (
    <AppPage
      heading={order.number}
      breadcrumb={{ label: t("Purchase orders"), to: "/app/reorder/orders" }}
      meta={
        <s-stack direction="inline" gap="small-200">
          <s-badge tone={badge.tone}>{badge.label}</s-badge>
          {!keha && <s-badge tone="neutral">{t("Shopify PO")}</s-badge>}
        </s-stack>
      }
      intro={supplierName}
      primaryAction={primary}
      secondaryActions={secondary}
    >
      <SampleOffNote>{t("Sample data: every step works on the sample orders, but nothing is emailed to a supplier.")}</SampleOffNote>
      {!keha && (
        <s-banner tone="info">{t("This order comes from Shopify. Change it in Shopify; we read it again every night.")}</s-banner>
      )}
      {result?.ok && result.intent === "email" && <s-banner tone="success">{t("Email sent to the supplier.")}</s-banner>}
      {result?.ok && (result.intent === "transition" || result.intent === "reopen") && (
        <s-banner tone="success">{fill(t("Order is now {status}."), { status: poStatusLabel(result.to, t) })}</s-banner>
      )}
      {result?.ok && result.intent === "edit" && <s-banner tone="success">{t("Draft saved.")}</s-banner>}
      {result?.ok && result.intent === "receive" && (
        <s-banner tone="success">{(fetcher.json as { closeShort?: boolean } | undefined)?.closeShort ? t("Order closed.") : t("Delivery recorded.")}</s-banner>
      )}
      {result && !result.ok && <s-banner tone="critical">{orderError(result.error, t)}</s-banner>}
      {data.stale && (
        <s-banner tone="warning">
          {fill(t("Draft older than {days} days — no longer counted as ordered. Send it or delete it."), { days: DRAFT_EXPIRY_DAYS })}
        </s-banner>
      )}
      {overdue && (
        <s-banner tone="warning">
          {fill(t("Expected {date} — not received. Receive what arrived, or check with the supplier."), { date: formatDay(order.arrival, locale) })}
        </s-banner>
      )}
      {auto && order.status === "received" && (
        <s-banner tone="info">
          {fill(
            reopenTo
              ? t("Received automatically on {date}: stock for every line rose after the arrival window opened. Not right? Reopen the order until {until}.")
              : t("Received automatically on {date}: stock for every line rose after the arrival window opened."),
            { date: formatDay(order.receivedAt?.slice(0, 10) ?? null, locale), until: reopenUntil(order.receivedAt) },
          )}
        </s-banner>
      )}
      {short > 0 && (
        <s-banner tone="info">{fill(plural(short, t("Closed with 1 unit not delivered."), t("Closed with {n} units not delivered.")), { n: formatCount(short, locale) })}</s-banner>
      )}
      {keha && order.status === "cancelled" && reopenTo && (
        <s-banner tone="info">{fill(t("You can reopen this order until {until}."), { until: reopenUntil(order.cancelledAt) })}</s-banner>
      )}
      {mins?.total && (
        <s-banner tone="warning">
          {fill(t("{units} units — below the supplier's minimum order of {min} units."), {
            units: formatCount(mins.total.units, locale),
            min: formatCount(mins.total.min, locale),
          })}
        </s-banner>
      )}
      {mins?.items && (
        <s-banner tone="warning">
          {fill(
            mins.items.perProduct
              ? plural(mins.items.count, t("1 product below the supplier's minimum of {min} units per product."), t("{count} products below the supplier's minimum of {min} units per product."))
              : plural(mins.items.count, t("1 line below the supplier's minimum of {min} units per item."), t("{count} lines below the supplier's minimum of {min} units per item.")),
            { count: formatCount(mins.items.count, locale), min: formatCount(mins.items.min, locale) },
          )}
        </s-banner>
      )}
      {mins?.value && (
        <s-banner tone="warning">
          {fill(t("{amount} — below the supplier's minimum order value of {min}."), {
            amount: formatPrice(mins.value.amount, mins.value.currency, locale),
            min: formatPrice(mins.value.min, mins.value.currency, locale),
          })}
        </s-banner>
      )}
      {mins?.valueUnknown && (
        <s-banner tone="info">
          {fill(t("The supplier's minimum order value is {min}. Add an exchange rate and costs to check this order against it."), {
            min: formatPrice(mins.valueUnknown.min, mins.valueUnknown.currency, locale),
          })}
        </s-banner>
      )}

      <FormCard title={t("Order")}>
        <div className="keha-kv keha-kv--flush">
          <KvRow label={t("Supplier")} value={supplierName} />
          <KvRow label={t("Created")} value={formatDay(order.createdAt.slice(0, 10), locale)} />
          <KvRow label={t("Ordered")} value={formatDay(order.sentAt?.slice(0, 10) ?? null, locale)} />
          <KvRow label={t("Delivery")} value={delivery} />
          {order.receivedAt && <KvRow label={t("Received")} value={formatDay(order.receivedAt.slice(0, 10), locale)} />}
          {order.cancelledAt && <KvRow label={t("Canceled")} value={formatDay(order.cancelledAt.slice(0, 10), locale)} />}
          {keha && !draft && <KvRow label={t("Ship to")} value={data.shipTo?.choices.find((c) => c.id === data.shipTo?.current)?.name ?? "—"} />}
          {keha && order.coverDays ? (
            <KvRow
              label={t("Ordered for")}
              value={fill(t("{days} of stock after it arrives"), { days: fill(plural(order.coverDays, t("1 day"), t("{n} days")), { n: formatCount(order.coverDays, locale) }) })}
            />
          ) : null}
          {keha && !draft && order.note && <KvRow label={t("Note to the supplier")} value={order.note} />}
        </div>
        {draft && (
          <s-box paddingBlockStart="base">
            <PoDetailsFields choices={data.shipTo?.choices ?? []} shipTo={shipTo} onShipTo={setShipTo} note={note} onNote={setNote} />
          </s-box>
        )}
      </FormCard>

      {keha && link && (
        <FormCard
          title={t("Supplier confirmation link")}
          sub={fill(
            hidePrices
              ? t("Your supplier sees only this order, without prices, and picks the ship date. No login. Works until {date}.")
              : t("Your supplier sees only this order and picks the ship date. No login. Works until {date}."),
            { date: formatDay(order.confirmExpiresAt?.slice(0, 10) ?? null, locale) },
          )}
        >
          <s-stack direction="block" gap="base">
            <s-text-field label={t("Supplier confirmation link")} labelAccessibilityVisibility="exclusive" value={link} readOnly />
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button icon="clipboard" onClick={copyLink}>
                {t("Copy link")}
              </s-button>
              {copied && <s-text color="subdued">{t("Copied")}</s-text>}
            </s-stack>
          </s-stack>
        </FormCard>
      )}

      <FormCard
        flush
        title={t("Lines")}
        sub={
          draft
            ? t("Change quantities or remove lines, then save.")
            : keha && (order.status === "sent" || order.status === "confirmed")
              ? t("Ordered purchase orders can't be changed: your supplier already has them. If less arrives, receive what came and close the rest as short.")
              : undefined
        }
      >
        {pricing.noRate && keha && !noPrices(order) && (
          <s-box padding="base">
            <s-text color="subdued">
              {fill(t("Prices are in {currency}, your store currency. Add an exchange rate for this supplier in Settings → Suppliers to see them in {supplierCurrency}."), {
                currency: pricing.currency ?? "—",
                supplierCurrency: (order.supplier?.currency ?? "").toUpperCase() || "—",
              })}
            </s-text>
          </s-box>
        )}
        {allRemoved && (
          <s-box padding="base">
            <s-text tone="critical">{t("Keep at least one line, or delete the draft.")}</s-text>
          </s-box>
        )}
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("Product")}</s-table-header>
            <s-table-header listSlot="labeled">{t("SKU")}</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              {t("Quantity")}
            </s-table-header>
            {!draft && (
              <s-table-header listSlot="labeled" format="numeric">
                {t("Received")}
              </s-table-header>
            )}
            <s-table-header listSlot="labeled" format="numeric">
              {t("Unit cost")}
            </s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              {t("Line total")}
            </s-table-header>
            {draft && <s-table-header listSlot="labeled">{t("Remove")}</s-table-header>}
          </s-table-header-row>
          <s-table-body>
            {order.lines.map((l, i) => {
              const name = [l.productTitle, lineVariant(l.variantTitle)].filter(Boolean).join(" — ");
              const n = draft ? parsed[i] : l.qty;
              return (
                <s-table-row key={`${l.variantId}-${i}`}>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text fontWeight="medium">{l.productTitle || "—"}</s-text>
                      {lineVariant(l.variantTitle) && <s-text color="subdued">{lineVariant(l.variantTitle)}</s-text>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{l.sku || "—"}</s-table-cell>
                  <s-table-cell>
                    {draft ? (
                      <s-number-field
                        label={fill(t("Quantity for {product}"), { product: name })}
                        labelAccessibilityVisibility="exclusive"
                        value={qty[i] ?? ""}
                        min={0}
                        step={1}
                        details={n === 0 ? t("Removed when you save") : undefined}
                        error={n === null ? t("Use a whole number, 0 or more.") : undefined}
                        onInput={(e) => {
                          const v = val(e);
                          setQty((q) => q.map((x, j) => (j === i ? v : x)));
                        }}
                      />
                    ) : (
                      formatCount(l.qty, locale)
                    )}
                  </s-table-cell>
                  {!draft && <s-table-cell>{l.received === undefined ? "—" : formatCount(l.received, locale)}</s-table-cell>}
                  <s-table-cell>{money(l.unitCost)}</s-table-cell>
                  <s-table-cell>{money(l.unitCost === null || n === null ? null : l.unitCost * n)}</s-table-cell>
                  {draft && (
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        icon="delete"
                        accessibilityLabel={fill(t("Remove {product}"), { product: name })}
                        disabled={flag(n === 0)}
                        onClick={() => setQty((q) => q.map((x, j) => (j === i ? "0" : x)))}
                      />
                    </s-table-cell>
                  )}
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
        <s-box padding="base">
          <s-stack direction="block" gap="small-200">
            <s-text fontWeight="medium">
              {`${fill(t("Units: {n}"), { n: formatCount(totals.units, locale) })} · ${fill(t("Cost: {amount}"), { amount: money(totals.cost) })}`}
            </s-text>
            {!draft && keha && progress.received > 0 && progress.remaining > 0 && order.status !== "received" && (
              <s-text color="subdued">
                {fill(t("Received {received} of {ordered} · {remaining} still to come"), {
                  received: formatCount(progress.received, locale),
                  ordered: formatCount(progress.ordered, locale),
                  remaining: formatCount(progress.remaining, locale),
                })}
              </s-text>
            )}
            {pricing.converted && (
              <s-text color="subdued">
                {fill(t("{amount} in your store currency"), { amount: formatPrice(totals.cost, order.storeCurrency, locale) })}
              </s-text>
            )}
          </s-stack>
        </s-box>
      </FormCard>

      {draft && (
        <FormSaveBar
          id="keha-po-draft"
          dirty={dirty}
          saving={saving}
          onSave={saveDraft}
          onDiscard={() => {
            setQty(savedQty);
            setShipTo(savedShipTo);
            setNote(savedNote);
          }}
        />
      )}

      {canReceive && (
        <Modal
          open={receiving}
          onClose={() => setReceiving(false)}
          heading={fill(t("Receive {number}"), { number: order.number })}
          primaryAction={
            <s-button variant="primary" disabled={flag(recInvalid || recNothing)} onClick={submitReceive}>
              {t("Save")}
            </s-button>
          }
          secondaryActions={<s-button onClick={() => setReceiving(false)}>{t("Cancel")}</s-button>}
        >
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              {t("Enter what arrived. This updates the order in Keha only: Keha orders aren't in Shopify, so add the stock in Shopify as usual.")}
            </s-paragraph>
            {order.lines.map((l, i) => {
              const left = lineRemaining(l);
              const name = [l.productTitle, lineVariant(l.variantTitle)].filter(Boolean).join(" — ");
              return (
                <s-number-field
                  key={`${l.variantId}-${i}`}
                  label={name || "—"}
                  details={fill(t("{remaining} of {ordered} still to come"), {
                    remaining: formatCount(left, locale),
                    ordered: formatCount(l.qty, locale),
                  })}
                  value={rec[i] ?? ""}
                  min={0}
                  max={left}
                  step={1}
                  disabled={flag(left === 0)}
                  error={recParsed[i] === null ? t("Use a whole number, 0 or more.") : undefined}
                  onInput={(e) => {
                    const v = val(e);
                    setRec((r) => r.map((x, j) => (j === i ? v : x)));
                  }}
                />
              );
            })}
            <s-checkbox
              label={t("Close the order: the rest won't come")}
              details={t("Units not received stop counting as on order.")}
              checked={flag(closeShort)}
              onChange={(e) => setCloseShort(isChecked(e))}
            />
          </s-stack>
        </Modal>
      )}

      {canCompose && (
        <ComposeModal
          open={composing}
          number={order.number}
          supplier={supplierName}
          result={composeFetcher.data}
          loading={composeFetcher.state !== "idle"}
          opened={opened}
          copied={copiedMessage}
          canMarkSent={draft && can("sent")}
          onOpened={() => setOpened(true)}
          onCopied={setCopiedMessage}
          onClose={() => setComposing(false)}
          onMarkSent={() => {
            setComposing(false);
            setPending({ kind: "transition", to: "sent" });
          }}
        />
      )}

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

/**
 * "Open in your email": what the email says (to, subject, message), then a link that opens it in
 * the merchant's email app. A draft is never marked sent here — after opening, "Mark as ordered"
 * leads to the usual confirm. "Copy message" is for webmail without a mailto handler.
 */
export function ComposeModal(props: {
  open: boolean;
  number: string;
  supplier: string;
  result: OrderAction | undefined;
  loading: boolean;
  opened: boolean;
  copied: boolean;
  canMarkSent: boolean;
  onOpened: () => void;
  onCopied: (v: boolean) => void;
  onClose: () => void;
  onMarkSent: () => void;
}) {
  const { t, locale } = useLocale();
  const r = props.result;
  const ready = !props.loading && r?.ok && r.intent === "compose" ? r : null;
  const failed = !props.loading && r && !r.ok ? r : null;
  const m = ready?.mailto;
  const copy = async () => {
    if (!m) return;
    try {
      await navigator.clipboard.writeText(`${m.subject}\n\n${m.body}`);
      props.onCopied(true);
    } catch {
      props.onCopied(false);
    }
  };
  const openButton = (primary: boolean) =>
    m ? (
      <s-button key="open" variant={primary ? "primary" : undefined} href={m.url} target="_blank" onClick={props.onOpened}>
        {t("Open in your email")}
      </s-button>
    ) : null;
  const markSent = ready?.draft && props.canMarkSent && props.opened;
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      heading={fill(t("Email {number} to {supplier}"), { number: props.number, supplier: props.supplier })}
      primaryAction={
        markSent ? (
          <s-button variant="primary" onClick={props.onMarkSent}>
            {t("Mark as ordered")}
          </s-button>
        ) : (
          openButton(true)
        )
      }
      secondaryActions={
        <>
          {markSent && openButton(false)}
          {m && <s-button onClick={copy}>{t("Copy message")}</s-button>}
          <s-button onClick={props.onClose}>{t("Close")}</s-button>
        </>
      }
    >
      {!ready && !failed && <s-paragraph color="subdued">{t("Preparing the email…")}</s-paragraph>}
      {failed && <s-banner tone="critical">{orderError(failed.error, t)}</s-banner>}
      {ready && m && (
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            {t("This opens a new email in your own email app, from your own address, so the supplier replies straight to you.")}
          </s-paragraph>
          {markSent && (
            <s-banner tone="info">{t("Did you send it? Mark it as ordered so its units count as on order and the supplier confirmation link starts working.")}</s-banner>
          )}
          {!markSent && ready.draft && ready.hasLink && (
            <s-text color="subdued">{t("The supplier confirmation link in the email starts working when you mark the order as ordered.")}</s-text>
          )}
          {!ready.hasLink && <s-text color="subdued">{t("Download the PDF and attach it to the email.")}</s-text>}
          {m.moreLines > 0 && (
            <s-banner tone="info">
              {fill(
                ready.hasLink
                  ? plural(m.moreLines, t("1 line is left out to keep the email short. The supplier sees every line at the order link."), t("{n} lines are left out to keep the email short. The supplier sees every line at the order link."))
                  : plural(m.moreLines, t("1 line is left out to keep the email short. Attach the PDF so the supplier sees every line."), t("{n} lines are left out to keep the email short. Attach the PDF so the supplier sees every line.")),
                { n: formatCount(m.moreLines, locale) },
              )}
            </s-banner>
          )}
          {m.detailsCut && <s-text color="subdued">{t("The order details were shortened to keep the email short.")}</s-text>}
          <s-text-field label={t("To")} value={m.to} placeholder={t("Type the supplier's address in your email app")} readOnly />
          {!m.to && <s-text color="subdued">{t("No email saved for this supplier. You can save one in Settings → Suppliers.")}</s-text>}
          <s-text-field label={t("Subject")} value={m.subject} readOnly />
          <s-text-area label={t("Message")} value={m.body} rows={8} readOnly />
          {props.copied && <s-text color="subdued">{t("Copied")}</s-text>}
        </s-stack>
      )}
    </Modal>
  );
}

/** No currency hint when the order has no prices at all to show. */
const noPrices = (order: OrderDetail) => order.lines.every((l) => l.unitCost === null);

function orderError(code: string, t: (s: string) => string): string {
  switch (code) {
    case "noEmail":
      return t("This supplier has no email. Add one in Settings → Suppliers, or download the PDF and send it yourself.");
    case "noTransport":
    case "noAppUrl":
      return t("Email isn't set up for this app yet. Download the PDF and send it yourself.");
    case "failed":
      return t("The email didn't go out. Try again, or download the PDF and send it yourself.");
    case "cooldown":
      return fill(t("This order was emailed a moment ago. You can send it again after {minutes} minutes."), {
        minutes: SUPPLIER_EMAIL_COOLDOWN_MS / 60_000,
      });
    case "dailyCap":
      return fill(t("Your store sent {count} supplier emails today, the daily limit. Send this one tomorrow, or download the PDF and send it yourself."), {
        count: SUPPLIER_EMAIL_DAILY_CAP,
      });
    case "changed":
      return t("This order changed in the meantime. Reload the page.");
    case "notAllowed":
      return t("That step isn't possible for this order any more.");
    case "empty":
      return t("Keep at least one line, or delete the draft.");
    case "nothing":
      return t("Enter what arrived, or close the order.");
    case "invalid":
      return t("Use a whole number, 0 or more.");
    case "sample":
      return t("Sample data: every step works on the sample orders, but nothing is emailed to a supplier.");
    default:
      return t("This order doesn't exist any more.");
  }
}
