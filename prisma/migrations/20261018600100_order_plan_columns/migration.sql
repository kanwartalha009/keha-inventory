-- Perf 2026-10-18 ("before 1,000 stores" #8): the order plan read every metric with something to
-- order AND its inputs JSON (~2 KB, mostly the 53-week seasonal curve) — ~20,000 rows on a large
-- store. Compute now also writes the fields the plan reads as columns (lib/plan-columns-shared) and
-- each run's curves once per shape (MetricRun.curves); the order plan selects only those. Rows
-- written before (planVersion NULL) are read the old way until the next run rewrites them.
-- Add-only: nullable columns.

-- AlterTable
ALTER TABLE "VariantMetric" ADD COLUMN "planVersion" INTEGER,
ADD COLUMN "planSafety" DOUBLE PRECISION,
ADD COLUMN "planSeasonal" DOUBLE PRECISION,
ADD COLUMN "planTrend" DOUBLE PRECISION,
ADD COLUMN "planPlan" DOUBLE PRECISION,
ADD COLUMN "planLeadDays" DOUBLE PRECISION,
ADD COLUMN "planCycleDays" DOUBLE PRECISION,
ADD COLUMN "planOnHand" DOUBLE PRECISION,
ADD COLUMN "planIncoming" DOUBLE PRECISION,
ADD COLUMN "planNeed" DOUBLE PRECISION,
ADD COLUMN "planZ" DOUBLE PRECISION,
ADD COLUMN "planOutSince" DATE,
ADD COLUMN "planSellsWhenOut" BOOLEAN,
ADD COLUMN "planCurveKey" TEXT,
ADD COLUMN "planExtra" JSONB;

-- AlterTable
ALTER TABLE "MetricRun" ADD COLUMN "curves" JSONB;
