/**
 * POST /cron/purge-uninstalled — scheduled GDPR purge (§7.4).
 *
 * Hard-deletes all shop-scoped data 48h after uninstall. Idempotent: each
 * UninstalledShop row is purged once, then stamped `purgedAt`. A shop that
 * reinstalled inside the 48h is skipped and its purge cancelled (2026-09-28).
 * Token-guarded for an external scheduler (the Nova platform cron or any HTTP
 * scheduler):
 *   Authorization: Bearer $INVENTORY_CRON_SECRET  
 * GET is a dry run that lists which shops are due, without deleting.
 * The in-process scheduler runs the same purge hourly (scheduler.server).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { purgeDueShops, shopsDueForPurge } from "../services/gdpr.server";
import { cronAuthorized } from "../lib/cron-auth.server";

const authorized = (request: Request) => cronAuthorized(request);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
  const results = await purgeDueShops();
  console.log(`[purge-uninstalled] purged ${results.length} shop(s)`);
  return Response.json({ purged: results.length, results });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
  return Response.json({ due: await shopsDueForPurge() });
};
