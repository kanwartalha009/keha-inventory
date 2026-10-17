-- Data audit 2026-10-17 #1: whether a variant keeps selling when out of stock (add-only, safe on tables with rows).
-- Shopify ProductVariant.inventoryPolicy: CONTINUE = backorders are owed; DENY / NULL = missed sales are lost.
ALTER TABLE "Variant" ADD COLUMN "inventoryPolicy" TEXT;
