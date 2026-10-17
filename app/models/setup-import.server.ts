/**
 * Settings → Import & export (lib/setup-import-shared): reads what an import is checked against,
 * streams the exports, and writes a confirmed import. Our database only — the Shopify store is
 * never changed (Variant.supplierId / caseQty / noReorder / supplierCode and Supplier rows, as Settings →
 * Suppliers and the product page write them).
 *
 * Large stores: variants are read in pages of READ_PAGE (cursor on id), the products export is
 * streamed page by page, and a confirmed products import is written as grouped updateMany
 * statements (one per field value, at most WRITE_CHUNK ids each) in one transaction — so 30,000
 * changed variants are tens of statements, all or nothing. Suppliers (a few hundred at most) are
 * written one by one through saveSupplier (emails encrypted) in one transaction.
 */
import prisma from "../db.server";
import { forgetOrderPlan } from "./plan-cache.server";
import { listSupplierForms, supplierWriteData } from "./suppliers.server";
import { readSettings } from "../lib/settings-shared";
import { secretsWritable } from "../lib/crypto.server";
import {
  CSV_BOM,
  fileProblem,
  planProductsImport,
  planSuppliersImport,
  productCtx,
  productsCsvHeader,
  productsCsvRow,
  readCsv,
  suppliersCsv,
  type ImportEntity,
  type ImportPreview,
  type ImportVariant,
  type VariantPatch,
} from "../lib/setup-import-shared";

export const READ_PAGE = 5_000;
export const WRITE_CHUNK = 1_000;

const VARIANT_SELECT = {
  id: true,
  productId: true,
  sku: true,
  handle: true,
  productTitle: true,
  variantTitle: true,
  vendor: true,
  supplierId: true,
  caseQty: true,
  noReorder: true,
  supplierCode: true,
} as const;

/** Every variant of the shop, page by page (id order). */
export async function* variantPages(shop: string, size = READ_PAGE): AsyncGenerator<ImportVariant[]> {
  let cursor: string | null = null;
  for (;;) {
    const rows: ImportVariant[] = await prisma.variant.findMany({
      where: { shop, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: VARIANT_SELECT,
      orderBy: { id: "asc" },
      take: size,
    });
    if (!rows.length) return;
    yield rows.map((r) => ({ ...r, noReorder: !!r.noReorder }));
    if (rows.length < size) return;
    cursor = rows[rows.length - 1].id;
  }
}

async function allVariants(shop: string): Promise<ImportVariant[]> {
  const out: ImportVariant[] = [];
  for await (const page of variantPages(shop)) for (const v of page) out.push(v);
  return out;
}

const supplierNames = (shop: string) => prisma.supplier.findMany({ where: { shop }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });

/** The page's counts (what each template holds). */
export async function importCounts(shop: string): Promise<{ suppliers: number; variants: number }> {
  const [suppliers, variants] = await Promise.all([prisma.supplier.count({ where: { shop } }), prisma.variant.count({ where: { shop } })]);
  return { suppliers, variants };
}

export async function exportSuppliersCsv(shop: string): Promise<string> {
  const forms = await listSupplierForms(shop);
  return suppliersCsv(forms.map((f) => f.form));
}

/** The products template with the current values, streamed (UTF-8 BOM, CRLF), product title order within each page. */
export function exportProductsStream(shop: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let pages: AsyncGenerator<ImportVariant[]> | null = null;
  let ctx: ReturnType<typeof productCtx> | null = null;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      ctx = productCtx(await supplierNames(shop));
      pages = variantPages(shop);
      controller.enqueue(enc.encode(CSV_BOM + productsCsvHeader() + "\r\n"));
    },
    async pull(controller) {
      const next = await pages!.next();
      if (next.done) {
        controller.close();
        return;
      }
      const sorted = [...next.value].sort((a, b) => a.productTitle.localeCompare(b.productTitle) || a.productId.localeCompare(b.productId) || a.variantTitle.localeCompare(b.variantTitle));
      controller.enqueue(enc.encode(sorted.map((v) => productsCsvRow(v, ctx!)).join("\r\n") + "\r\n"));
    },
  });
}

type Planned =
  | { entity: "products"; preview: ImportPreview; patches: Map<string, VariantPatch> }
  | { entity: "suppliers"; preview: ImportPreview; plan: ReturnType<typeof planSuppliersImport>["plan"] };

/** Checks a file against the store as it is now. Nothing is written. */
export async function planImport(shop: string, entity: ImportEntity, text: string, bytes: number): Promise<Planned> {
  const problem = fileProblem(text, bytes);
  if (problem) {
    const empty = planProductsImport([], [], []).preview;
    const preview = { ...empty, entity, fileError: problem };
    return entity === "products" ? { entity, preview, patches: new Map() } : { entity, preview, plan: { creates: [], updates: [] } };
  }
  if (entity === "products") {
    const [variants, suppliers] = await Promise.all([allVariants(shop), supplierNames(shop)]);
    const r = planProductsImport(readCsv(text), variants, suppliers);
    return { entity, preview: r.preview, patches: r.plan.patches };
  }
  const [existing, row] = await Promise.all([listSupplierForms(shop), prisma.shop.findUnique({ where: { domain: shop }, select: { currency: true, settings: true } })]);
  const r = planSuppliersImport(readCsv(text), existing, {
    storeCurrency: row?.currency ?? "USD",
    defaultLeadTime: readSettings(row?.settings).leadTimeDays,
    secretsWritable: secretsWritable(),
  });
  return { entity, preview: r.preview, plan: r.plan };
}

export type ApplyResult =
  | { ok: true; preview: ImportPreview; applied: number; variants: number }
  /** The store changed since the preview (or the file did): here is the new preview, nothing written. */
  | { ok: false; reason: "changed" | "invalid"; preview: ImportPreview };

/** Groups patches by field and value: one updateMany per (field, value), WRITE_CHUNK ids at a time. */
export function patchStatements(patches: Map<string, VariantPatch>): { field: keyof VariantPatch; value: unknown; ids: string[] }[] {
  const groups = new Map<string, { field: keyof VariantPatch; value: unknown; ids: string[] }>();
  for (const [id, patch] of patches) {
    for (const [field, value] of Object.entries(patch) as [keyof VariantPatch, unknown][]) {
      const k = `${field}\u0000${JSON.stringify(value)}`;
      (groups.get(k) ?? groups.set(k, { field, value, ids: [] }).get(k)!).ids.push(id);
    }
  }
  const out: { field: keyof VariantPatch; value: unknown; ids: string[] }[] = [];
  for (const g of groups.values()) for (let i = 0; i < g.ids.length; i += WRITE_CHUNK) out.push({ field: g.field, value: g.value, ids: g.ids.slice(i, i + WRITE_CHUNK) });
  return out;
}

/**
 * Confirm: checks the file again against the store as it is now and writes it only if the plan is
 * exactly what the merchant saw (`fingerprint`); otherwise returns the new preview. Rows with a
 * problem are skipped, as the preview said.
 */
export async function applyImport(shop: string, entity: ImportEntity, text: string, bytes: number, fingerprint: string): Promise<ApplyResult> {
  const planned = await planImport(shop, entity, text, bytes);
  const { preview } = planned;
  if (preview.fileError) return { ok: false, reason: "invalid", preview };
  if (preview.fingerprint !== fingerprint) return { ok: false, reason: "changed", preview };
  if (planned.entity === "products") {
    const statements = patchStatements(planned.patches);
    if (statements.length) {
      await prisma.$transaction(statements.map((s) => prisma.variant.updateMany({ where: { shop, id: { in: s.ids } }, data: { [s.field]: s.value } })));
      forgetOrderPlan(shop);
    }
    return { ok: true, preview, applied: preview.changed, variants: planned.patches.size };
  }
  const { creates, updates } = planned.plan;
  if (creates.length || updates.length) {
    await prisma.$transaction([
      ...creates.map((input) => prisma.supplier.create({ data: { shop, ...supplierWriteData(input) }, select: { id: true } })),
      ...updates.map((u) => prisma.supplier.updateMany({ where: { id: u.id, shop }, data: supplierWriteData(u.input) })),
    ]);
    forgetOrderPlan(shop);
  }
  return { ok: true, preview, applied: creates.length + updates.length, variants: 0 };
}
