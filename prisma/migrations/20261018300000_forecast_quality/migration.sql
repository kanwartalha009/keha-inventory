-- Forecast quality (R4, 2026-10-18; add-only, safe on tables with rows).
-- Bundle components: bundle sales count as demand on their components.
ALTER TABLE "Variant" ADD COLUMN "bundleComponents" JSONB;

-- Per-product forecast choices: "Don't cap" and "Plan like…".
CREATE TABLE "ForecastOverride" (
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "noCap" BOOLEAN NOT NULL DEFAULT false,
    "likeKind" TEXT,
    "likeRef" TEXT,
    "likePct" INTEGER NOT NULL DEFAULT 100,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ForecastOverride_pkey" PRIMARY KEY ("shop","productId")
);
