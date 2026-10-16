/**
 * /supplier/confirm/:token — the supplier's page for one order (spec §5.3,
 * §14). Public: no Shopify auth, no login. Shows only that order's lines (no
 * prices when the merchant hides them — the loader doesn't even send them,
 * see ConfirmView) and a date picker; confirming sets
 * the ship date and moves the order to Confirmed. In the store's language.
 *
 * The link works only for a sent / confirmed order, until 60 days after it
 * was sent. Every other case — unknown token, expired, draft, cancelled,
 * received — shows the same "not valid" page with the same status (404), so
 * a guesser learns nothing. 20 requests per 10 minutes per address and per
 * token (429 past that).
 */
import type { CSSProperties } from "react";
import { Form, data, useActionData, useLoaderData } from "react-router";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { fill, toSupportedLocale, translate, type Locale } from "../lib/i18n";
import { formatCount, formatDay } from "../lib/dashboard-shared";
import { formatPrice, lineVariant } from "../lib/purchase-order-shared";
import { allowConfirmRequest, confirmShipDate, lookupConfirm, type ConfirmView } from "../services/supplier-confirm.server";

export type ConfirmPageData =
  | { state: "open"; locale: Locale; token: string; view: ConfirmView }
  | { state: "done"; locale: Locale; token: string; view: ConfirmView; date: string }
  | { state: "badDate"; locale: Locale; token: string; view: ConfirmView }
  | { state: "invalid"; locale: Locale }
  | { state: "limited"; locale: Locale };

export const meta: MetaFunction = () => [{ name: "robots", content: "noindex, nofollow" }, { title: "Keha Inventory Intelligence" }];

export const headers: HeadersFunction = () => ({
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
});

const browserLocale = (request: Request): Locale => toSupportedLocale(request.headers.get("Accept-Language"));

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const token = params.token ?? "";
  if (!allowConfirmRequest(request, token)) return data<ConfirmPageData>({ state: "limited", locale: browserLocale(request) }, { status: 429 });
  const found = await lookupConfirm(token);
  if (!found.ok) return data<ConfirmPageData>({ state: "invalid", locale: browserLocale(request) }, { status: 404 });
  return data<ConfirmPageData>({ state: "open", locale: found.locale, token, view: found.view });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const token = params.token ?? "";
  if (!allowConfirmRequest(request, token)) return data<ConfirmPageData>({ state: "limited", locale: browserLocale(request) }, { status: 429 });
  const form = await request.formData().catch(() => null);
  const r = await confirmShipDate(token, form?.get("shipDate"));
  const found = await lookupConfirm(token);
  if (!found.ok) return data<ConfirmPageData>({ state: "invalid", locale: browserLocale(request) }, { status: 404 });
  if (!r.ok) return data<ConfirmPageData>({ state: "badDate", locale: found.locale, token, view: found.view }, { status: 400 });
  return data<ConfirmPageData>({ state: "done", locale: found.locale, token, view: found.view, date: r.date });
};

const page: CSSProperties = {
  maxWidth: 760,
  margin: "40px auto",
  padding: "32px 24px",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  lineHeight: 1.5,
  color: "#1a1a1a",
  background: "#ffffff",
  borderRadius: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
};
const th: CSSProperties = { textAlign: "left", padding: "8px 6px", borderBottom: "1px solid #e3e3e3", fontSize: 13, color: "#616161" };
const td: CSSProperties = { padding: "8px 6px", borderBottom: "1px solid #f1f1f1", fontSize: 14, verticalAlign: "top" };
// Numbers: right-aligned, digits lined up, never split over two lines (docs/DESIGN-RULES.md).
const num: CSSProperties = { textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
// On a phone the table scrolls sideways inside the card instead of widening the page.
const tableWrap: CSSProperties = { overflowX: "auto", margin: "8px 0 12px" };
const button: CSSProperties = {
  background: "#1a1a1a",
  color: "#ffffff",
  border: 0,
  borderRadius: 8,
  padding: "10px 18px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

export default function SupplierConfirm() {
  const loaded = useLoaderData<typeof loader>() as ConfirmPageData;
  const acted = useActionData<typeof action>() as ConfirmPageData | undefined;
  const d: ConfirmPageData = acted ?? loaded;
  const tr = (key: string) => translate(d.locale, key);

  if (d.state === "invalid" || d.state === "limited") {
    return (
      <main lang={d.locale} style={page}>
        <p style={{ margin: 0, color: "#616161", fontSize: 13 }}>Keha Inventory Intelligence</p>
        {d.state === "invalid" ? (
          <>
            <h1 style={{ fontSize: 22, margin: "8px 0 12px" }}>{tr("This link isn't valid any more")}</h1>
            <p>{tr("Ask the store to send you the order again.")}</p>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 22, margin: "8px 0 12px" }}>{tr("Too many requests")}</h1>
            <p>{tr("Wait a few minutes, then open the link again.")}</p>
          </>
        )}
      </main>
    );
  }

  const { view, locale } = d;
  const shown = d.state === "done" ? d.date : view.confirmedShipDate;
  return (
    <main lang={locale} style={page}>
      <p style={{ margin: 0, color: "#616161", fontSize: 13 }}>{view.storeName}</p>
      <h1 style={{ fontSize: 22, margin: "8px 0 4px" }}>{fill(tr("Purchase order {number}"), { number: view.number })}</h1>
      {view.supplierName && <p style={{ margin: "0 0 16px", color: "#616161" }}>{fill(tr("For {name}"), { name: view.supplierName })}</p>}

      {d.state === "done" && (
        <p role="status" style={{ background: "#e3f1df", padding: "10px 14px", borderRadius: 8 }}>
          {fill(tr("Thank you. {store} can now see your ship date: {date}."), { store: view.storeName, date: formatDay(d.date, locale) })}
        </p>
      )}
      {d.state === "badDate" && (
        <p role="alert" style={{ background: "#fbeae5", padding: "10px 14px", borderRadius: 8 }}>
          {tr("Pick a date from today up to one year ahead.")}
        </p>
      )}

      <div style={tableWrap}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>{tr("Product")}</th>
              <th style={th}>{tr("SKU")}</th>
              <th style={{ ...th, ...num }}>{tr("Quantity")}</th>
              {!view.hidePrices && <th style={{ ...th, ...num }}>{tr("Unit cost")}</th>}
              {!view.hidePrices && <th style={{ ...th, ...num }}>{tr("Line total")}</th>}
            </tr>
          </thead>
          <tbody>
            {view.lines.map((l, i) => (
              <tr key={i}>
                <td style={td}>
                  {l.productTitle}
                  {lineVariant(l.variantTitle) && <span style={{ color: "#616161" }}>{` — ${lineVariant(l.variantTitle)}`}</span>}
                </td>
                <td style={td}>{l.sku || "—"}</td>
                <td style={{ ...td, ...num }}>{formatCount(l.qty, locale)}</td>
                {!view.hidePrices && <td style={{ ...td, ...num }}>{formatPrice(l.unitCost, view.currency, locale)}</td>}
                {!view.hidePrices && (
                  <td style={{ ...td, ...num }}>
                    {formatPrice(l.unitCost == null ? null : l.unitCost * l.qty, view.currency, locale)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ textAlign: "right", fontWeight: 600, margin: "0 0 24px" }}>
        {fill(tr("Total units: {n}"), { n: formatCount(view.totalUnits, locale) })}
        {!view.hidePrices && ` · ${fill(tr("Total cost: {amount}"), { amount: formatPrice(view.totalCost, view.currency, locale) })}`}
      </p>

      {view.expectedDate && !shown && (
        <p style={{ color: "#616161" }}>{fill(tr("The store expects the order around {date}."), { date: formatDay(view.expectedDate, locale) })}</p>
      )}
      {shown && d.state !== "done" && (
        <p>{fill(tr("You confirmed the ship date: {date}. You can change it below."), { date: formatDay(shown, locale) })}</p>
      )}

      <Form method="post" style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
          {tr("Ship date")}
          <input
            type="date"
            name="shipDate"
            required
            min={view.minDate}
            max={view.maxDate}
            defaultValue={shown ?? ""}
            style={{ padding: "8px 10px", fontSize: 14, border: "1px solid #8a8a8a", borderRadius: 8 }}
          />
        </label>
        <button type="submit" style={button}>
          {tr("Confirm ship date")}
        </button>
      </Form>
      <p style={{ marginTop: 24 }}>
        <a href={`/supplier/confirm/${encodeURIComponent(d.token)}/pdf`} style={{ color: "#1a56db" }}>
          {tr("Download the order as PDF")}
        </a>
      </p>
    </main>
  );
}
