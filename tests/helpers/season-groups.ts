/** Season groups for pure tests: [id, units in 12 months, products (default 1), catch-all (default false)]. */
import { PRODUCT_TYPE_GROUP, SEASON, type SeasonGroup } from "../../app/lib/engine/season-shared";

export function testGroups(rows: readonly (readonly [string, number, number?, boolean?])[]): Map<string, SeasonGroup> {
  return new Map(
    rows.map(([id, units12m, products = 1, catchAll = false]) => {
      const isType = id.startsWith(PRODUCT_TYPE_GROUP);
      const g: SeasonGroup = {
        id,
        kind: isType ? "productType" : "collection",
        key: isType ? id.slice(PRODUCT_TYPE_GROUP.length) : id,
        units12m,
        variants: products,
        products,
        catchAll,
        qualifies: !catchAll && units12m >= SEASON.collectionMinUnits12m,
      };
      return [id, g] as const;
    }),
  );
}
