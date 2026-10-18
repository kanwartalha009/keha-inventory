-- Perf 2026-10-18 ("before 1,000 stores" #12): the job claim (lib/jobs-shared SQL_CLAIM) takes a job
-- whose worker died first, else the oldest due unlocked job — each step on its own partial index,
-- so a claim never walks past running jobs. Partial indexes can't be written in schema.prisma
-- (like the fact tables' partitions): they live here only. Add-only.

-- CreateIndex
CREATE INDEX "Job_claim_idx" ON "Job" ("runAt", "id") WHERE "lockedUntil" IS NULL;

-- CreateIndex
CREATE INDEX "Job_locked_idx" ON "Job" ("lockedUntil") WHERE "lockedUntil" IS NOT NULL;
