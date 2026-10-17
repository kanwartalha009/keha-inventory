-- DB scale #3 (audit 2026-10-17): stored first / last days so compute, per-location compute and
-- the order plan stop scanning every variant's whole history. Add-only: nullable columns and a
-- new table, safe on tables with rows. Existing shops get the days built once by their next
-- compute (Shop.factDaysAt stays null until then and readers use the facts as before).
-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "factDaysAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Variant" ADD COLUMN     "firstSaleDay" DATE,
ADD COLUMN     "firstStockDay" DATE,
ADD COLUMN     "lastSaleDay" DATE;

-- CreateTable
CREATE TABLE "VariantLocationDays" (
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationKey" TEXT NOT NULL,
    "firstStockDay" DATE,
    "lastSaleDay" DATE,

    CONSTRAINT "VariantLocationDays_pkey" PRIMARY KEY ("shop","variantId","locationKey")
);
