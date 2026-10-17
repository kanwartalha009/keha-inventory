-- Supplier module (Kanwar 2026-10-17; add-only, safe on tables with rows): payment terms, landed
-- cost and the measured lead-time reliability.
-- Payment terms: depositPercent paid when the order is placed, the rest at balanceDue
-- ("ship" | "arrival" | "after_arrival", balanceDays after arrival). null = 100 % when ordering.
-- landedCostPercent: freight + duty in % of the goods (cost lines and cash, never the supplier's documents).
-- lead*: measured from received orders (deliveries, average promised / actual days, average delay,
-- σ of the actual lead time, share on time, when measured); σ feeds safety stock from 3 deliveries.
ALTER TABLE "Supplier" ADD COLUMN "depositPercent" INTEGER,
ADD COLUMN "balanceDue" TEXT,
ADD COLUMN "balanceDays" INTEGER,
ADD COLUMN "landedCostPercent" DECIMAL(6,2),
ADD COLUMN "leadSamples" INTEGER,
ADD COLUMN "leadPromisedDays" DOUBLE PRECISION,
ADD COLUMN "leadActualDays" DOUBLE PRECISION,
ADD COLUMN "leadDelayDays" DOUBLE PRECISION,
ADD COLUMN "leadSigmaDays" DOUBLE PRECISION,
ADD COLUMN "leadOnTimeShare" DOUBLE PRECISION,
ADD COLUMN "leadStatsAt" TIMESTAMP(3);
