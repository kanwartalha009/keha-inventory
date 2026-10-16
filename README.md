# Keha Inventory Intelligence

Shopify app: *every Monday, Keha tells you what to do with each product — reorder, push, fix or clear — and how much money is at stake.*

- **Plan of record:** `inventory-intelligence/KEHA-INVENTORY-INTELLIGENCE-SPEC-v1-2026-10-16.md` (Nova Apps Platform project).
- **Lessons and rules:** `platform/KEHA-SHOPIFY-APP-PLAYBOOK-2026-10-16.md` (same project).
- **Handle:** `keha-inventory` · **code slug:** `inventory` · **host:** `inventory.keha.io` · **Admin API:** 2026-10.
- **Plans:** Free / Growth $49 / Pro $99 (Shopify App Pricing handles `free`, `growth`, `pro`).

Built from the Encore (Keha Preorder) app kit (playbook §2): React Router 7, Polaris web components, Prisma + Postgres, Railway, vitest.

## Gates (run after every change)

```bash
npm run typecheck   # react-router typegen && tsc --noEmit
npx vitest run
npm run build       # the only gate that catches a .server import in client code
```

In a sandbox without the Prisma engines download:

```bash
PRISMA_SCHEMA_ENGINE_BINARY=/tmp/x PRISMA_QUERY_ENGINE_LIBRARY=/tmp/x \
PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 npx prisma generate --no-engine
```

## Database changes

Real migrations only (`prisma/migrations`; `tests/migrations.test.ts` fails if the schema and
migrations disagree). Railway runs `prisma migrate deploy` on boot (`npm run setup`).

- On a machine with Prisma engines and a local Postgres: `npx prisma migrate dev --name <change>`.
- Add-only: never drop or rename a column without an impact note and approval (CHANGE-CONTROL I-4).

## Layout

```
app/
  shopify.server.ts        auth, App Pricing hooks, apiVersion 2026-10
  routes/                  thin routes (admin screens, webhooks, cron, health, legal)
  lib/*-shared.ts          pure logic + types (client-safe, unit-tested)
  lib/engine/*-shared.ts   the forecasting engine (spec §7) — pure functions
  models/*.server.ts       per-entity DB and Admin API reads/writes
  services/*.server.ts     workflows: sync, compute, email, pricing, GDPR, scheduler
  components/              Polaris web-component UI
tests/                     vitest: unit, SSR per screen, contracts, translation coverage
```

## Config

- `shopify.app.toml` — production (never auto-updates URLs). `shopify.app.dev.toml` — the separate dev app.
- `.env.example` — every env var the code reads (a test keeps it in sync).
