-- 2026-10-18 "Order enough for N days" per purchase order (Kanwar): the days of stock after arrival
-- the order was built for, shown on the order. Nullable, add-only.
ALTER TABLE "PurchaseOrder" ADD COLUMN "coverDays" INTEGER;
