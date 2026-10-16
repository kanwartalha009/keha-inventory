# Keha Inventory ⇄ Nova platform — integration contract

> Defined by the Keha Inventory app (slug `inventory`) (sending side, implemented in `app/lib/nova.server.ts`).
> The platform's receiving endpoints (`apps/api`) MUST verify to match this.
> Resolves the spec contradiction between build pack §5.2 and `docs/02-modules/webhooks.md`
> (see "Reconciliation" below). Change class: **C2** (touches the platform).

## Signature scheme (both endpoints)

```
X-Nova-Signature: sha256=<hex HMAC-SHA256(rawRequestBody, secret)>
```

Verify on the platform by recomputing the HMAC over the **exact received raw body** with the
endpoint's secret and comparing in constant time. Reject **401** on mismatch.

## 1. Install-confirm

```
POST {NOVA_API}/v1/internal/installations/confirm
secret: NOVA_INSTALL_CONFIRM_SECRET
body:   { "shopDomain": string, "appSlug": "inventory", "planName"?: string, "installedAt": ISO8601 }
```
Platform: upsert the Installation → `ACTIVE`, lock the immutable `agencyId` referral, record the
plan. Return 200 on success. (installations.md)

## 2. Webhook ingress (lifecycle + GDPR)

```
POST {NOVA_API}/v1/webhooks/shopify/inventory
secret:  NOVA_INGRESS_HMAC_SECRET
headers: X-Nova-Topic: <shopify topic, slash form e.g. app/uninstalled>
         X-Nova-Shop-Domain: <shop domain>
         X-Shopify-Webhook-Id: <id>   # dedupe / externalId
body:    the Shopify webhook payload as JSON
```
Forwarded topics: `app/uninstalled`, `app_subscriptions/update` (synthetic — sent by
`app/services/app-pricing.server.ts` when the Partner API plan check sees a change; Shopify App
Pricing sends no subscription webhooks), `customers/data_request`,
`customers/redact`, `shop/redact`. Platform: store `WebhookEvent` (externalId =
`X-Shopify-Webhook-Id`), return 200 immediately, process async, route by `X-Nova-Topic`. (webhooks.md)

## Reconciliation (C2 — apply on the platform side)

`docs/02-modules/webhooks.md` currently says the ingress verifies "against that app's **Shopify**
webhook secret." This contract **supersedes** that: the forward is **Nova-signed** with
`NOVA_INGRESS_HMAC_SECRET` (not a Shopify-HMAC passthrough), so the platform doesn't need the
app's Shopify secret to verify forwards. Update `webhooks.md` + `installations.md` to state the
`X-Nova-Signature` scheme and the two secrets.

## Status (inherited from the Encore kit, 2026-10-16 — re-verify at the Phase 2 E2E)

App **sending** side: **implemented** — all calls go through the durable `NovaOutbox`
(`app/lib/nova.server.ts` enqueue → `/cron/nova-outbox` flush with retry/backoff), never
fire-and-forget. The synthetic `app_subscriptions/update` carries the `_nova` price/status/period enrichment.

Platform **receiving** side: **built + live** (not placeholders) —
`apps/api/.../installations/installations.internal.controller.ts` exposes `@Public POST
/v1/internal/installations/confirm` (HMAC via `verifyNovaSignature`), setting the Installation
`ACTIVE` + locking the immutable `agencyId`; `apps/api/.../webhooks/webhooks.controller.ts`
exposes the `@Public POST /v1/webhooks/shopify/:appSlug` ingress → `billing.recordFromWebhook`
creates the `Charge` (idempotent on `X-Shopify-Webhook-Id`) → agency `Commission`.

**Remaining verification for this app:** register `inventory` in the Nova admin with plans
`free`, `growth`, `pro`, then run the money-path test (referral install → plan → 1 Charge +
1 Commission in Nova admin → redact → uninstall stops accrual) on a dev store.
