/**
 * GET /health — public liveness/health probe (promised in GO-LIVE-AND-TEST-GUIDE
 * §2/§8 but missing until 2026-09-01). Reports:
 *   - db:        can we run a trivial query
 *   - scheduler: has the in-process scheduler started, and when did the outbox
 *                timer last fire (should be < ~4 min ago once booted)
 *   - outbox:    PENDING / DEAD row counts (delivery backlog to the Nova backend)
 *   - pricing:   are plan checks configured, last success / error code (2026-10-13)
 *   - config:    booleans for settings the privacy policy relies on (2026-09-28):
 *                secrets encrypted at rest, shopper email sending, legal contact
 *
 * No auth by design (uptime monitors need it); exposes only booleans, counts
 * and timestamps — no shop data, no secrets.
 */
import prisma from "../db.server";
import { schedulerHeartbeat } from "../services/scheduler.server";
import { pricingStatus } from "../services/app-pricing.server";

const outbox = (
  prisma as unknown as {
    novaOutbox: { count(a: { where: Record<string, unknown> }): Promise<number> };
  }
).novaOutbox;

export const loader = async () => {
  const heartbeat = schedulerHeartbeat();

  let db = false;
  let pending = 0;
  let dead = 0;
  try {
    pending = await outbox.count({ where: { status: "PENDING" } });
    dead = await outbox.count({ where: { status: "DEAD" } });
    db = true;
  } catch {
    db = false;
  }

  // Degraded when the DB is down, or the scheduler stopped ticking (>10 min
  // since the last 2-minute outbox tick, once it has ticked at least once).
  const lastTick = heartbeat.lastOutboxTickAt
    ? Date.parse(heartbeat.lastOutboxTickAt)
    : null;
  const schedulerStale =
    heartbeat.started && lastTick !== null && Date.now() - lastTick > 10 * 60 * 1000;
  const ok = db && !schedulerStale;

  return Response.json(
    {
      status: ok ? "ok" : "degraded",
      db: db ? "ok" : "error",
      scheduler: heartbeat,
      outbox: { pending, dead },
      config: {
        secretsEncrypted: /^[0-9a-f]{64}$/i.test(process.env.APP_ENCRYPTION_KEY ?? ""),
        emailSending: Boolean(process.env.INVENTORY_EMAIL_API_KEY && process.env.INVENTORY_EMAIL_FROM),
        legalContact: Boolean(process.env.INVENTORY_SUPPORT_EMAIL),
        database: (process.env.DATABASE_URL ?? "").startsWith("postgres") ? "postgresql" : "other",
      },
      // Shopify App Pricing plan checks (Partner API): configured + last result.
      pricing: pricingStatus(),
      time: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
};
