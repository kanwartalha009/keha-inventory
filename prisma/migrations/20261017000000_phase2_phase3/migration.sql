-- DropIndex
DROP INDEX "PurchaseOrder_shop_idx";

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "onlinePool" BOOLEAN;

-- AlterTable
ALTER TABLE "Action" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "doneAt" TIMESTAMP(3),
ADD COLUMN     "stateAmount" DECIMAL(18,2),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
-- Existing rows (safe on a non-empty table): one key per (kind, product), newest row wins.
UPDATE "Action" SET "dedupeKey" = "kind" || ':' || "productId" || ':' || "id" WHERE "dedupeKey" IS NULL;
ALTER TABLE "Action" ALTER COLUMN "dedupeKey" SET NOT NULL;
ALTER TABLE "Action" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "casePack" INTEGER,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "hidePrices" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "minOrderTotal" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Supplier" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "confirmExpiresAt" TIMESTAMP(3),
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "expectedDate" DATE,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "receivedAt" TIMESTAMP(3),
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "supplierName" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "supplierId" DROP NOT NULL;
ALTER TABLE "PurchaseOrder" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Scenario" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "event" TEXT NOT NULL DEFAULT 'custom';

-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccuracyMonth" (
    "shop" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "storeErrorPct" DOUBLE PRECISION,
    "top20ErrorPct" DOUBLE PRECISION,
    "graded" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccuracyMonth_pkey" PRIMARY KEY ("shop","month")
);

-- CreateTable
CREATE TABLE "Clearance" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "actionId" TEXT,
    "discountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT,
    "percent" INTEGER NOT NULL,
    "productIds" TEXT[],
    "variantIds" TEXT[],
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "baselineCash" DECIMAL(18,2) NOT NULL,
    "baselineUnits" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Clearance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyTransferId" TEXT NOT NULL,
    "originLocationId" TEXT NOT NULL,
    "destinationLocationId" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Collection_shop_idx" ON "Collection"("shop");

-- CreateIndex
CREATE INDEX "Clearance_shop_idx" ON "Clearance"("shop");

-- CreateIndex
CREATE INDEX "AlertLog_shop_productId_sentAt_idx" ON "AlertLog"("shop", "productId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_idempotencyKey_key" ON "Transfer"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Transfer_shop_idx" ON "Transfer"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Action_shop_dedupeKey_key" ON "Action"("shop", "dedupeKey");

-- CreateIndex
CREATE INDEX "PurchaseOrder_shop_status_idx" ON "PurchaseOrder"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_shop_number_key" ON "PurchaseOrder"("shop", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_shop_shopifyPoId_key" ON "PurchaseOrder"("shop", "shopifyPoId");

