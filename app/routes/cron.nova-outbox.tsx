/**
 * POST /cron/nova-outbox — durable retry of Nova platform calls (GO-LIVE-AUDIT P1).
 *
 * Drains PENDING NovaOutbox rows whose backoff has elapsed (install-confirm + webhook forwards that
 * didn't deliver first try). Safe to retry — Nova dedupes. Token-guarded for an external scheduler:
 *   Authorization: Bearer $INVENTORY_CRON_SECRET  
 * GET is a dry run reporting how many rows are due. Run it every minute or two.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { flushOutbox } from "../lib/nova.server";
import { cronAuthorized } from "../lib/cron-auth.server";

const authorized = (request: Request) => cronAuthorized(request);

const outbox = prisma.novaOutbox;

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
  const result = await flushOutbox(100);
  console.log(`[nova-outbox] sent=${result.sent} failed=${result.failed} processed=${result.processed}`);
  return Response.json(result);
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
  const due = await outbox.count({ where: { status: "PENDING", nextAttemptAt: { lte: new Date() } } });
  const dead = await outbox.count({ where: { status: "DEAD" } });
  return Response.json({ due, dead });
};
