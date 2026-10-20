/**
 * Shopify's mutation errors arrive in English whatever the admin language (post-approval backlog
 * C6). The common ones map to a known message the app translates; anything else is shown as
 * Shopify wrote it, after "Shopify says:" so it is clear where the English comes from.
 */
export type ShopifyErrorKey =
  | "codeTaken"
  | "titleTaken"
  | "endDate"
  | "discountLimit"
  | "notStocked"
  | "sameLocation"
  | "quantity"
  | "permission";

const RULES: { key: ShopifyErrorKey; re: RegExp }[] = [
  { key: "codeTaken", re: /code.*(unique|taken|already)/i },
  { key: "titleTaken", re: /title.*(taken|already|unique)/i },
  { key: "endDate", re: /(ends?[_ ]?at|end date).*(after|before|past|invalid)|(after|before).*starts?[_ ]?at/i },
  { key: "discountLimit", re: /discount.*limit|limit.*discount|maximum number of.*discount/i },
  { key: "notStocked", re: /not (stocked|active|tracked)|isn't stocked|is not available at/i },
  { key: "sameLocation", re: /(origin|source).*(destination).*(same|different)|same location/i },
  { key: "quantity", re: /quantity/i },
  { key: "permission", re: /access denied|permission|not authorized|unauthori[sz]ed/i },
];

/** The known message for one of Shopify's error texts; null = show Shopify's own words. */
export function shopifyErrorKey(message: string): ShopifyErrorKey | null {
  for (const r of RULES) if (r.re.test(message)) return r.key;
  return null;
}

export const SHOPIFY_ERROR_TEXT: Record<ShopifyErrorKey, string> = {
  codeTaken: "This discount code is already used in your store. Choose another code.",
  titleTaken: "A discount with this name already exists in your store. Try again in a minute.",
  endDate: "The end date must be after today.",
  discountLimit: "Your store has reached Shopify's limit of active automatic discounts. End one in Shopify, or use a discount code instead.",
  notStocked: "A product isn't stocked at one of these locations in Shopify. Stock it there in Shopify first.",
  sameLocation: "The two locations must be different.",
  quantity: "Every quantity must be a whole number of 1 or more.",
  permission: "Keha doesn't have permission for this in your store. Open the app again to update its access.",
};

/** One readable line per error, in the admin language; duplicates removed. */
export function shopifyErrorLines(messages: readonly string[], t: (s: string) => string): string[] {
  const out = messages.map((m) => {
    const key = shopifyErrorKey(m);
    return key ? t(SHOPIFY_ERROR_TEXT[key]) : `${t("Shopify says:")} ${m}`;
  });
  return [...new Set(out)];
}
