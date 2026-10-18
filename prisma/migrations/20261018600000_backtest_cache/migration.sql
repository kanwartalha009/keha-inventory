-- Perf 2026-10-18 ("before 1,000 stores" #5 / #6): the weekly backtest cache. Compute re-read 14
-- months of sales and stock for every variant every night and re-ran the forecast-error backtest;
-- now each variant's history rows and backtest are read once a week (spread over the nights) and
-- reused (lib/backtest-cache-shared). The roles' pooled ratios are kept per shop for the week.
-- Add-only: two new tables.

-- CreateTable
CREATE TABLE "VariantBacktest" (
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "horizon" INTEGER NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "backtested" BOOLEAN NOT NULL,
    "ratio" DOUBLE PRECISION,
    "windows" DOUBLE PRECISION NOT NULL,
    "samples" INTEGER NOT NULL,
    "bias" DOUBLE PRECISION,
    "history" TEXT,

    CONSTRAINT "VariantBacktest_pkey" PRIMARY KEY ("shop","variantId")
);

-- CreateTable
CREATE TABLE "BacktestRun" (
    "shop" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "priorA" DOUBLE PRECISION NOT NULL,
    "priorB" DOUBLE PRECISION NOT NULL,
    "priorC" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("shop")
);

-- About a seventh of the rows is replaced each night (delete + insert): vacuum early.
ALTER TABLE "VariantBacktest" SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
