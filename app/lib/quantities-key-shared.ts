/**
 * The content key of an editable quantity table (Reorder group cards, transfer cards). Pure.
 *
 * Any submit on the page (another card's "Create order", a transfer, the location switcher)
 * revalidates the loader, which hands every card a new `group` object with the same content.
 * The cards reset their typed quantities only when this key changes, i.e. when the lines or
 * their suggested quantities really changed, so a merchant's edits survive other submits.
 */
export function quantitiesKey(groupKey: string, lines: ReadonlyArray<readonly [variantId: string, suggested: number | null]>): string {
  const sorted = lines.map(([id, n]) => [id, n ?? null] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify([groupKey, sorted]);
}
