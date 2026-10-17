/**
 * POST /app/transfers — "Create transfer in Shopify" from the transfer plan on Reorder
 * (spec §4 J7, §6.4; Pro `transfers`, checked here on the server). JSON body:
 *   { originId, destinationId, quantities: { [variantGid]: units } }
 * Sent only from the confirm dialog (invariant I-1). The transfer is created as a draft in
 * Shopify (services/transfers.server). No GET: this is a resource route.
 *
 * Handled outcomes answer 200 with `ok: false` and a reason (as /app/actions does), so the
 * dialog can show the message instead of a route error.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApp } from "../services/data-scope.server";
import { can } from "../services/entitlements.server";
import { createTransfer, type CreateTransferResult } from "../services/transfers.server";
import { readQty } from "../lib/reorder-shared";
import { requiredPlan } from "../lib/plan-shared";

export type TransfersResult =
  | CreateTransferResult
  | { ok: false; error: "bad_request" }
  | { ok: false; error: "upgrade"; upgrade: { feature: "transfers"; plan: string } }
  /** Sample data mode: nothing is created in Shopify (I-1). */
  | { ok: false; error: "sample" };

export const loader = async (_args: LoaderFunctionArgs) => {
  throw new Response("Method not allowed", { status: 405 });
};

const reply = (body: TransfersResult) => Response.json(body);
const LOCATION_GID = /^gid:\/\/shopify\/Location\/\d{1,20}$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d{1,20}$/;

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") throw new Response("Method not allowed", { status: 405 });
  const { admin, shop, sample } = await authenticateApp(request);
  // Sample data never reaches the store: no transfer is created.
  if (sample) return reply({ ok: false, error: "sample" });
  if (!(await can(shop, "transfers"))) {
    return reply({ ok: false, error: "upgrade", upgrade: { feature: "transfers", plan: requiredPlan("transfers") } });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return reply({ ok: false, error: "bad_request" });
  }
  const originId = typeof body.originId === "string" && LOCATION_GID.test(body.originId) ? body.originId : null;
  const destinationId = typeof body.destinationId === "string" && LOCATION_GID.test(body.destinationId) ? body.destinationId : null;
  if (!originId || !destinationId || originId === destinationId) return reply({ ok: false, error: "bad_request" });
  const raw = body.quantities && typeof body.quantities === "object" && !Array.isArray(body.quantities) ? (body.quantities as Record<string, unknown>) : {};
  const quantities: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw).slice(0, 500)) if (VARIANT_GID.test(k)) quantities[k] = readQty(v);

  try {
    return reply(await createTransfer(admin, shop, { originId, destinationId, quantities }));
  } catch (e) {
    console.error("[transfers] create failed", shop, e);
    return reply({ ok: false, error: "failed" });
  }
};
