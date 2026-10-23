-- Clarity pass (2026-10-23): first-session measurement, one row per shop and step.
CREATE TABLE "ActivationEvent" (
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivationEvent_pkey" PRIMARY KEY ("shop","kind")
);

CREATE INDEX "ActivationEvent_kind_at_idx" ON "ActivationEvent"("kind", "at");
