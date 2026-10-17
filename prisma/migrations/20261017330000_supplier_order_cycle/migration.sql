-- Supplier order cycle (consolidated supplier purchase order, Kanwar 2026-10-17; add-only, safe on tables with rows).
-- null = the store's order cycle from Settings → Defaults.
ALTER TABLE "Supplier" ADD COLUMN "orderCycleDays" INTEGER;
