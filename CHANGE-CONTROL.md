# Change control — Keha Inventory Intelligence

Classify every change before coding:

- **C1 — module-internal.** No other module or contract changes.
- **C2 — contract change.** A route, query, table, env var, plan gate, Nova payload or webhook changes:
  list every consumer and update them in the same commit.
- **C3 — architecture.** Stop, write an impact report, get Kanwar's approval.

## Invariants

| # | Invariant | Enforced by |
|---|---|---|
| I-1 | Nothing changes the merchant's store without an explicit confirm (discounts, transfers). | code review, SSR tests |
| I-2 | No shopper personal data is stored; ShopifyQL queries never select customer fields. | review, `gdpr.test.ts` |
| I-3 | Every table with a `shop` column is purged on `shop/redact` and 48 h after uninstall. | `gdpr.test.ts` |
| I-4 | Schema changes go through `prisma migrate` (add-only). Never `db push`. | `migrations.test.ts` |
| I-5 | Missing data shows "—", never 0; no hard-coded numbers in the UI. | engine + SSR tests |
| I-6 | Plan checks fail open: unknown plan locks nothing. Plan locks teach, they don't hide. | `plans.test.ts` |
| I-7 | Admin API 2026-10 pinned in every place; queries validated against that schema. | `config.test.ts` |
| I-8 | Scopes in both tomls equal `SCOPES` in `.env.example`; only scopes the code uses. | `config.test.ts` |
| I-9 | `.env.example` lists exactly the env vars the code reads. | `config.test.ts` |
| I-10 | Every visible admin string is translated into all 8 languages. | `i18n-coverage.test.ts` |
| I-11 | Webhook handlers are idempotent; Nova topics are forwarded in slash form. | `nova-outbox.test.ts` |
| I-12 | Daily fact tables store only yesterday and older (`UNTIL -1d`). | sync tests (task 1.4) |
| I-13 | No feature loss: simplify by defaults, grouping and disclosure, never by deletion. | review |
