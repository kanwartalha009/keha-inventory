/**
 * GDPR / privacy-law compliance (spec §10, §14).
 *
 * Keha Inventory Planner stores NO shopper personal data: sales, stock and
 * visits are aggregated by variant, day and location (ShopifyQL), and the app
 * requests no order or customer scopes. The handlers still do their job:
 *
 *   - customers/data_request → deliverDataRequest: logs the request in the
 *                              access log (the answer: the app holds no data
 *                              about the customer); with an email provider it
 *                              also tells the store owner so by email
 *   - customers/redact       → redactCustomer: removes delivered Nova outbox
 *                              copies that still carry the customer's email
 *                              (the compliance forward itself)
 *   - shop/redact + purge-uninstalled → purgeShopData (hard-delete every table
 *                              with a `shop` column, derived from the Prisma
 *                              schema, plus Shop by domain, plus the compact
 *                              fact tables keyed by Shop.num — first, while the
 *                              Shop row still gives the number); a reinstall
 *                              cancels the pending 48h purge
 */
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { emailForms, type GdprCustomer } from "../lib/gdpr-shared";
import { sendEmail, emailTransportConfigured } from "./email.server";
import { getShopContact } from "./shop-contact.server";
import { cancelPendingPurge } from "./purge-stamp.server";
import { logPersonalDataAccess } from "./pii-log.server";
import { factsStore } from "./facts-store.server";
import { sampleKey } from "../lib/sample-mode-shared";

export { cancelPendingPurge } from "./purge-stamp.server";

export { emailForms } from "../lib/gdpr-shared";

export type GdprRequest = {
  customer?: GdprCustomer | null;
  /** customers/redact */
  orders_to_redact?: (number | string)[] | null;
  /** customers/data_request */
  orders_requested?: (number | string)[] | null;
};

// ---- customers/data_request ----

/** Plain-text email body for the store owner. Exported for tests. */
export function dataRequestEmailText(shop: string, customer: GdprCustomer | null | undefined, requestId: string | null): string {
  const who = customer?.email || customer?.phone || String(customer?.id ?? "unknown");
  return [
    `A customer data request was received for ${shop}${requestId ? ` (request ${requestId})` : ""}.`,
    "",
    `Customer: ${who}`,
    "",
    "Keha Inventory Planner stores no personal data about this customer. It only keeps",
    "sales, stock and store-visit totals per product, day and location, with no customer details.",
    "You don't need to send the customer anything from this app.",
  ].join("\n");
}

/**
 * Answer a data request (Shopify: the app must give the merchant the customer's data — here,
 * that there is none). The answer is complete without email (owner decision 2026-10-18: no email
 * provider by default): the request is recorded in the access log with 0 records, and the Nova
 * platform keeps the forwarded request until it is closed. With a provider configured, the store
 * owner also gets an email saying no data is held. Never throws.
 *
 * `delivered`: "logged" (no provider: the access-log entry is the answer — an info line, not an
 * error) or "emailed".
 */
export async function deliverDataRequest(
  shop: string,
  req: GdprRequest & { data_request?: { id?: number | string | null } | null },
): Promise<{ ok: boolean; delivered?: "logged" | "emailed"; reason?: string }> {
  try {
    await logPersonalDataAccess({ shop, actor: "system", action: "gdpr_export", resource: "customer_data_request", records: 0 });
    if (!emailTransportConfigured()) {
      console.info(`[gdpr] data_request for ${shop}: no customer data held; recorded in the access log (no email provider, nothing to email)`);
      return { ok: true, delivered: "logged" };
    }
    const contact = await getShopContact(shop);
    const to = contact?.ownerEmail || contact?.contactEmail || "";
    if (!to) {
      console.error(`[gdpr] data_request not emailed: no owner email for ${shop}`);
      return { ok: false, reason: "no_recipient" };
    }
    const reqId = req.data_request?.id != null ? String(req.data_request.id) : null;
    const r = await sendEmail({
      to,
      subject: `Customer data request — Keha Inventory Planner (${shop})`,
      text: dataRequestEmailText(shop, req.customer, reqId),
    });
    if (!r.ok) console.error(`[gdpr] data_request email failed: ${r.reason}`);
    return r.ok ? { ok: true, delivered: "emailed" } : { ok: false, reason: r.reason };
  } catch (e) {
    console.error("[gdpr] data_request failed", e);
    return { ok: false, reason: String(e) };
  }
}

// ---- customers/redact ----
export async function redactCustomer(shop: string, req: GdprRequest): Promise<{ outboxDeleted: number }> {
  // Delivered / dead Nova outbox copies that still carry the email. PENDING
  // rows are kept so the compliance forward itself still reaches the platform.
  const emails = emailForms(req.customer?.email);
  const ox = emails.length
    ? await prisma.novaOutbox
        .deleteMany({
          where: {
            status: { in: ["SENT", "DEAD"] },
            OR: emails.map((e) => ({ body: { contains: JSON.stringify(e) } })),
          },
        })
        .catch((e) => {
          console.error(`[gdpr] outbox redact failed for ${shop}`, e);
          return { count: 0 };
        })
    : { count: 0 };
  return { outboxDeleted: ox.count };
}

// ---- shop/redact + purge-uninstalled: hard-delete all shop-scoped data ----

/**
 * Models that carry a `shop` column but are NOT purged here:
 *  - UninstalledShop is the purge bookkeeping itself (purgeDueShops stamps purgedAt on it
 *    after the purge; shop/redact removes it explicitly). Keeping it is the audit trail.
 */
export const PURGE_KEEP = ["UninstalledShop"] as const;

/** Prisma delegate name for a model (`SalesDaily` → `salesDaily`). */
export function delegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/**
 * Every model to purge, from the generated schema (invariant I-3): each model with a `shop`
 * field keyed by `shop`, plus `Shop` keyed by `domain`. Session comes last; NovaOutbox (no
 * shop column) is handled separately. A new table is covered the moment it has `shop`.
 */
export function purgePlan(): { model: string; key: "shop" | "domain" }[] {
  const models = Prisma.dmmf.datamodel.models;
  const keep = new Set<string>(PURGE_KEEP);
  const plan: { model: string; key: "shop" | "domain" }[] = [];
  for (const m of models) {
    if (keep.has(m.name) || m.name === "Session") continue;
    if (m.fields.some((f) => f.name === "shop")) plan.push({ model: m.name, key: "shop" });
    else if (m.name === "Shop") plan.push({ model: m.name, key: "domain" });
  }
  if (models.some((m) => m.name === "Session")) plan.push({ model: "Session", key: "shop" });
  return plan;
}

/** A shop purge left rows behind (some table delete failed): retried, never stamped done. */
export class PurgeIncompleteError extends Error {
  readonly counts: Record<string, number>;
  constructor(shop: string, counts: Record<string, number>) {
    const failed = Object.entries(counts)
      .filter(([, n]) => n < 0)
      .map(([t]) => t);
    super(`purge of ${shop} incomplete: ${failed.join(", ")} failed`);
    this.name = "PurgeIncompleteError";
    this.counts = counts;
  }
}

type DeleteManyDelegate = { deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }> };

/**
 * Hard-deletes every shop-scoped row. Throws PurgeIncompleteError when any table delete
 * failed, so callers never record the purge as done (purgeDueShops retries next tick,
 * shop/redact answers 500 and Shopify retries).
 */
export async function purgeShopData(shop: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const del = async (label: string, fn: () => Promise<{ count: number }>) => {
    try {
      counts[label] = (await fn()).count;
    } catch (e) {
      console.error(`[gdpr] purge ${label} failed for ${shop}`, e);
      counts[label] = -1;
    }
  };
  const quoted = JSON.stringify(shop); // exact JSON string match, e.g. "a.myshopify.com"
  const client = prisma as unknown as Record<string, DeleteManyDelegate>;

  // The compact daily facts (SalesFact, StockMonth, SessionsFact) carry Shop.num, not the domain:
  // purged first (partition by partition, in batches), while the Shop row still holds the number.
  await del("facts", async () => ({ count: await factsStore().purgeShop(shop) }));
  const plan = purgePlan();
  const session = plan.pop()!; // Session is last in the plan
  for (const { model, key } of plan) {
    const name = delegateName(model);
    await del(name, () => client[name].deleteMany({ where: { [key]: shop } }));
  }
  // The store's sample data (`<shop>#sample`, lib/sample-mode-shared) goes with it.
  for (const [name, n] of Object.entries(await purgeSampleData(shop, plan))) counts[`sample:${name}`] = n;
  // Nova outbox has no shop column: match the shop header / body field. PENDING
  // rows stay so the uninstall / shop-redact forwards still reach the platform.
  await del("novaOutbox", () =>
    prisma.novaOutbox.deleteMany({
      where: {
        status: { in: ["SENT", "DEAD"] },
        OR: [{ headers: { contains: quoted } }, { body: { contains: quoted } }],
      },
    }),
  );
  // Sessions last, and only when everything above succeeded: on a failure the shop can
  // still be reached, and the purge is retried (review M).
  if (Object.values(counts).some((n) => n < 0)) throw new PurgeIncompleteError(shop, counts);
  await del(delegateName(session.model), () => client[delegateName(session.model)].deleteMany({ where: { shop } }));
  if (counts[delegateName(session.model)] < 0) throw new PurgeIncompleteError(shop, counts);
  return counts;
}

/**
 * Deletes a store's sample data: every row keyed by `<shop>#sample` in every purged model (Shop by
 * domain; sample data has no sessions). Used by "Switch to my store" and by every shop purge.
 * Never throws; a failed table counts -1 (purgeShopData then throws PurgeIncompleteError).
 */
export async function purgeSampleData(shop: string, plan = purgePlan()): Promise<Record<string, number>> {
  const key = sampleKey(shop);
  const client = prisma as unknown as Record<string, DeleteManyDelegate>;
  const counts: Record<string, number> = {};
  // The sample's compact facts are keyed by its Shop row's number: purged before that row goes.
  try {
    counts.facts = await factsStore().purgeShop(key);
  } catch (e) {
    console.error(`[gdpr] sample purge facts failed for ${shop}`, e);
    counts.facts = -1;
  }
  for (const { model, key: column } of plan) {
    if (model === "Session") continue;
    const name = delegateName(model);
    try {
      counts[name] = (await client[name].deleteMany({ where: { [column]: key } })).count;
    } catch (e) {
      console.error(`[gdpr] sample purge ${name} failed for ${shop}`, e);
      counts[name] = -1;
    }
  }
  return counts;
}

// ---- 48h purge after uninstall (cron route + in-process scheduler) ----
export const PURGE_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * Purge every shop uninstalled more than 48h ago. A shop that has a session
 * again was reinstalled (uninstall deletes its sessions), so its purge is
 * cancelled instead — belt and braces next to cancelPendingPurge.
 */
export async function purgeDueShops(now = new Date()): Promise<{ shop: string; counts: Record<string, number> }[]> {
  const cutoff = new Date(now.getTime() - PURGE_AFTER_MS);
  const due = await prisma.uninstalledShop.findMany({
    where: { purgedAt: null, uninstalledAt: { lt: cutoff } },
  });
  const results: { shop: string; counts: Record<string, number> }[] = [];
  for (const row of due) {
    const live = await prisma.session.count({ where: { shop: row.shop } });
    if (live > 0) {
      await cancelPendingPurge(row.shop);
      console.log(`[gdpr] purge cancelled for ${row.shop} — reinstalled`);
      continue;
    }
    let counts: Record<string, number>;
    try {
      counts = await purgeShopData(row.shop);
    } catch (e) {
      // Not stamped: the next tick retries this shop.
      console.error(`[gdpr] purge of ${row.shop} incomplete, retrying next tick`, e);
      continue;
    }
    await prisma.uninstalledShop.update({ where: { shop: row.shop }, data: { purgedAt: new Date() } });
    results.push({ shop: row.shop, counts });
  }
  return results;
}

/** Dry run for the cron GET: shops due for purge. */
export async function shopsDueForPurge(now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - PURGE_AFTER_MS);
  const due = await prisma.uninstalledShop.findMany({
    where: { purgedAt: null, uninstalledAt: { lt: cutoff } },
  });
  return due.map((d) => d.shop);
}
