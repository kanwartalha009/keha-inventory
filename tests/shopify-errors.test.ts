/** Post-approval backlog C6: Shopify's English errors map to translated messages. */
import { describe, expect, it } from "vitest";
import { shopifyErrorKey, shopifyErrorLines } from "../app/lib/shopify-errors-shared";
import { translate } from "../app/lib/i18n";

describe("shopifyErrorKey", () => {
  it.each([
    ["Code must be unique. Please try a different code.", "codeTaken"],
    ["Ends at needs to be after starts_at", "endDate"],
    ["The origin location and destination location must be different", "sameLocation"],
    ["Inventory item is not stocked at the location", "notStocked"],
    ["Quantity must be greater than 0", "quantity"],
    ["Access denied for discountCodeBasicCreate field", "permission"],
  ])("%s → %s", (m, key) => expect(shopifyErrorKey(m)).toBe(key));
  it("unknown text: Shopify's own words, labelled", () => {
    expect(shopifyErrorKey("Something new")).toBeNull();
    expect(shopifyErrorLines(["Something new"], (s) => s)).toEqual(["Shopify says: Something new"]);
  });
  it("translated in the admin language, duplicates once", () => {
    const de = (s: string) => translate("de", s);
    expect(shopifyErrorLines(["Code must be unique.", "Code has already been taken"], de)).toEqual(["Dieser Rabattcode wird in deinem Shop schon verwendet. Wähle einen anderen Code."]);
  });
});
