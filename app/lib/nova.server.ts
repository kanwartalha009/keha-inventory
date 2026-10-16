import crypto from "node:crypto";
import prisma from "../db.server";

/**
 * Nova platform integration — SENDING side (build pack §5).
 *
 * Signing contract (defined here; platform endpoints MUST verify to match —
 * see NOVA-INTEGRATION-CONTRACT.md):
 *   header  X-Nova-Signature: sha256=<hex HMAC-SHA256(rawBody, secret)>
 *   install-confirm  secret = NOVA_INSTALL_CONFIRM_SECRET
 *   ingress          secret = NOVA_INGRESS_HMAC_SECRET
 *
 * DURABLE delivery (GO-LIVE-AUDIT P1): every call is written to the NovaOutbox BEFORE the network
 * hop, then delivered best-effort immediately; /cron/nova-outbox retries PENDING rows with backoff.
 * A blip can never silently lose attribution or a commission. Safe to retry — Nova dedupes
 * (install-confirm idempotent by app+store; ingress idempotent by X-Shopify-Webhook-Id).
 * If NOVA_API is unset (local dev without the platform) it no-ops.
 */

const NOVA_API = process.env.NOVA_API ?? "";
const APP_SLUG = "inventory";
const MAX_ATTEMPTS = 12;
// Time limits (2026-09-28). The first delivery attempt runs inside Shopify
// webhook handlers (uninstall, GDPR, billing) and in afterAuth, where Shopify
// allows 5 seconds in total; an unreachable Nova used to hang them until the
// network gave up. The row is already in the outbox, so a timed-out attempt is
// simply retried by the scheduler with the longer limit.
export const IMMEDIATE_TIMEOUT_MS = 2500;
export const RETRY_TIMEOUT_MS = 10000;

function sign(secret: string, body: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

// Exponential backoff: 1m, 2m, 4m … capped at 6h.
export function backoffMs(attempts: number): number { // exported for tests
  return Math.min(6 * 60 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attempts - 1));
}

type OutboxRow = { id: string; url: string; body: string; headers: string; attempts: number };

const outbox = prisma.novaOutbox;

/** Deliver one outbox row. Marks SENT on success; backs off (or DEAD past MAX_ATTEMPTS) on failure. */
async function deliver(row: OutboxRow, timeoutMs = RETRY_TIMEOUT_MS): Promise<boolean> {
  try {
    const extra = JSON.parse(row.headers || "{}") as Record<string, string>;
    const res = await fetch(row.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extra },
      body: row.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Delivered → drop the payload (it can carry customer emails from GDPR
    // forwards); the row stays as the delivery record.
    await outbox.update({ where: { id: row.id }, data: { status: "SENT", sentAt: new Date(), lastError: null, body: "" } });
    return true;
  } catch (err) {
    const attempts = row.attempts + 1;
    const status = attempts >= MAX_ATTEMPTS ? "DEAD" : "PENDING";
    await outbox.update({
      where: { id: row.id },
      data: { attempts, status, lastError: String(err), nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) },
    });
    if (status === "DEAD") console.error(`[inventory/nova] outbox ${row.id} DEAD after ${attempts} attempts: ${String(err)}`);
    return false;
  }
}

async function enqueue(
  kind: "confirm" | "ingress" | "support",
  url: string,
  body: string,
  signature: string,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  if (!NOVA_API) {
    console.warn(`[inventory/nova] NOVA_API unset — skipping ${kind}`);
    return;
  }
  const headers = JSON.stringify({ "X-Nova-Signature": signature, ...extraHeaders });
  let id: string;
  try {
    ({ id } = await outbox.create({ data: { kind, url, body, headers } }));
  } catch (err) {
    // Outbox write itself failed → best-effort direct send so the event isn't lost entirely.
    console.error("[inventory/nova] outbox enqueue failed; direct send", err);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Nova-Signature": signature, ...extraHeaders },
        body,
        signal: AbortSignal.timeout(IMMEDIATE_TIMEOUT_MS),
      });
    } catch (e) {
      console.error("[inventory/nova] direct send also failed", e);
    }
    return;
  }
  // Best-effort immediate delivery; the cron retries if this attempt fails.
  await deliver({ id, url, body, headers, attempts: 0 }, IMMEDIATE_TIMEOUT_MS);
}

/**
 * Data minimisation (2026-09-28), hourly: clear the payload of rows delivered
 * before payloads were dropped on send, and delete delivery records older than
 * 30 days (keeps the table — and GDPR lookups over it — small). PENDING and
 * DEAD rows are never touched. Returns rows cleared + deleted.
 */
export const SENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export async function scrubDeliveredOutbox(now = new Date()): Promise<number> {
  try {
    const ob = prisma.novaOutbox;
    const r = await ob.updateMany({ where: { status: "SENT", NOT: { body: "" } }, data: { body: "" } });
    const d = await ob.deleteMany({
      where: { status: "SENT", sentAt: { lt: new Date(now.getTime() - SENT_RETENTION_MS) } },
    });
    return r.count + d.count;
  } catch (e) {
    console.error("[inventory/nova] outbox scrub failed", e);
    return 0;
  }
}

/** Drain due outbox rows. Wire to a scheduler via POST /cron/nova-outbox. */
export async function flushOutbox(limit = 50): Promise<{ sent: number; failed: number; processed: number }> {
  if (!NOVA_API) return { sent: 0, failed: 0, processed: 0 };
  const due = await outbox.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });
  let sent = 0, failed = 0;
  for (const row of due) {
    if (await deliver(row)) sent++;
    else failed++;
  }
  return { sent, failed, processed: due.length };
}

/** Install-confirm — flips the platform Installation to ACTIVE + locks referral (build pack §5.1).
 *  `ref` (agency slug from the referral link) is the automatic attribution path: it provisions a
 *  brand-new store under the referring agency. Immutable once set (Nova invariant I-8). */
export async function confirmInstall(input: {
  shopDomain: string;
  planName?: string;
  installedAt: string;
  ref?: string;
}): Promise<void> {
  const secret = process.env.NOVA_INSTALL_CONFIRM_SECRET ?? "";
  const body = JSON.stringify({
    shopDomain: input.shopDomain,
    appSlug: APP_SLUG,
    planName: input.planName,
    installedAt: input.installedAt,
    ref: input.ref,
  });
  await enqueue("confirm", `${NOVA_API}/v1/internal/installations/confirm`, body, sign(secret, body));
}

/** Forward a lifecycle/GDPR webhook to the platform ingress (billing source of truth, §5.2). */
/**
 * Nova matches webhook topics in Shopify's slash form ("app/uninstalled",
 * "customers/redact"), as NOVA-INTEGRATION-CONTRACT.md says. The Shopify
 * library hands routes the storage form ("APP_UNINSTALLED"), which Nova
 * silently ignored — uninstalls were never recorded and the GDPR handlers
 * never ran (platform audit 2026-10-11). Forward the slash form.
 */
const NOVA_TOPICS: Record<string, string> = {
  APP_UNINSTALLED: "app/uninstalled",
  APP_SCOPES_UPDATE: "app/scopes_update",
  APP_SUBSCRIPTIONS_UPDATE: "app_subscriptions/update",
  CUSTOMERS_DATA_REQUEST: "customers/data_request",
  CUSTOMERS_REDACT: "customers/redact",
  SHOP_REDACT: "shop/redact",
};
export function novaTopic(topic: string): string {
  const t = String(topic ?? "").trim();
  if (t.includes("/")) return t.toLowerCase();
  return NOVA_TOPICS[t.toUpperCase()] ?? t.toLowerCase();
}

export async function forwardToIngress(input: {
  topic: string;
  shopDomain: string;
  webhookId: string | null;
  payload: unknown;
}): Promise<void> {
  const secret = process.env.NOVA_INGRESS_HMAC_SECRET ?? "";
  const body = JSON.stringify(input.payload ?? {});
  await enqueue("ingress", `${NOVA_API}/v1/webhooks/shopify/${APP_SLUG}`, body, sign(secret, body), {
    "X-Nova-Topic": novaTopic(input.topic),
    "X-Nova-Shop-Domain": input.shopDomain,
    ...(input.webhookId ? { "X-Shopify-Webhook-Id": input.webhookId } : {}),
  });
}

/** Get-help ticket → platform support ingress (⇄ platform N4). Queued via the outbox so it
 *  ships even if the platform endpoint lands later. Idempotency/dedupe is Nova's concern. */
export async function sendSupportTicket(input: {
  shopDomain: string;
  subject: string;
  message: string;
  email?: string;
}): Promise<void> {
  const secret = process.env.NOVA_INGRESS_HMAC_SECRET ?? "";
  // Field names must match Nova's internalTicketSchema: `shop` + `body`. Sending shopDomain/message
  // (and `email: null`, which zod's .optional() rejects) 422'd every ticket into a dead outbox while
  // the merchant saw "message sent" — audit 2026-07-12, A1. Nova now accepts both spellings; this
  // sends the canonical one. Omit email entirely rather than sending null.
  const body = JSON.stringify({
    appSlug: APP_SLUG,
    shop: input.shopDomain,
    subject: input.subject,
    body: input.message,
    ...(input.email ? { email: input.email } : {}),
    source: "APP",
    createdAt: new Date().toISOString(),
  });
  await enqueue("support", `${NOVA_API}/v1/internal/support/tickets`, body, sign(secret, body));
}

const ACTIVE_SUBS_QUERY = `#graphql
  query NovaActiveSubs {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        currentPeriodEnd
        lineItems {
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing { price { amount currencyCode } interval }
            }
          }
        }
      }
    }
  }`;

/**
 * Build the `_nova` enrichment attached to a forwarded app_subscriptions/update webhook.
 *
 * WHY: the Shopify webhook payload carries NO amount, and Shopify fires NO per-cycle charge webhook
 * (confirmed in the billing docs). So Nova cannot derive revenue from the webhook alone. Here we read
 * the AUTHORITATIVE price/status/period from the Admin API (currentAppInstallation.activeSubscriptions)
 * and hand it to Nova, which records one Charge per cycle and stops the moment status ≠ ACTIVE.
 *
 * Status is taken from the webhook payload (authoritative for CANCELLED/FROZEN/etc.); price + period
 * are taken from the Admin API and only while ACTIVE. Resilient — any failure leaves amount null and
 * Nova falls back to the installed plan's price.
 */
export async function buildSubscriptionEnrichment(
  // `any` to accept the Shopify AdminApiContext.graphql client (its typed options param doesn't
  // unify with a narrow signature); undefined when the webhook has no offline session.
  admin: any,
  payload: any,
): Promise<Record<string, unknown>> {
  const sub = payload?.app_subscription ?? {};
  const subscriptionId: string | null = sub.admin_graphql_api_id ?? null;
  const status: string | null = sub.status ?? null;

  let amountMinor: number | null = null;
  let currencyCode: string | null = null;
  let currentPeriodEnd: string | null = sub.current_period_end ?? null;
  let planName: string | null = sub.name ?? null;

  if (admin && (status == null || status === "ACTIVE")) {
    try {
      const res = await admin.graphql(ACTIVE_SUBS_QUERY);
      const json: any = await res.json();
      const subs = json?.data?.currentAppInstallation?.activeSubscriptions ?? [];
      const match = subs.find((s: any) => s.id === subscriptionId) ?? subs[0];
      if (match) {
        planName = match.name ?? planName;
        currentPeriodEnd = match.currentPeriodEnd ?? currentPeriodEnd;
        const pricing = (match.lineItems ?? [])
          .map((li: any) => li?.plan?.pricingDetails)
          .find((pd: any) => pd?.__typename === "AppRecurringPricing");
        const amt = pricing?.price?.amount;
        if (amt != null) amountMinor = Math.round(parseFloat(String(amt)) * 100);
        currencyCode = pricing?.price?.currencyCode ?? currencyCode;
      }
    } catch (err) {
      console.error("[inventory/nova] active-subscription enrichment failed", err);
    }
  }

  return { subscriptionId, status, amountMinor, currencyCode, currentPeriodEnd, planName };
}
