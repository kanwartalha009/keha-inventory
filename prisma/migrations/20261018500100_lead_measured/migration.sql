-- Measured lead time per supplier (merchant audit 2026-10-18; add-only, safe on tables with rows):
-- the median and 80th percentile of the actual days order → arrival of its received orders, and the
-- median delay (actual − promised). From 3 deliveries the supplier's page offers "Use measured lead
-- time" and a supplier usually more than 3 days late is flagged (lib/lead-time-shared).
ALTER TABLE "Supplier" ADD COLUMN "leadMedianDays" DOUBLE PRECISION,
ADD COLUMN "leadP80Days" DOUBLE PRECISION,
ADD COLUMN "leadMedianDelayDays" DOUBLE PRECISION;
