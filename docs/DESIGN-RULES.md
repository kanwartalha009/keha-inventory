# Design rules — Keha Inventory admin

Set in the 2026-10-17 design-consistency pass. Every screen follows these; the helpers live in
`app/components/ui.tsx`, the styles in `app/app.css` ("Layout rules" section).

## Page

1. **`<AppPage>` for every admin page.** Heading, page actions and breadcrumb go in the Shopify
   title bar (`s-page` slots). Page-level actions (Export CSV, Add supplier, New scenario) are
   title-bar actions — never buttons inside the content.
2. **A component used as a title-bar action must forward `slot` to its `<s-button>`**
   (see `DownloadButton`, `CsvButton`). If it drops `slot`, the button renders as page content
   above the intro — the "Export CSV floats above the text" bug.
3. Order under the title bar: intro line (optional) → banners → toolbar / tabs → cards.
   Vertical rhythm comes from `.keha-stack` (16px); don't add margins between cards.

## Spacing and type

4. One spacing scale: `--keha-space-050 … --keha-space-600` (2, 4, 6, 8, 12, 16, 20, 24px).
   New hand-built CSS uses these tokens, not raw pixel values.
5. Type sizes and weights come from the `--keha-font-size-*` / `--keha-weight-*` tokens, or from
   Polaris itself (`s-heading`, `s-paragraph`, `s-text`).

## Cards

6. **One card head: `<FormCard title sub action>`** — `s-heading`, then one subdued sentence,
   optional action on the right. Use `flush` when a table fills the card edge to edge (only the
   head is padded). Don't use `<s-section heading>` for top-level cards.
7. **Empty states: `<EmptyState heading? body action?>`** — centred, the same in every card.

## Toolbars and tables

8. **One toolbar: `<Toolbar search filters slot?>`** (`.keha-toolbar`). Two rows, always: the
   search takes the full first row; the filters and selects sit **as one horizontal row** below it,
   sharing the width (each 180–320px, the location select from 220px), vertically centred, wrapping
   among themselves only when the row is too narrow; below 600px each control takes a full row.
   Never let the filters stack into a column beside the search (the 2026-10-17 Products bug in the
   live admin: a side-by-side layout squeezed the filter group inside the table's filters slot).
   In an `s-table` pass `slot="filters"`.
9. **Column headers never wrap.** Short label in the header, long form in a tooltip:
   `<HeaderLabel id label hint badge>` ("Sales/day" → "Sales per day while in stock").
   A plan lock in a header is a compact badge with the plan name (lock icon + "Growth").
10. **Numbers are right-aligned with lined-up digits:** `format="numeric"` on the
    `s-table-header` of every count / rate / days column (dates and text stay left).
    `s-table` sets `tabular-nums`; outside tables use `.keha-num`. Missing values show "—".
11. **Row actions never wrap:** at most two buttons in view, the rest in an `s-menu`
    ("More actions").
12. Values that must stay on one line (badges, prices, "+3 on order") get `.keha-nowrap` /
    `.keha-inline`; check against the longest translation (German, Dutch and Polish run ~30%
    longer than English) before relying on it.

## Forms and settings

13. **One save pattern: the contextual save bar** (`<FormSaveBar id dirty saving onSave
    onDiscard>`, App Bridge `ui-save-bar`). It shows while the form differs from what is saved,
    stays open while saving and after a failed save, and Discard restores the saved values.
    No Save button in the title bar or at the bottom of a form. (Programmatic save bar, not
    `<form data-save-bar>`: our fields are React-controlled, which the automatic tracking can't
    see under React 18.)
14. Settings tabs: `SettingsTabs` strip first, then banners, then `FormCard`s. Switching tabs
    with unsaved changes asks first (`shopify.saveBar.leaveConfirmation()`).

## Plan locks

15. Locks teach, they don't hide (I-6): the locked control stays visible with the plan name and
    a way to the plans. A control that can't do anything for this store (the location switcher
    in a one-location store) is not shown at all.
16. When the plan isn't confirmed (fail open), say what is true — "All features on" — never
    name a plan the merchant may not be on.

## Location switcher

17. `LocationSwitcher` decides by itself (`switcherMode`): fewer than 2 active locations →
    nothing; below Pro → one teaching link "Plan per location · Pro plan"; Pro without
    warehouses / stores → one link to Settings → Locations; Pro → a compact select. Pass
    `locationCount` (active locations) so the one-location case is known.

## Public pages (supplier, unsubscribe, legal)

18. They don't load `app.css`; keep inline styles but the same rules: tables scroll inside
    their box on a phone, number columns right-aligned, `nowrap`, `tabular-nums`.
