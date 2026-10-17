-- Purchase-order documents (merchant audit 2026-10-18; add-only, safe on tables with rows).
-- Supplier.poLanguage: the language the supplier's purchase orders are written in (email, PDF,
-- CSV, supplier page): one of the app's 8 languages; null = English.
-- Supplier.incoterms: optional delivery terms printed on the order, e.g. "FOB Ningbo", "EXW", "DDP".
-- PurchaseOrder.shipToLocationId: the Shopify location the goods go to (a Location.id); null = the
-- default (the store's main warehouse) when the document is made.
ALTER TABLE "Supplier" ADD COLUMN "poLanguage" TEXT,
ADD COLUMN "incoterms" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "shipToLocationId" TEXT;
