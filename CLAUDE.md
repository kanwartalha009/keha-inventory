# Keha Inventory Planner — session anchor

Before any development work in this repo:

1. Read the plan of record and the playbook in the Nova Apps Platform project:
   `inventory-intelligence/KEHA-INVENTORY-INTELLIGENCE-SPEC-v1-2026-10-16.md` and
   `platform/KEHA-SHOPIFY-APP-PLAYBOOK-2026-10-16.md`.
2. Work phase by phase (spec §20) with a numbered task list; each task is commit-sized with an acceptance check.
3. After every task: `npm run typecheck && npx vitest run && npm run build`.
4. Pure logic goes in `app/lib/**/*-shared.ts` with fixture tests; every screen gets an SSR test; every
   visible string is translated into all 8 languages (tests/i18n-coverage.test.ts).
5. Validate every GraphQL / ShopifyQL query against the pinned 2026-10 schema before using it.
6. Numbers are measured, never recalled. Reports end with VERIFIED vs ASSUMED.
7. Feature Rule: anything not in the spec needs Kanwar's approval first (Why / How it helps / Easier? / Robust?).
8. Invariants: `CHANGE-CONTROL.md`.
