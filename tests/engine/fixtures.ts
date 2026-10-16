/**
 * Hand-built fixtures for the engine tests (spec §7). Pinned dates only.
 * Day offsets: k = 1 is yesterday, k = 90 is 90 days ago.
 */
import { addDays, type DayKey } from "../../app/lib/engine/dates-shared";
import type { MoneyVariant } from "../../app/lib/engine/money-shared";
import type { VariantInput } from "../../app/lib/engine/index-shared";
import type { DailyRow } from "../../app/lib/engine/types-shared";

export const TODAY: DayKey = "2026-10-16";

export function ago(k: number, today: DayKey = TODAY): DayKey {
  return addDays(today, -k);
}

type PerDay<T> = T | ((k: number) => T);
const at = <T,>(v: PerDay<T>, k: number): T => (typeof v === "function" ? (v as (k: number) => T)(k) : v);

export interface SeriesOpts {
  /** Days back from yesterday (k = 1..days). */
  days: number;
  sold: PerDay<number>;
  oos?: PerDay<boolean>;
  /** Missing days have no row at all. */
  missing?: PerDay<boolean>;
  price?: PerDay<number | null>;
  cost?: PerDay<number | null>;
  endStock?: PerDay<number>;
  today?: DayKey;
}

export function buildSeries(o: SeriesOpts): DailyRow[] {
  const rows: DailyRow[] = [];
  for (let k = 1; k <= o.days; k++) {
    if (o.missing && at(o.missing, k)) continue;
    rows.push({
      day: ago(k, o.today ?? TODAY),
      sold: at(o.sold, k),
      endStock: o.endStock === undefined ? 10 : at(o.endStock, k),
      outOfStock: o.oos === undefined ? false : at(o.oos, k),
      price: o.price === undefined ? null : at(o.price, k),
      cost: o.cost === undefined ? null : at(o.cost, k),
    });
  }
  return rows;
}

export function variantInput(over: Partial<VariantInput> = {}): VariantInput {
  return {
    id: "v1",
    series: buildSeries({ days: 90, sold: 2 }),
    today: TODAY,
    onHand: 100,
    role: "B",
    productCreatedAt: ago(400),
    ...over,
  };
}

export function moneyVariant(over: Partial<MoneyVariant> = {}): MoneyVariant {
  return {
    id: "m1",
    status: "healthy",
    rate: 2,
    onHand: 50,
    incoming: 0,
    price: 10,
    cost: 4,
    outOfStockDays: 0,
    ...over,
  };
}
