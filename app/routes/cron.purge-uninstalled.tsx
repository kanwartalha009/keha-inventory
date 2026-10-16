/**
 * POST /cron/purge-uninstalled — scheduled GDPR purge (§7.4).
 *
 * Hard-deletes all shop-scoped data 48h after uninstall. Idempotent: each
 * UninstalledShop row is purged once, then stamped `purgedAt`. A shop that
 * reinstalled inside the 48h is skipped and its purge cancelled (2026-09-28).
 * Token-guarded for an external scheduler (the Nova platform cron or any HTTP
 * scheduler):
 *   Authorization: Bearer $INVENTORY_CRON_SECRET   (or ?token=$INVENTORY_CRON_SECRET)
 * GET is a dry run that lists which shops are due, without deleting.
 * The in-process scheduler runs the same purge hourly (scheduler.server).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { purgeDueShops, shopsDueForPurge } from "../services/gdpr.server";

function authorized(request: Request): boolean {
  const secret = process.env.INVENTORY_CRON_SECRET ?? "";
  if (!secret) return false;
  const tokenParam = new URL(request.url).searchParams.get("token");
  const bearer = (request.headers.get("Authorization") || "").match(
    /^Bearer\s+(.+)$/i,
  )?.[1];
  return tokenParam === secret || bearer === secret;
}

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
