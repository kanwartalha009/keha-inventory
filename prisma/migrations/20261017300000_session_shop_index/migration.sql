-- DB scale #5 (audit 2026-10-17): installed shops are listed by Session.shop (scheduler, jobs,
-- plan sync). Add-only: an index, safe on a table with rows.
-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");
