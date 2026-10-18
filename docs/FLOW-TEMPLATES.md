# Shopify Flow templates — getting Keha's summaries by email without an email provider

Owner decision 2026-10-18: Keha uses **no paid email provider**. The app is complete without
`INVENTORY_EMAIL_API_KEY` / `INVENTORY_EMAIL_FROM`:

| What | How it reaches the merchant with no provider |
|---|---|
| Weekly summary | Flow trigger **Weekly order plan ready** (every plan, once per store week from Monday 08:00 store time) → the merchant's workflow with Flow's **Send internal email** action |
| "Your order plan is ready" (once) | Flow trigger **First order plan ready** (every plan, once per store) → Send internal email; plus the in-app notice on the Dashboard |
| Instant stock alerts | Flow trigger **Product needs reorder** (Growth; already existed) → Send internal email; Slack (Growth) as before |
| Purchase order to a supplier | **Open in your email** on the order page: a `mailto:` in the supplier's PO language, sent from the merchant's own address; then **Mark as ordered** |
| Customer data request | Answered in the access log (the app holds no customer data); no email needed |

The triggers are already in the app (`extensions/keha-inventory-flow/*.extension.toml`, fired by
`app/services/monday.server.ts`, `plan-ready.server.ts`, `alerts.server.ts`). What is missing is
**templates**: ready-made workflows a merchant can switch on in one click. A Flow template is an
app extension of type `flow_template` (one template per extension) whose `template.flow` file can
only be produced by **exporting a workflow from the Flow app** — it cannot be written by hand or
generated here. A `flow_template` extension without its `template.flow` breaks `shopify app deploy`
(the `module` file must exist), so the extension folders are **not** in `extensions/` yet; the
ready-to-copy toml and locale files are in `docs/flow-templates/`. `tests/flow-extensions.test.ts`
refuses any `flow_template` extension without its `template.flow`.

Templates go through **Shopify review** (the Flow team, "within three business days", per
shopify.dev "Flow template reference"). The review does not block the app version; until it is
approved the template simply isn't listed. The triggers work without templates — a merchant can
always build the workflow by hand (Settings → Alerts explains how).

## Before you start

- A dev store with Shopify Flow and the **released** app version that contains the two new triggers
  (`weekly-order-plan-ready`, `first-order-plan-ready`): `npm run deploy`, release the version, open
  the app once on the dev store.
- Shopify CLI ≥ 3.49 (the docs' minimum for Flow templates).

## 1. Build each workflow in the dev store

In the dev store: **Apps → Flow → Create workflow**. Build three workflows exactly as below. Field
names in Liquid are the trigger keys in camelCase (Flow converts `Summary text` → `summaryText`);
pick them from Flow's variable picker rather than typing, so the names are exactly what Flow uses.

### A. "Email me the weekly order plan" (trigger: Weekly order plan ready)

1. **Select a trigger** → search "Keha" → **Weekly order plan ready**.
2. **Add action** → **Send internal email**.
   - **Email address**: leave it as the store's own staff address the editor suggests, or empty.
     It can't use variables; Flow highlights it after a merchant installs the template so they type
     their own (shopify.dev: "leave the field blank" rather than a placeholder).
   - **Subject**: `{{ subject }}` (from the picker: Weekly order plan ready → Subject).
   - **Message**:
     ```
     {{ summaryText }}

     Orders due this week: {{ ordersDueThisWeek }}
     Cash due this week: {{ cashDueThisWeek }}

     Open the order plan: {{ orderPlanLink }}
     ```
     If the line breaks of `summaryText` come out as one paragraph in the test email, use
     `{{ summaryText | newline_to_br }}` instead (check this in step 2 — not verified here).
3. Optional (nice for review): **More actions → Add notes**: "Sends Keha's weekly summary to the
   addresses you enter. Change the email address before you turn it on."
4. Name it "Email me the weekly order plan", **Turn on**.

### B. "Email me when my first order plan is ready" (trigger: First order plan ready)

1. Trigger **First order plan ready**.
2. Action **Send internal email** — Email address as in A; Subject `{{ subject }}`; Message:
   ```
   {{ summaryText }}

   {{ orderPlanLink }}
   ```
3. Name it, turn it on.

### C. "Email me when a product needs a reorder" (trigger: Product needs reorder)

1. Trigger **Product needs reorder**.
2. Action **Send internal email** — Subject: `Reorder {{ product.title }} by {{ orderBy }}`;
   Message:
   ```
   {{ product.title }} runs out in about {{ daysOfStock }} days.
   Keha suggests ordering {{ suggestedQuantity }} units by {{ orderBy }}.
   ```
3. Name it, turn it on.

## 2. Test each workflow

- **A**: on a Monday from 08:00 store time the Monday job fires once per store week. To test
  sooner, temporarily delete this week's `OwnerEmailLog` row of kind `monday_flow` for the dev store
  and wait for the next hourly tick on a Monday — or use Flow's **Run test** if the editor offers it
  for app triggers. Check the email arrives, the subject, the line breaks, the link opens the app.
- **B**: fires once per store, after a compute job, within 7 days of the first full read. On a fresh
  dev store install it fires on its own when the plan is first ready.
- **C**: fires from the hourly alerts job for a product that is running low with a suggested order.
- Then import each exported workflow into a **second** store to confirm nothing store-specific is
  left (shopify.dev recommends this before submitting).

## 3. Export and add the template extensions

For each workflow:

1. In the workflow: **⋯ → Export** → save the `.flow` file. Don't edit `.flow` files by hand.
2. In the repo: `shopify app generate extension` → **Flow Template**, name it as below (no
   punctuation). This gives the extension a real `uid`.
3. Replace the generated `shopify.extension.toml` and `locales/` with the files from
   `docs/flow-templates/<folder>/` (keep the generated `uid` line), and put the exported file in the
   folder as `template.flow`.

| Workflow | CLI name | Folder in `docs/flow-templates/` | Handle |
|---|---|---|---|
| A | Weekly order plan email | `weekly-order-plan-email` | `weekly-order-plan-email` |
| B | First order plan email | `first-order-plan-email` | `first-order-plan-email` |
| C | Reorder alert email | `reorder-alert-email` | `reorder-alert-email` |

4. `npm run typecheck && npx vitest run && npm run build` (`tests/flow-extensions.test.ts` checks
   every `flow_template` folder has its `template.flow`), commit, `npm run deploy`, release.
   The templates then go to Flow's review; you get an email if changes are needed.

## Template settings chosen (change in the toml if you prefer)

- `categories = ["inventory_and_merch"]` — one of Flow's valid categories.
- `require_app = false`, `discoverable = true`: merchants browsing Flow's template library can find
  them (installing one prompts them to install Keha). Set `require_app = true` to show them only to
  stores that already have the app.
- `enabled = true`: published once approved.
- Locales: English (`en.default.json`) plus the seven languages the admin supports.
