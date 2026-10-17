/**
 * GET /api/sidekick/:tool — the backend of the Shopify Sidekick data tools
 * (extensions/keha-inventory-sidekick/src/index.js; tools in
 * app/lib/sidekick-shared.ts SIDEKICK_TOOLS, logic in app/services/sidekick.server.ts).
 *
 * A resource route (no UI, not under the /app layout). The tool runs in Shopify's
 * sandbox at https://extensions.shopifycdn.com and fetches this path on the
 * app's own domain, so Shopify adds the session token (`Authorization:
 * Bearer …`). `authenticate.admin`:
 *  - answers the CORS preflight (OPTIONS → 204 with Access-Control-Allow-Origin
 *    `*`, Authorization and Content-Type allowed) before anything else;
 *  - validates the token and exchanges it (managed install) — a request with
 *    a token never hits the embedded-app redirects;
 *  - adds the CORS headers to its own error responses (401 …).
 * Every response we build goes through `cors(...)` too.
 *
 * Read-only, database-only (no Admin API call), answered within
 * RESPONSE_DEADLINE_MS (Sidekick skips data tools slower than 1 second).
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { runSidekickTool } from "../services/sidekick.server";
import { MSG, RESPONSE_DEADLINE_MS, isSidekickTool, type SidekickResponse } from "../lib/sidekick-shared";

const json = (body: SidekickResponse, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** The tool's answer, or the "took too long" message when it isn't ready in time. */
export async function withDeadline(work: Promise<SidekickResponse>, ms: number): Promise<SidekickResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<SidekickResponse>((resolve) => {
    timer = setTimeout(() => resolve({ message: MSG.slow }), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { cors, session } = await authenticate.admin(request);
  const tool = params.tool;
  if (!isSidekickTool(tool)) return cors(json({ message: "Unknown tool." }, 404));
  try {
    const body = await withDeadline(runSidekickTool(session.shop, tool, new URL(request.url).searchParams), RESPONSE_DEADLINE_MS);
    return cors(json(body));
  } catch (e) {
    // The tool name only: error text can carry store data (spec §17).
    console.error("sidekick tool failed", tool, e instanceof Error ? e.name : "unknown");
    return cors(json({ message: MSG.failed }, 500));
  }
};
