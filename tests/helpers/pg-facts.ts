/**
 * Seeding the compact fact tables in Postgres tests from plain daily rows (GIDs, location keys,
 * channels), whatever the date: the month partitions are created as needed (retention is the
 * maintenance job's business, not the seed's), Shop rows and FactKey entries are added.
 */
import { psql } from "./pg";
import { createPartitionSql } from "../../app/lib/partitions-shared";
import { monthOf } from "../../app/lib/ids-shared";
import { variantNum } from "../../app/lib/ids-shared";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export type SeedSale = { shop: string; day: string; variantId: string; locationKey: string; channel: string; sold: number; returned?: number; gross?: number };

/** Inserts SalesFact rows (one statement). */
export function seedSales(db: string, rows: readonly SeedSale[]): void {
  if (!rows.length) return;
  const shops = [...new Set(rows.map((r) => r.shop))];
  const keys = [...new Set(rows.flatMap((r) => [r.locationKey, r.channel]))];
  const months = [...new Set(rows.map((r) => monthOf(r.day)))];
  const script = [
    `INSERT INTO "Shop" ("id","domain","currency","timezone","locale") SELECT d, d, 'EUR', 'UTC', 'en' FROM unnest(ARRAY[${shops.map(q).join(",")}]::text[]) d WHERE NOT EXISTS (SELECT 1 FROM "Shop" s WHERE s."domain" = d)`,
    `INSERT INTO "FactKey" ("key") SELECT k FROM unnest(ARRAY[${keys.map(q).join(",")}]::text[]) k ON CONFLICT ("key") DO NOTHING`,
    ...months.map((m) => createPartitionSql("SalesFact", m)),
    `INSERT INTO "SalesFact" ("variantNum","grossCents","shopNum","day","locNum","channelNum","sold","returned") VALUES ${rows
      .map((r) => {
        const v = variantNum(r.variantId);
        if (v === null) throw new Error(`seedSales: ${r.variantId} is not a ProductVariant GID`);
        return `(${v}, ${Math.round((r.gross ?? 0) * 100)}, (SELECT "num" FROM "Shop" WHERE "domain" = ${q(r.shop)}), '${r.day}', (SELECT "num" FROM "FactKey" WHERE "key" = ${q(r.locationKey)}), (SELECT "num" FROM "FactKey" WHERE "key" = ${q(r.channel)}), ${r.sold}, ${r.returned ?? 0})`;
      })
      .join(",\n")}`,
  ].join(";\n");
  psql(db, script);
}
