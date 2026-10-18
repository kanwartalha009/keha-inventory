/**
 * Without an email provider the merchant sends the order from their own email app, and the message
 * says the supplier can download the PDF or CSV at the order link (owner decision 2026-10-18):
 * the supplier page's CSV download (public, rate-limited, token-scoped, PO language, no prices
 * when hidden), and the "Open in your email" modal on the order page.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() }, unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/services/entitlements.server", () => ({ getEntitlements: vi.fn(), upgradeResponse: vi.fn() }));
const { allow, lookup, doc } = vi.hoisted(() => ({ allow: vi.fn(() => true), lookup: vi.fn(), doc: vi.fn() }));
vi.mock("../app/services/supplier-confirm.server", () => ({ allowConfirmRequest: allow, lookupConfirm: lookup }));
vi.mock("../app/services/po-document.server", async (orig) => ({ ...(await orig<typeof import("../app/services/po-document.server")>()), documentFor: doc }));

import { loader } from "../app/routes/supplier.confirm.$token_.csv";
import SupplierConfirm, { type ConfirmPageData } from "../app/routes/supplier.confirm.$token";
import { ComposeModal, type OrderAction } from "../app/routes/app.reorder_.$id";
import { translate } from "../app/lib/i18n";
import type { PoPdfInput } from "../app/services/po-pdf.server";

const TOKEN = "t".repeat(43);
const pdf = (over: Partial<PoPdfInput> = {}): PoPdfInput => ({
  locale: "en",
  storeName: "Acme Store",
  number: "PO-0007",
  supplierName: "Acme Textiles",
  orderDate: "2026-10-16",
  expectedDate: "2026-11-15",
  confirmedShipDate: null,
  currency: "EUR",
  hidePrices: false,
  lines: [{ productTitle: "Shirt", variantTitle: "M", sku: "S-M", qty: 6, unitCost: 2 }],
  confirmUrl: null,
  ...over,
});
const call = (url = `https://inventory.test/supplier/confirm/${TOKEN}/csv`) =>
  loader({ request: new Request(url), params: { token: TOKEN }, context: {} } as never) as Promise<Response>;

describe("supplier page · CSV download", () => {
  it("the order as CSV, as an attachment, never cached or indexed", async () => {
    lookup.mockResolvedValue({ ok: true, shop: "acme.myshopify.com", order: { id: "po1" } });
    doc.mockResolvedValue(pdf());
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="PO-0007.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const csv = await res.text();
    expect(csv).toContain("S-M");
    expect(csv).toContain("Unit cost");
    expect(csv).toMatch(/,6,2(\.0+)?(,|\r?\n|$)/);
  });

  it("in the supplier's PO language, without prices when hidden; ?layout=grid is the size grid", async () => {
    lookup.mockResolvedValue({ ok: true, shop: "acme.myshopify.com", order: { id: "po1" } });
    doc.mockResolvedValue(pdf({ locale: "de", hidePrices: true, lines: [{ productTitle: "Shirt", variantTitle: "M", sku: "S-M", qty: 6 }] }));
    const csv = await (await call()).text();
    expect(csv).toContain(translate("de", "Quantity"));
    expect(csv).not.toContain(translate("de", "Unit cost"));
    const grid = await call(`https://inventory.test/supplier/confirm/${TOKEN}/csv?layout=grid`);
    expect(grid.headers.get("Content-Disposition")).toBe('attachment; filename="PO-0007-grid.csv"');
  });

  it("an unknown, expired or closed link is the same 404; over the rate limit 429, without a lookup", async () => {
    lookup.mockResolvedValue({ ok: false });
    expect((await call()).status).toBe(404);
    allow.mockReturnValueOnce(false);
    lookup.mockClear();
    expect((await call()).status).toBe(429);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("the supplier page links both downloads", () => {
    const view = {
      number: "PO-0007",
      storeName: "Acme Store",
      supplierName: "Acme Textiles",
      lines: [{ productTitle: "Shirt", variantTitle: "M", sku: "S-M", qty: 6 }],
      totalUnits: 6,
      hidePrices: true,
      confirmedShipDate: null,
      expectedDate: null,
      minDate: "2026-10-17",
      maxDate: "2027-10-18",
    };
    const data: ConfirmPageData = { state: "open", locale: "en", token: TOKEN, view };
    const Stub = createRoutesStub([{ id: "s", path: "/supplier/confirm/:token", Component: SupplierConfirm, loader: () => data }]);
    const html = renderToString(<Stub initialEntries={[`/supplier/confirm/${TOKEN}`]} hydrationData={{ loaderData: { s: data } }} />);
    expect(html).toContain(`/supplier/confirm/${TOKEN}/pdf`);
    expect(html).toContain(`/supplier/confirm/${TOKEN}/csv`);
    expect(html).toContain("Download the order as CSV");
  });
});

describe("order page · Open in your email modal", () => {
  const MAILTO = { to: "orders@acme.test", subject: "Purchase order PO-0007 from Acme Store", body: "Hello Acme Textiles,\n…", url: "mailto:orders@acme.test?subject=x&body=y", shownLines: 30, moreLines: 4, detailsCut: false };
  const result = (over: Partial<Extract<OrderAction, { intent: "compose" }>> = {}): OrderAction => ({
    ok: true,
    intent: "compose",
    draft: true,
    hasLink: true,
    mailto: MAILTO,
    ...over,
  });
  const modal = (r: OrderAction | undefined, opened = false, loading = false) =>
    renderToString(
      <ComposeModal
        open
        number="PO-0007"
        supplier="Acme Textiles"
        result={r}
        loading={loading}
        opened={opened}
        copied={false}
        canMarkSent
        onOpened={() => {}}
        onCopied={() => {}}
        onClose={() => {}}
        onMarkSent={() => {}}
      />,
    );

  it("shows to, subject and message, the mailto link, the reply hint, and how many lines are left out", () => {
    const h = modal(result());
    expect(h).toContain("Email PO-0007 to Acme Textiles");
    expect(h).toContain('value="orders@acme.test"');
    expect(h).toContain("Purchase order PO-0007 from Acme Store");
    expect(h).toContain('href="mailto:orders@acme.test?subject=x&amp;body=y"');
    expect(h).toContain('target="_blank"');
    expect(h).toContain("from your own address, so the supplier replies straight to you");
    expect(h).toContain("4 lines are left out to keep the email short. The supplier sees every line at the order link.");
    expect(h).toContain("The supplier link in the email starts working when you mark the order as sent.");
    expect(h).toContain("Copy message");
    // Never marks sent by itself: Mark as sent only after the email was opened.
    expect(h).not.toContain("Mark as sent");
  });

  it("after opening a draft's email: Mark as sent (it leads to the usual confirm)", () => {
    const h = modal(result(), true);
    expect(h).toContain("Mark as sent");
    expect(h).toContain("Did you send it?");
  });

  it("a sent order: no Mark as sent; no saved email: says where to save one; while building: a wait line", () => {
    expect(modal(result({ draft: false }), true)).not.toContain("Mark as sent");
    const noTo = modal(result({ mailto: { ...MAILTO, to: "" } }));
    expect(noTo).toContain("No email saved for this supplier.");
    expect(modal(undefined, false, true)).toContain("Preparing the email…");
    expect(modal({ ok: false, error: "notAllowed" })).toContain("That step isn&#x27;t possible for this order any more.");
  });
});
