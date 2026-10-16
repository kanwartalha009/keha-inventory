/**
 * VariantMetric writes for compute and compute-locations (review fix, performance): one
 * scope's rows are replaced in batches of METRIC_WRITE_BATCH variants — per batch, ONE
 * transaction of deleteMany (those variants in that scope) + createMany — instead of one
 * upsert statement per row. The rows written are identical to the upserts' (same columns,
 * same values); readers never see a batch half-written (the pair is one transaction). Rows of
 * variants not written this run are removed by the callers' computedAt sweep, as before.
 * skipDuplicates: a run that overlaps another for the same shop keeps the other run's fresh row.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";

export const METRIC_WRITE_BATCH = 1000;

export type MetricData = {
  variantId: string;
  rate: number | null;
  sigma: number | null;
  daysLeft: number | null;
  neverRunsOut: boolean;
  status: string;
  role: string;
  orderQty: number | null;
  orderBy: Date | null;
  computedAt: Date;
  inputs: Prisma.InputJsonValue;
};

export async function writeVariantMetrics(shop: string, scope: string, rows: readonly MetricData[]): Promise<void> {
  for (let i = 0; i < rows.length; i += METRIC_WRITE_BATCH) {
    const batch = rows.slice(i, i + METRIC_WRITE_BATCH);
    await prisma.$transaction([
      prisma.variantMetric.deleteMany({ where: { shop, scope, variantId: { in: batch.map((r) => r.variantId) } } }),
      prisma.variantMetric.createMany({ data: batch.map((r) => ({ shop, scope, ...r })), skipDuplicates: true }),
    ]);
  }
}
