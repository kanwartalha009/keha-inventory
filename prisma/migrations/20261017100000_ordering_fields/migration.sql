-- Ordering fields from the 2026-10-17 audits (add-only, safe on tables with rows).
-- Variant: "Don't reorder" switch.
ALTER TABLE "Variant" ADD COLUMN "noReorder" BOOLEAN NOT NULL DEFAULT false;

-- Supplier: transit days, money minimum, minimum scope, exchange rate.
ALTER TABLE "Supplier" ADD COLUMN "transitDays" INTEGER;
ALTER TABLE "Supplier" ADD COLUMN "minOrderValue" DECIMAL(18,2);
ALTER TABLE "Supplier" ADD COLUMN "minOrderScope" TEXT NOT NULL DEFAULT 'variant';
ALTER TABLE "Supplier" ADD COLUMN "exchangeRate" DECIMAL(18,6);
