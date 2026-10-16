/**
 * Create the Shopify discount for a Clear action (spec §4 J5, §6.4). Called
 * only from the confirm dialog's POST (invariant I-1: nothing changes the
 * store without an explicit confirm). Scope: write_discounts.
 *
 * Returns the discount id, or Shopify's user errors to show in the dialog.
 */
import type { AdminGraphqlClient } from "../models/shop.server";
import { discountInput, userErrorMessages, type ClearValue, type DiscountUserError } from "../lib/clearance-shared";

const AUTOMATIC_CREATE = `#graphql
  mutation KehaInvClearAutomatic($input: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicCreate(automaticBasicDiscount: $input) {
      automaticDiscountNode { id }
      userErrors { field message code }
    }
  }`;

const CODE_CREATE = `#graphql
  mutation KehaInvClearCode($input: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $input) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }`;

export type CreateDiscountResult = { ok: true; id: string } | { ok: false; userErrors: string[] };

type Payload = { userErrors?: DiscountUserError[]; automaticDiscountNode?: { id: string } | null; codeDiscountNode?: { id: string } | null };

export async function createClearanceDiscount(
  admin: AdminGraphqlClient,
  value: ClearValue,
  scope: { productIds: string[]; startsAt: Date; endsAt: Date | null },
): Promise<CreateDiscountResult> {
  const input = discountInput(value, scope);
  const res = await admin.graphql(value.kind === "code" ? CODE_CREATE : AUTOMATIC_CREATE, { variables: { input } });
  const body = (await res.json()) as {
    data?: { discountAutomaticBasicCreate?: Payload | null; discountCodeBasicCreate?: Payload | null };
    errors?: { message?: string }[];
  };
  const payload = value.kind === "code" ? body.data?.discountCodeBasicCreate : body.data?.discountAutomaticBasicCreate;
  const errors = userErrorMessages(payload?.userErrors);
  if (errors.length > 0) return { ok: false, userErrors: errors };
  const id = payload?.automaticDiscountNode?.id ?? payload?.codeDiscountNode?.id ?? null;
  if (!id) {
    const top = (body.errors ?? []).map((e) => String(e?.message ?? "")).filter(Boolean);
    return { ok: false, userErrors: top };
  }
  return { ok: true, id };
}
