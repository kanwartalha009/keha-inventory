-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NovaReferral" (
    "shop" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NovaReferral_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "NovaOutbox" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "headers" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "NovaOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UninstalledShop" (
    "shop" TEXT NOT NULL,
    "uninstalledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "UninstalledShop_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "BillingState" (
    "shop" TEXT NOT NULL,
    "planCode" TEXT,
    "interval" TEXT,
    "status" TEXT,
    "subscriptionId" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingState_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "OwnerEmailLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "error" TEXT,

    CONSTRAINT "OwnerEmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalDataAccessLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "records" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonalDataAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "plan" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "backfillState" JSONB NOT NULL DEFAULT '{}',
    "lastNightlyAt" TIMESTAMP(3),

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "online" BOOLEAN NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'other',

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "sku" TEXT,
    "vendor" TEXT,
    "productType" TEXT,
    "collections" TEXT[],
    "image" TEXT,
    "tracked" BOOLEAN NOT NULL,
    "isBundle" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "productCreatedAt" TIMESTAMP(3),
    "cost" DECIMAL(18,4),
    "costCurrency" TEXT,
    "price" DECIMAL(18,4),
    "supplierId" TEXT,
    "caseQty" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDaily" (
    "shop" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "sold" INTEGER NOT NULL,
    "returned" INTEGER NOT NULL,
    "gross" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "SalesDaily_pkey" PRIMARY KEY ("shop","day","variantId","locationKey","channel")
);

-- CreateTable
CREATE TABLE "StockDaily" (
    "shop" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "endUnits" INTEGER NOT NULL,
    "outOfStock" BOOLEAN NOT NULL,

    CONSTRAINT "StockDaily_pkey" PRIMARY KEY ("shop","day","variantId","locationId")
);

-- CreateTable
CREATE TABLE "SessionsDaily" (
    "shop" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "landingPath" TEXT NOT NULL,
    "trafficType" TEXT NOT NULL,
    "sessions" INTEGER NOT NULL,
    "checkouts" INTEGER NOT NULL,

    CONSTRAINT "SessionsDaily_pkey" PRIMARY KEY ("shop","day","landingPath","trafficType")
);

-- CreateTable
CREATE TABLE "ShopDaily" (
    "shop" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "orders" INTEGER NOT NULL,
    "gross" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "ShopDaily_pkey" PRIMARY KEY ("shop","day")
);

-- CreateTable
CREATE TABLE "StockNow" (
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "available" INTEGER NOT NULL,
    "incoming" INTEGER NOT NULL,
    "committed" INTEGER NOT NULL,
    "onHand" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockNow_pkey" PRIMARY KEY ("shop","variantId","locationId")
);

-- CreateTable
CREATE TABLE "VariantMetric" (
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "rate" DOUBLE PRECISION,
    "sigma" DOUBLE PRECISION,
    "daysLeft" DOUBLE PRECISION,
    "neverRunsOut" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "orderQty" INTEGER,
    "orderBy" DATE,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "inputs" JSONB NOT NULL,

    CONSTRAINT "VariantMetric_pkey" PRIMARY KEY ("shop","variantId","scope")
);

-- CreateTable
CREATE TABLE "Action" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "variantIds" TEXT[],
    "productId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "snoozeUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoneyAtStake" (
    "shop" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "atRisk" DECIMAL(18,2),
    "lost90" DECIMAL(18,2),
    "cashStuck" DECIMAL(18,2),
    "soldOutTraffic" DECIMAL(18,2),
    "basis" JSONB NOT NULL,

    CONSTRAINT "MoneyAtStake_pkey" PRIMARY KEY ("shop","day")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "leadTimeDays" INTEGER NOT NULL,
    "minOrder" INTEGER,
    "currency" TEXT,
    "vendorMatch" TEXT[],

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "confirmToken" TEXT NOT NULL,
    "confirmedShipDate" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "shopifyPoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scenario" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetValue" DECIMAL(18,2) NOT NULL,
    "result" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionGoal" (
    "shop" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "goalPct" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "CollectionGoal_pkey" PRIMARY KEY ("shop","collectionId")
);

-- CreateTable
CREATE TABLE "ForecastSnapshot" (
    "shop" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "variantId" TEXT NOT NULL,
    "predicted" DOUBLE PRECISION NOT NULL,
    "actual" DOUBLE PRECISION,

    CONSTRAINT "ForecastSnapshot_pkey" PRIMARY KEY ("shop","month","variantId")
);

-- CreateIndex
CREATE INDEX "NovaOutbox_status_nextAttemptAt_idx" ON "NovaOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OwnerEmailLog_shop_idx" ON "OwnerEmailLog"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerEmailLog_shop_kind_periodKey_key" ON "OwnerEmailLog"("shop", "kind", "periodKey");

-- CreateIndex
CREATE INDEX "PersonalDataAccessLog_shop_createdAt_idx" ON "PersonalDataAccessLog"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "PersonalDataAccessLog_createdAt_idx" ON "PersonalDataAccessLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "Location_shop_idx" ON "Location"("shop");

-- CreateIndex
CREATE INDEX "Variant_shop_idx" ON "Variant"("shop");

-- CreateIndex
CREATE INDEX "Variant_shop_productId_idx" ON "Variant"("shop", "productId");

-- CreateIndex
CREATE INDEX "SalesDaily_shop_variantId_day_idx" ON "SalesDaily"("shop", "variantId", "day");

-- CreateIndex
CREATE INDEX "StockDaily_shop_variantId_day_idx" ON "StockDaily"("shop", "variantId", "day");

-- CreateIndex
CREATE INDEX "VariantMetric_shop_status_idx" ON "VariantMetric"("shop", "status");

-- CreateIndex
CREATE INDEX "Action_shop_state_idx" ON "Action"("shop", "state");

-- CreateIndex
CREATE INDEX "Supplier_shop_idx" ON "Supplier"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_confirmToken_key" ON "PurchaseOrder"("confirmToken");

-- CreateIndex
CREATE INDEX "PurchaseOrder_shop_idx" ON "PurchaseOrder"("shop");

-- CreateIndex
CREATE INDEX "Scenario_shop_idx" ON "Scenario"("shop");

