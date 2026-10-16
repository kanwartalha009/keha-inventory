/**
 * POST /app/actions — the action list's writes (spec §5.1, §4 J5). JSON body:
 *   { op: "snooze" | "dismiss" | "done" | "undo", id }
 *   { op: "clear", id, kind, percent, endsOn, code }   (Growth: clearance)
 * Every write checks the action belongs to the session's shop. "clear" runs
 * only from the confirm dialog (invariant I-1) and checks the plan on the
 * server. No GET: this is a resource route.
 *
 * Handled outcomes answer 200 with `ok: false` and a reason (as the Settings
 * action does): a non-2xx Response returned to a fetcher becomes a route
 * error in React Router, and the dialog must show the message instead.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { can } from "../services/entitlements.server";
import { createClearanceDiscount } from "../services/clearance.server";
import { getClearTarget, recordClearance, updateActionState } from "../models/actions.server";
import { isActionOp, type ActionOp } from "../lib/action-list-shared";
import { endOfLocalDay, validateClearForm, type ClearFormError } from "../lib/clearance-shared";
import { todayIn } from "../lib/dashboard-shared";
import { requiredPlan } from "../lib/plan-shared";

export type ActionsResult =
  | { ok: true; op: ActionOp; id: string }
  | { ok: true; op: "clear"; id: string; discountId: string }
  | { ok: false; error: "bad_request" | "not_found" | "failed" }
  | { ok: false; error: "invalid"; errors: Partial<Record<ClearFormError, true>> }
  | { ok: false; error: "shopify"; userErrors: string[] }
  | { ok: false; error: "upgrade"; upgrade: { feature: "clearance"; plan: string } };

export const loader = async (_args: LoaderFunctionArgs) => {
  throw new Response("Method not allowed", { status: 405 });
};

const reply = (body: ActionsResult) => Response.json(body);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") throw new Response("Method not allowed", { status: 405 });
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return reply({ ok: false, error: "bad_request" });
  }
  const id = typeof body.id === "string" && body.id.length > 0 && body.id.length <= 64 ? body.id : null;
  if (!id) return reply({ ok: false, error: "bad_request" });
  const now = new Date();

  if (isActionOp(body.op)) {
    const done = await updateActionState(shop, id, body.op, now);
    if (!done) return reply({ ok: false, error: "not_found" });
    return reply({ ok: true, op: body.op, id });
  }

  if (body.op !== "clear") return reply({ ok: false, error: "bad_request" });

  if (!(await can(shop, "clearance"))) {
    return reply({ ok: false, error: "upgrade", upgrade: { feature: "clearance", plan: requiredPlan("clearance") } });
  }
  const target = await getClearTarget(shop, id);
  if (!target) return reply({ ok: false, error: "not_found" });

  const today = todayIn(target.timezone, now);
  const form = validateClearForm(
    { kind: String(body.kind ?? ""), percent: String(body.percent ?? ""), endsOn: String(body.endsOn ?? ""), code: String(body.code ?? "") },
    today,
  );
  if (!form.ok) return reply({ ok: false, error: "invalid", errors: form.errors });

  const startsAt = now;
  const endsAt = form.value.endsOn ? endOfLocalDay(form.value.endsOn, target.timezone) : null;
  let created;
  try {
    created = await createClearanceDiscount(admin, form.value, { productIds: [target.productId], startsAt, endsAt });
  } catch (e) {
    console.error("[actions] discount create failed", shop, e);
    return reply({ ok: false, error: "failed" });
  }
  if (!created.ok) return reply({ ok: false, error: "shopify", userErrors: created.userErrors });

  // The discount exists in Shopify now; a failed bookkeeping write must not
  // invite a second click that would create a second discount.
  try {
    await recordClearance(shop, target, form.value, { id: created.id, startsAt, endsAt }, now);
  } catch (e) {
    console.error("[actions] clearance record failed", shop, created.id, e);
    await updateActionState(shop, id, "done", now).catch(() => null);
  }
  return reply({ ok: true, op: "clear", id, discountId: created.id });
};
