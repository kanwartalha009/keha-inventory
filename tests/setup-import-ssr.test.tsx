/**
 * SSR: Settings → Import & export (owner 2026-10-17) — the tab, the two templates (download with
 * current values, upload), the column reference from the registry, the Free teaching lock, the
 * check before importing (changes, problems with line and column, not found, unknown columns,
 * Import only when something changes), and the action's plan gate and multipart flow.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn(async () => ({ session: { shop: "acme.myshopify.com" } })) }, unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
const ent = vi.hoisted(() => ({ csvImport: true }));
vi.mock("../app/services/entitlements.server", () => ({
  getEntitlements: vi.fn(async () => ({ features: { csvImport: ent.csvImport } })),
  upgradeResponse: vi.fn((feature: string) => new Response(JSON.stringify({ upgrade: { feature } }), { status: 403 })),
}));
const m = vi.hoisted(() => ({
  planImport: vi.fn(async (_shop: string, entity: string, text: string) => ({ entity, preview: { entity, fileError: null, rows: text.split("\n").length - 1, changed: 1, fingerprint: "abc" } })),
  applyImport: vi.fn(async () => ({ ok: true, applied: 1, variants: 1, preview: { entity: "products", created: 0 } })),
}));
vi.mock("../app/models/setup-import.server", () => ({
  importCounts: vi.fn(async () => ({ suppliers: 3, variants: 30_000 })),
  planImport: m.planImport,
  applyImport: m.applyImport,
}));

import ImportExportSettings, { action, type ImportPageData } from "../app/routes/app.settings_.import";
import { PreviewCard } from "../app/components/import-preview";
import { LocaleProvider } from "../app/lib/i18n";
import { planProductsImport, planSuppliersImport, readCsv } from "../app/lib/setup-import-shared";
import { newSupplierForm } from "../app/lib/suppliers-shared";
import { expectSettingsAnatomy } from "./helpers/settings-anatomy";

function page(data: ImportPageData) {
  const Stub = createRoutesStub([{ id: "import", path: "/app/settings/import", Component: ImportExportSettings, loader: () => data }]);
  return renderToString(<Stub initialEntries={["/app/settings/import"]} hydrationData={{ loaderData: { import: data } }} />);
}

const counts = { suppliers: 3, variants: 30_000 };
const VARIANTS = [1, 2, 3].map((n) => ({
  id: `gid://shopify/ProductVariant/${n}`,
  productId: `gid://shopify/Product/${n}`,
  sku: `SKU-${n}`,
  handle: `p-${n}`,
  productTitle: `Linen shirt ${n}`,
  variantTitle: "M",
  vendor: "Acme",
  supplierId: null,
  caseQty: n === 1 ? 6 : null,
  noReorder: false,
}));

describe("Settings → Import & export", () => {
  it("Growth: the tab, both templates with download and upload, the column reference", () => {
    const html = page({ enabled: true, counts });
    expectSettingsAnatomy(html, { cards: ["Suppliers", "Product settings", "Columns in the suppliers file", "Columns in the product settings file"] });
    expect(html).toContain("Import &amp; export"); // the tab strip
    expect(html).toContain("3 suppliers set up.");
    expect(html).toContain("30,000 variants in your store.");
    expect(html.split("<s-drop-zone").length - 1).toBe(2);
    expect(html).toContain('accept=".csv,text/csv,text/plain"');
    expect(html.split(">Download CSV</s-button>").length - 1).toBe(2);
    for (const h of ["lead_time_days", "order_every_days", "min_per_item_applies_to", "vendors", "variant_id", "sku", "handle", "case_pack", "dont_reorder"]) expect(html).toContain(`<code class="keha-nowrap">${h}</code>`);
    expect(html).toContain("Leave a column out to keep its values. An empty cell clears the value.");
    expect(html).not.toContain("Check before importing"); // nothing until a file is picked
  });

  it("Free: the teaching lock — what it does, the columns, locked buttons", () => {
    const html = page({ enabled: false, counts });
    expect(html).toContain("Set up suppliers, case packs and Don&#x27;t reorder for thousands of products at once from a spreadsheet.");
    expect(html).toContain('href="/app/plans?upgrade=csvImport"');
    expect(html).toContain("Download CSV · Growth plan");
    expect(html.split("<s-drop-zone").length - 1).toBe(2);
    expect(html).toMatch(/<s-drop-zone[^>]*disabled="true"/);
    expect(html).toContain("<code class=\"keha-nowrap\">case_pack</code>");
  });

  it("in another language", () => {
    const Stub = createRoutesStub([
      {
        id: "import",
        path: "/app/settings/import",
        Component: () => (
          <LocaleProvider defaultLocale="es">
            <ImportExportSettings />
          </LocaleProvider>
        ),
        loader: () => ({ enabled: true, counts }),
      },
    ]);
    const html = renderToString(<Stub initialEntries={["/app/settings/import"]} hydrationData={{ loaderData: { import: { enabled: true, counts } } }} />);
    expect(html).toContain("Ajustes de productos");
    expect(html).toContain("30.000 variantes en tu tienda.");
  });
});

describe("check before importing", () => {
  const render = (preview: ReturnType<typeof planProductsImport>["preview"]) =>
    renderToString(<PreviewCard preview={preview} fileName="product-settings.csv" busy={false} onImport={() => {}} onCancel={() => {}} />);

  it("changes from → to, problems with row and column, not found, unknown columns; Import names the count", () => {
    const text = "sku,case_pack,dont_reorder,notes\nSKU-1,12,no,x\nSKU-2,,yes,\nSKU-3,0,no,\nSKU-9,6,no,\n";
    const { preview } = planProductsImport(readCsv(text), VARIANTS, []);
    const html = render(preview);
    expect(html).toContain("Check before importing");
    expect(html).toContain("product-settings.csv — nothing is saved until you import.");
    expect(html).toContain("2 rows will change");
    expect(html).toContain("1 with problems, skipped");
    expect(html).toContain("1 not found");
    expect(html).toContain("Not imported (unknown columns): notes");
    expect(html).toContain("Linen shirt 1 · M");
    expect(html).toContain("Case pack: 6 → 12");
    expect(html).toContain("Don&#x27;t reorder: no → yes");
    expect(html).toContain("Rows with problems (skipped)");
    expect(html).toContain("Enter a whole number from 1 to 10000.");
    expect(html).toContain("Row 5: No product with this sku: SKU-9");
    expect(html).toContain(">Import 2 changes</s-button>");
    expect(html).not.toMatch(/<s-button variant="primary" disabled="true"/);
  });

  it("nothing to change, or a file problem: Import is disabled", () => {
    const same = planProductsImport(readCsv("sku,case_pack\nSKU-1,6\n"), VARIANTS, []).preview;
    expect(render(same)).toMatch(/<s-button variant="primary" disabled="true"[^>]*>Import 0 changes/);
    const bad = planProductsImport(readCsv("product,case_pack\nx,6\n"), VARIANTS, []).preview;
    const html = render(bad);
    expect(html).toContain("The file needs a variant_id, sku or handle column to find your products.");
    expect(html).toMatch(/<s-button variant="primary" disabled="true"/);
  });

  it("suppliers: new suppliers marked, the column's own label", () => {
    const { preview } = planSuppliersImport(readCsv("name,lead_time_days\nPorto Knit,60\n"), [{ id: "s1", form: { ...newSupplierForm(14, "EUR"), name: "Acme" } }], {
      storeCurrency: "EUR",
      defaultLeadTime: 14,
      secretsWritable: true,
    });
    const html = renderToString(<PreviewCard preview={preview} fileName="suppliers.csv" busy={false} onImport={() => {}} onCancel={() => {}} />);
    expect(html).toContain("New supplier");
    expect(html).toContain("Lead time (days): 60");
    expect(html).toContain("1 new");
    expect(html).toContain(">Import 1 change</s-button>");
  });
});

describe("action", () => {
  const post = (fields: Record<string, string | Blob>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    return new Request("https://app.test/app/settings/import", { method: "POST", body });
  };
  const file = (s: string) => new File([s], "settings.csv", { type: "text/csv" });

  it("preview checks the file (nothing written); import passes the fingerprint", async () => {
    const r = (await action({ request: post({ intent: "preview", entity: "products", file: file("sku,case_pack\nSKU-1,6\n") }), params: {}, context: {} } as never)) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: true, intent: "preview", fileName: "settings.csv" });
    expect(m.planImport).toHaveBeenCalledWith("acme.myshopify.com", "products", "sku,case_pack\nSKU-1,6\n", 22);
    expect(m.applyImport).not.toHaveBeenCalled();
    const i = (await action({ request: post({ intent: "import", entity: "products", file: file("x"), fingerprint: "abc" }), params: {}, context: {} } as never)) as Record<string, unknown>;
    expect(i).toMatchObject({ ok: true, intent: "import", applied: 1 });
    expect(m.applyImport).toHaveBeenCalledWith("acme.myshopify.com", "products", "x", 1, "abc");
  });

  it("no file: says so; Free: the upgrade response (403)", async () => {
    const r = (await action({ request: post({ intent: "preview", entity: "suppliers" }), params: {}, context: {} } as never)) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: false, error: "noFile" });
    ent.csvImport = false;
    const free = (await action({ request: post({ intent: "preview", entity: "suppliers", file: file("name\nA\n") }), params: {}, context: {} } as never)) as Response;
    expect(free.status).toBe(403);
    ent.csvImport = true;
  });
});
