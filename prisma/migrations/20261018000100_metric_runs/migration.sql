-- DB scale "before 1,000 stores": VariantMetric is no longer deleted and rewritten every night.
-- Compute writes only the rows whose content changed (contentHash: a hash of every stored column
-- but computedAt), removes the rows of variants it no longer computes, and records each run in
-- MetricRun (one row per shop × scope: when the latest run started / finished, rows confirmed,
-- rows changed). computedAt now means "content last changed"; freshness reads MetricRun.
-- Indexes for the screens' reads: (shop, scope, status) and (shop, scope, orderBy).
-- Add-only: a nullable column, a new table, new indexes.

-- AlterTable
ALTER TABLE "VariantMetric" ADD COLUMN "contentHash" TEXT;

-- CreateTable
CREATE TABLE "MetricRun" (
    "shop" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "rows" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MetricRun_pkey" PRIMARY KEY ("shop","scope")
);

-- CreateIndex
CREATE INDEX "VariantMetric_shop_scope_status_idx" ON "VariantMetric"("shop", "scope", "status");

-- CreateIndex
CREATE INDEX "VariantMetric_shop_scope_orderBy_idx" ON "VariantMetric"("shop", "scope", "orderBy");

-- Existing metrics: one run per (shop, scope) as their newest computedAt says.
INSERT INTO "MetricRun" ("shop", "scope", "startedAt", "finishedAt", "rows", "changed")
SELECT "shop", "scope", max("computedAt"), max("computedAt"), count(*)::int, count(*)::int
FROM "VariantMetric"
GROUP BY "shop", "scope";

ALTER TABLE "VariantMetric" SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
