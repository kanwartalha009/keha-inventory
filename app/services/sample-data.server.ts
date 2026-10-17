/**
 * Sample data (owner 2026-10-17): every database write of a simulated store, in ONE module, so it
 * follows the sync's tables wherever they go.
 *
 *  - writeSimStore(key, store): a simulated store (lib/sim) written under a data key the way the
 *    sync writes a real one — the catalog writers (upsertVariants, upsertCollections,
 *    upsertLocation) and, for the daily facts, the sync's own storeHistory per calendar month and
 *    dataset, reading a ShopifyQL client that answers from the simulation (lib/sim/sim-rows-shared).
 *    Then suppliers, stock now and purchase orders, and a Shop row whose backfill is complete.
 *    Used by the in-app sample mode and the end-to-end simulation tests (tests/e2e-sim).
 *  - loadSampleData(shop): a fresh small (S) store under `<shop>#sample`, computed, and the switch
 *    on the real Shop row turned on. Nothing is read from or written to Shopify.
 *  - removeSampleData(shop): the switch off and every `<shop>#sample` row deleted (the same purge
 *    shop/redact and the 48 h uninstall purge run, services/gdpr.server).
 */
import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { upsertCollections, upsertLocation, upsertVariants } from "./sync/catalog.server";
import { storeHistory } from "./sync/facts.server";
import type { ShopifyqlClient } from "./sync/shopifyql.server";
import { computeShop } from "./compute.server";
import { purgeSampleData } from "./gdpr.server";
import { forgetOrderPlan } from "../models/plan-cache.server";
import { simulateStore, type SimOptions, type SimStore } from "../lib/sim/store-sim-shared";
import {
  simCollectionRows,
  simLocationRows,
  simMonths,
  simPurchaseOrderRows,
  simShopifyql,
  simStockNowRows,
  simSupplierRows,
  simVariantOwnFields,
  simVariantRows,
} from "../lib/sim/sim-rows-shared";
import { HISTORY_DATASETS, SYNC_DATASETS, type BackfillState, type SyncDataset } from "../lib/sync/backfill-shared";
import { localDate, safeTimeZone } from "../lib/sync/store-time-shared";
import { hash32 } from "../lib/sim/rng-shared";
import { isSampleKey, readSampleState, sampleIdPrefix, sampleKey, type SampleState } from "../lib/sample-mode-shared";

const BATCH = 5000;

export type WriteReport = {
  variants: number;
  stockNow: number;
  suppliers: number;
  purchaseOrders: number;
  /** Fact rows per dataset, as storeHistory reported them. */
  facts: Record<string, number>;
};

async function inBatches<T>(rows: readonly T[], write: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) await write(rows.slice(i, i + BATCH));
}

/** A backfill state that says every dataset is read through yesterday. */
export function completeBackfill(store: SimStore, now: Date): BackfillState {
  const months = simMonths(store).length;
  const at = now.toISOString();
  const datasets: BackfillState["datasets"] = {};
  for (const d of SYNC_DATASETS as readonly SyncDataset[]) {
    datasets[d] =
      d === "products"
        ? { done: 1, total: 1, finishedAt: at }
        : { done: months, total: months, doneThrough: store.meta.from, syncedThrough: store.meta.yesterday, finishedAt: at };
  }
  return { startedAt: at, finishedAt: at, first90Ready: true, range: { from: store.meta.from, until: store.meta.yesterday }, syncedThrough: store.meta.yesterday, datasets };
}

/**
 * Writes a simulated store under `key` (replacing nothing: call on an empty key). The daily facts
 * go through the sync's storeHistory, month by month, like a backfill.
 */
export async function writeSimStore(key: string, store: SimStore, opts: { now: Date; settings?: Record<string, unknown> }): Promise<WriteReport> {
  const now = opts.now;
  // Ids are global keys (as Shopify's): never write over another store's rows.
  const taken = await prisma.variant.findFirst({ where: { id: { in: store.variants.map((v) => v.id) }, NOT: { shop: key } }, select: { id: true, shop: true } });
  if (taken) throw new Error(`sample data: id ${taken.id} already belongs to another store`);
  const settings = {
    // Setup done, so the sample Dashboard shows the product rather than the setup guide.
    leadTimeDays: 21,
    leadTimeConfirmedAt: now.toISOString(),
    cycleDays: 14,
    mondayEmail: { enabled: true, recipients: [] },
    alerts: { instant: false, slackWebhook: null, slackMonday: false, slackError: null },
    ...(opts.settings ?? {}),
  };
  const shopData = {
    currency: store.meta.currency,
    timezone: store.meta.timezone,
    locale: store.meta.locale,
    settings: settings as Prisma.InputJsonValue,
    backfillState: completeBackfill(store, now) as unknown as Prisma.InputJsonValue,
    lastNightlyAt: now,
    uninstalledAt: null,
    factDaysAt: null,
  };
  await prisma.shop.upsert({ where: { domain: key }, create: { domain: key, ...shopData }, update: shopData });

  // Catalog: the sync's writers.
  for (const l of simLocationRows(store)) {
    await upsertLocation(key, l);
    await prisma.location.update({ where: { id: l.id }, data: { role: l.role } });
  }
  await upsertCollections(key, simCollectionRows(store));
  const variants = simVariantRows(store);
  await upsertVariants(key, variants);
  // Keha's own fields (never written by the catalog sync).
  const own = simVariantOwnFields(store);
  const bySupplier = new Map<string, string[]>();
  for (const v of own) if (v.supplierId) (bySupplier.get(v.supplierId) ?? bySupplier.set(v.supplierId, []).get(v.supplierId)!).push(v.id);
  for (const [supplierId, ids] of bySupplier) await prisma.variant.updateMany({ where: { shop: key, id: { in: ids } }, data: { supplierId } });
  const noReorder = own.filter((v) => v.noReorder).map((v) => v.id);
  if (noReorder.length) await prisma.variant.updateMany({ where: { shop: key, id: { in: noReorder } }, data: { noReorder: true } });
  const byCase = new Map<number, string[]>();
  for (const v of own) if (v.caseQty) (byCase.get(v.caseQty) ?? byCase.set(v.caseQty, []).get(v.caseQty)!).push(v.id);
  for (const [caseQty, ids] of byCase) await prisma.variant.updateMany({ where: { shop: key, id: { in: ids } }, data: { caseQty } });

  const suppliers = simSupplierRows(store);
  await prisma.supplier.createMany({ data: suppliers.map((s) => ({ ...s, shop: key, email: null })) });

  const stockNow = simStockNowRows(store);
  await inBatches(stockNow, (b) => prisma.stockNow.createMany({ data: b.map((r) => ({ shop: key, ...r })) }));

  // Daily facts: the sync's own writer, a calendar month at a time (newest first, as the backfill).
  const ql = simShopifyql(store) as unknown as ShopifyqlClient;
  const locations = simLocationRows(store).map((l) => ({ id: l.id, name: l.name, active: l.active }));
  const facts: Record<string, number> = {};
  for (const month of simMonths(store).reverse()) {
    for (const dataset of HISTORY_DATASETS) {
      const r = await storeHistory(dataset, key, ql, month, store.meta.today, locations);
      facts[dataset] = (facts[dataset] ?? 0) + r.rows;
    }
  }

  const pos = simPurchaseOrderRows(store);
  await inBatches(pos, (b) =>
    prisma.purchaseOrder.createMany({
      data: b.map((o) => ({
        id: o.id,
        shop: key,
        supplierId: o.supplierId,
        status: o.status,
        number: o.number,
        lines: o.lines as unknown as Prisma.InputJsonValue,
        // Never a working supplier link: sample orders are not real orders.
        confirmToken: `sample-${crypto.randomBytes(18).toString("base64url")}`,
        confirmExpiresAt: o.sentAt ?? o.createdAt,
        confirmedShipDate: o.confirmedShipDate,
        expectedDate: o.expectedDate,
        source: o.source,
        shopifyPoId: o.shopifyPoId,
        supplierName: o.supplierName,
        currency: o.currency,
        note: null,
        sentAt: o.sentAt,
        receivedAt: o.receivedAt,
        cancelledAt: o.cancelledAt,
        createdAt: o.createdAt,
        updatedAt: o.receivedAt ?? o.cancelledAt ?? o.sentAt ?? o.createdAt,
      })),
    }),
  );
  forgetOrderPlan(key);
  return { variants: variants.length, stockNow: stockNow.length, suppliers: suppliers.length, purchaseOrders: pos.length, facts };
}

// ── In-app sample mode ─────────────────────────────────────────────────────────────────────

async function readSample(shop: string): Promise<{ settings: Record<string, unknown>; state: SampleState; currency: string; timezone: string; locale: string } | null> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { settings: true, currency: true, timezone: true, locale: true } });
  if (!row) return null;
  const settings = (row.settings && typeof row.settings === "object" ? row.settings : {}) as Record<string, unknown>;
  return { settings, state: readSampleState(settings), currency: row.currency, timezone: row.timezone, locale: row.locale };
}

async function writeState(shop: string, state: SampleState): Promise<void> {
  const cur = await readSample(shop);
  if (!cur) return;
  await prisma.shop.update({ where: { domain: shop }, data: { settings: { ...cur.settings, sampleData: state } as Prisma.InputJsonValue } });
}

/** An id prefix no other store's sample data uses (a variant id under it belongs to `key` or nobody). */
async function freePrefix(shop: string, key: string): Promise<string> {
  for (let salt = 0; salt < 20; salt++) {
    const prefix = sampleIdPrefix(shop, salt);
    const taken = await prisma.variant.findFirst({
      where: { id: { startsWith: `gid://shopify/ProductVariant/${prefix}` }, NOT: { shop: key } },
      select: { id: true },
    });
    if (!taken) return prefix;
  }
  throw new Error("sample data: no free id prefix");
}

export type SampleLoadResult = { ok: true; variants: number } | { ok: false; error: "notInstalled" | "failed" };

/** Options for tests: a smaller store (`products`), or no compute. */
export type SampleLoadOptions = { size?: SimOptions["size"]; products?: number; compute?: boolean };

/**
 * Loads a fresh simulated store (S) as `<shop>#sample`, computes it, and turns sample mode on.
 * Any earlier sample rows are removed first. Shopify is never called.
 */
export async function loadSampleData(shop: string, now: Date = new Date(), opts: SampleLoadOptions = {}): Promise<SampleLoadResult> {
  if (isSampleKey(shop)) return { ok: false, error: "failed" };
  // One load per store at a time (a double click must not purge a load in progress).
  if (loading.has(shop)) return { ok: false, error: "failed" };
  const real = await readSample(shop);
  if (!real) return { ok: false, error: "notInstalled" };
  const key = sampleKey(shop);
  loading.add(shop);
  try {
    await purgeSampleData(shop);
    const idPrefix = await freePrefix(shop, key);
    const tz = safeTimeZone(real.timezone);
    const store = simulateStore({
      size: opts.size ?? "S",
      products: opts.products,
      seed: hash32(shop),
      today: localDate(now, tz),
      idPrefix,
      currency: real.currency,
      timezone: tz,
      locale: real.locale,
    });
    const report = await writeSimStore(key, store, { now });
    if (opts.compute !== false) await computeShop(key, { now: () => now.getTime() });
    await writeState(shop, { on: true, loadedAt: now.toISOString(), idPrefix });
    return { ok: true, variants: report.variants };
  } catch (e) {
    console.error(`[sample] ${shop}: loading sample data failed`, e);
    await purgeSampleData(shop).catch(() => null);
    await writeState(shop, { on: false, loadedAt: null, idPrefix: null }).catch(() => null);
    return { ok: false, error: "failed" };
  } finally {
    loading.delete(shop);
  }
}

const loading = new Set<string>();

/** Turns sample mode off and deletes every sample row. */
export async function removeSampleData(shop: string): Promise<{ ok: boolean; removed: number }> {
  if (isSampleKey(shop)) return { ok: false, removed: 0 };
  await writeState(shop, { on: false, loadedAt: null, idPrefix: null });
  const counts = await purgeSampleData(shop);
  forgetOrderPlan(sampleKey(shop));
  return { ok: true, removed: Object.values(counts).reduce((a, n) => a + Math.max(0, n), 0) };
}
