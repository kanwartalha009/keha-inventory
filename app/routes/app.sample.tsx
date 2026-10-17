/**
 * POST /app/sample — sample data mode (owner 2026-10-17; components/sample, services/sample-data):
 *   { intent: "on" }  loads a simulated store under `<shop>#sample` and turns the mode on
 *                     (the Dashboard's "Explore with sample data", after its confirm);
 *   { intent: "off" } "Switch to my store": the mode off and every sample row deleted.
 * Database only: nothing is read from or written to Shopify. Every loader re-runs after the
 * action, so every screen switches at once. No GET: a resource route.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { loadSampleData, removeSampleData } from "../services/sample-data.server";
import type { SampleActionResult } from "../components/sample";

export const loader = async (_args: LoaderFunctionArgs) => {
  throw new Response("Method not allowed", { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs): Promise<SampleActionResult> => {
  const { session } = await authenticate.admin(request);
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "bad_request" };
  }
  if (body.intent === "on") {
    const r = await loadSampleData(session.shop);
    return r.ok ? { ok: true, on: true } : { ok: false, error: r.error };
  }
  if (body.intent === "off") {
    await removeSampleData(session.shop);
    return { ok: true, on: false };
  }
  return { ok: false, error: "bad_request" };
};
