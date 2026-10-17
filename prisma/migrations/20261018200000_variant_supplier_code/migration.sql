-- Size-grid purchase orders (supplier module, Kanwar 2026-10-17; add-only, safe on tables with rows):
-- the supplier's article / style code for a product, written to every variant of the product.
ALTER TABLE "Variant" ADD COLUMN "supplierCode" TEXT;
