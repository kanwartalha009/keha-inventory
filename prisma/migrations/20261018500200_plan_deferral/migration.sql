-- Fit to budget → Apply (merchant audit 2026-10-18; a new table, add-only): one row per order the
-- merchant chose to move to next month — "don't order this variant before `until`" — in batches
-- (one per Apply) that Undo deletes. Our database only; purged with the shop (I-3).
CREATE TABLE "PlanDeferral" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "batch" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "supplierKey" TEXT NOT NULL,
    "fromDay" DATE NOT NULL,
    "until" DATE NOT NULL,
    "qty" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanDeferral_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlanDeferral_shop_idx" ON "PlanDeferral"("shop");
