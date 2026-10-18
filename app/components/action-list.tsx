/**
 * Home "This week's actions" (spec §5.1, §7.7, §4 J4 + J5): tabs, ranked rows
 * with one primary button each, the "…" menu (mark as done, snooze 7 days,
 * dismiss, why), the bridge / promote how-to dialogs, the Clear confirm dialog and the
 * "Clearances running" list. Data comes from lib/action-list-shared.ts; writes
 * go to POST /app/actions.
 */
import { useEffect, useMemo, useState } from "react";
import { SampleOffNote, useSample } from "./sample";
import { useFetcher, useSearchParams } from "react-router";
import { fill, useLocale } from "../lib/i18n";
import { ACTION_TABS, reasonTemplate, rowsForTab, type ActionTab } from "../lib/actions-shared";
import {
  TAB_PAGE_SIZE,
  parseTab,
  type ActionListView,
  type ActionRowView,
  type ClearanceView,
} from "../lib/action-list-shared";
import { factLines, reasonSentence } from "../lib/action-facts-shared";
import { CLEAR_PERCENT, defaultClearForm, type ClearForm, type ClearFormError } from "../lib/clearance-shared";
import { formatAmount, formatCount, formatDay, formatPercent, todayIn } from "../lib/dashboard-shared";
import { Modal, Tabs, flag, useLinkProps, val, vals } from "./wc";
import { ProductThumb } from "./ui";
import { planTag } from "./plan";
import type { ActionsResult } from "../routes/app.actions";

type T = (s: string) => string;

const ENDPOINT = "/app/actions";

const ROW_STYLE = {
  display: "grid",
  gridTemplateColumns: "40px minmax(0, 1fr) auto",
  gap: "12px",
  alignItems: "center",
  padding: "12px 0",
} as const;
const AMOUNT_STYLE = { fontWeight: 600, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } as const;

export function tabLabel(tab: ActionTab, t: T): string {
  switch (tab) {
    case "all":
      return t("All");
    case "reorder":
      return t("Reorder");
    case "bridge":
      // Plain words for the merchant (plan wording "What to do while a best seller is sold out"); the kind id stays "bridge".
      return t("Sold out");
    case "push":
      return t("Promote");
    case "fix":
      return t("Fix");
    case "clear":
      return t("Clear");
  }
}

/** The one-sentence reason: the engine's template (translated) filled with its params. */
export function reasonText(row: Pick<ActionRowView, "reason">, t: T, locale: string): string {
  const key = row.reason.key;
  return reasonSentence(t(reasonTemplate(key, row.reason.params)), row.reason.params, locale);
}

/** "Based on: Supplier lead time: 14 days · Order by: 12 Nov · …" in the admin language; null when nothing can be shown. */
export function whyFactsText(row: Pick<ActionRowView, "reason" | "currency">, t: T, locale: string): string | null {
  const lines = factLines(row.reason.facts, { t, locale, currency: row.currency });
  if (!lines.length) return null;
  return fill(t("Based on: {facts}"), { facts: lines.map((f) => `${f.label}: ${f.value}`).join(" · ") });
}

type Dialog =
  | { type: "why"; row: ActionRowView }
  | { type: "push"; row: ActionRowView }
  | { type: "signups"; row: ActionRowView }
  | { type: "clear"; row: ActionRowView };

export function ActionList({ list, timezone }: { list: ActionListView; timezone: string | null }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<ActionTab>(() => parseTab(params.get("tab")));
  const [limit, setLimit] = useState(TAB_PAGE_SIZE);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<{ op: "snooze" | "dismiss" | "done" | "clear"; id: string } | null>(null);
  const fetcher = useFetcher<ActionsResult>();

  const urlTab = params.get("tab");
  useEffect(() => {
    setTab(parseTab(urlTab));
  }, [urlTab]);

  const rows = useMemo(() => rowsForTab(list.rows, tab), [list.rows, tab]);
  const money = (v: number | null, currency: string) => formatAmount(v, currency, locale);
  const send = (op: "snooze" | "dismiss" | "done" | "undo", id: string) => {
    fetcher.submit({ op, id }, { method: "post", action: ENDPOINT, encType: "application/json" });
    setNotice(op === "undo" ? null : { op, id });
  };

  const showFixCount = list.fixCount > 0 && (tab === "all" || tab === "fix");
  const showHidden = list.hiddenCount > 0 && tab === "all";
  const empty = list.rows.length === 0 && list.fixCount === 0 && list.hiddenCount === 0;

  return (
    <s-section heading={t("This week's actions")}>
      <s-stack direction="block" gap="base">
        {notice && notice.op !== "clear" && (
          <s-banner tone="info" dismissible onDismiss={() => setNotice(null)}>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text>
                {notice.op === "snooze"
                  ? t("Snoozed for 7 days.")
                  : notice.op === "done"
                    ? t("Marked as done.")
                    : t("Dismissed. It comes back if the amount doubles.")}
              </s-text>
              <s-button variant="tertiary" onClick={() => send("undo", notice.id)}>
                {t("Undo")}
              </s-button>
            </s-stack>
          </s-banner>
        )}
        {notice?.op === "clear" && (
          <s-banner tone="success" dismissible onDismiss={() => setNotice(null)}>
            {t("Discount created. We'll track the cash it frees.")}
          </s-banner>
        )}

        {empty ? (
          <s-paragraph color="subdued">{t("Nothing to do this week. We'll tell you when something needs you.")}</s-paragraph>
        ) : (
          <>
            <Tabs
              tabs={ACTION_TABS.map((id) => ({ id, content: `${tabLabel(id, t)} (${formatCount(list.counts[id], locale)})` }))}
              selected={ACTION_TABS.indexOf(tab)}
              onSelect={(i) => {
                setTab(ACTION_TABS[i] ?? "all");
                setLimit(TAB_PAGE_SIZE);
              }}
            />
            {rows.length === 0 && !(tab === "fix" && showFixCount) && (
              <s-paragraph color="subdued">{t("Nothing in this group this week.")}</s-paragraph>
            )}
            {rows.length > 0 && (
              <div role="list">
                {rows.slice(0, limit).map((row, i) => (
                  <ActionRow
                    key={row.id}
                    row={row}
                    first={i === 0}
                    money={money}
                    onSnooze={() => send("snooze", row.id)}
                    onDismiss={() => send("dismiss", row.id)}
                    onDone={() => send("done", row.id)}
                    onOpen={(type) => setDialog({ type, row })}
                  />
                ))}
              </div>
            )}
            {rows.length > limit && (
              <s-stack direction="inline">
                <s-button variant="tertiary" onClick={() => setLimit((n) => n + TAB_PAGE_SIZE)}>
                  {fill(t("Show more ({n} left)"), { n: formatCount(rows.length - limit, locale) })}
                </s-button>
              </s-stack>
            )}
            {showFixCount && (
              <s-box padding="base" border="base" borderRadius="base">
                <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                  <s-stack direction="block" gap="small-100">
                    <s-text type="strong">{fill(t("Product details to fix: {n}"), { n: formatCount(list.fixCount, locale) })}</s-text>
                    <s-text color="subdued">{t("Missing sizes, weak product pages, high returns and falling best sellers, product by product.")}</s-text>
                  </s-stack>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-badge>{planTag("fixDetails", t)}</s-badge>
                    <s-button variant="primary" {...link("/app/plans")}>
                      {t("Upgrade to see them")}
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-box>
            )}
            {showHidden && (
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text color="subdued">
                  {list.hiddenAmount != null
                    ? fill(t("{n} more actions worth {money} on the Growth plan"), {
                        n: formatCount(list.hiddenCount, locale),
                        money: money(list.hiddenAmount, list.currency),
                      })
                    : fill(t("{n} more actions on the Growth plan"), { n: formatCount(list.hiddenCount, locale) })}
                </s-text>
                <s-link {...link("/app/plans")}>{t("Upgrade")}</s-link>
              </s-stack>
            )}
          </>
        )}

        {(tab === "clear" || empty) && list.clearances.length > 0 && <ClearancesRunning items={list.clearances} />}
      </s-stack>

      <WhyDialog dialog={dialog?.type === "why" ? dialog.row : null} onClose={() => setDialog(null)} />
      <PushDialog row={dialog?.type === "push" ? dialog.row : null} onClose={() => setDialog(null)} />
      <SignupsDialog row={dialog?.type === "signups" ? dialog.row : null} onClose={() => setDialog(null)} />
      <ClearDialog
        key={dialog?.type === "clear" ? dialog.row.id : "closed"}
        row={dialog?.type === "clear" ? dialog.row : null}
        timezone={timezone}
        onClose={() => setDialog(null)}
        onCreated={(id) => {
          setDialog(null);
          setNotice({ op: "clear", id });
        }}
      />
    </s-section>
  );
}

function ActionRow({
  row,
  first,
  money,
  onSnooze,
  onDismiss,
  onDone,
  onOpen,
}: {
  row: ActionRowView;
  first: boolean;
  money: (v: number | null, currency: string) => string;
  onSnooze: () => void;
  onDismiss: () => void;
  onDone: () => void;
  onOpen: (type: Dialog["type"]) => void;
}) {
  const { t, locale } = useLocale();
  const title = row.productTitle ?? "—";
  const menuId = `keha-action-menu-${row.id}`;
  const variants = row.variants.length
    ? row.variants.join(", ") + (row.moreVariants > 0 ? ` ${fill(t("+{n} more"), { n: formatCount(row.moreVariants, locale) })}` : "")
    : null;
  return (
    <>
      {!first && <s-divider />}
      <div role="listitem" style={ROW_STYLE}>
        <ProductThumb src={row.image} alt={title} size={40} />
        <s-stack direction="block" gap="small-100">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text type="strong">{title}</s-text>
            <s-badge>{tabLabel(row.tab, t)}</s-badge>
          </s-stack>
          {variants && <s-text color="subdued">{variants}</s-text>}
          <s-text>{reasonText(row, t, locale)}</s-text>
        </s-stack>
        <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="end">
          <span style={AMOUNT_STYLE}>{money(row.amount, row.currency)}</span>
          <PrimaryButton row={row} onOpen={onOpen} />
          <s-button variant="tertiary" icon="menu-horizontal" commandFor={menuId} accessibilityLabel={`${t("More actions")}: ${title}`} />
          <s-menu id={menuId} accessibilityLabel={t("More actions")}>
            <s-button onClick={onDone}>{t("Mark as done")}</s-button>
            <s-button onClick={onSnooze}>{t("Snooze 7 days")}</s-button>
            <s-button onClick={onDismiss}>{t("Dismiss")}</s-button>
            <s-button onClick={() => onOpen("why")}>{t("Why")}</s-button>
          </s-menu>
        </s-stack>
      </div>
    </>
  );
}

function PrimaryButton({ row, onOpen }: { row: ActionRowView; onOpen: (type: Dialog["type"]) => void }) {
  const { t } = useLocale();
  const link = useLinkProps();
  const b = row.button;
  switch (b.kind) {
    case "reorder":
      return <s-button {...link(b.href)}>{t("Add to order")}</s-button>;
    case "preorder":
      return (
        <s-button href={b.href} target="_top">
          {t("Take preorders for the gap")}
        </s-button>
      );
    case "signups":
      return <s-button onClick={() => onOpen("signups")}>{t("Collect back-in-stock sign-ups")}</s-button>;
    case "pushHow":
      return <s-button onClick={() => onOpen("push")}>{t("Show how")}</s-button>;
    case "seeWhy":
      return <s-button {...link(b.href)}>{t("See why")}</s-button>;
    case "restockSizes":
      return <s-button {...link(b.href)}>{t("Restock sizes")}</s-button>;
    case "checkPage":
      return (
        <s-button href={b.productUrl} target="_top">
          {t("Check the page")}
        </s-button>
      );
    case "checkSizing":
      return (
        <s-button href={b.productUrl} target="_top">
          {t("Check sizing / quality")}
        </s-button>
      );
    case "createDiscount":
      return <s-button onClick={() => onOpen("clear")}>{t("Create discount")}</s-button>;
    case "locked":
      return <LockedButton feature={b.feature} />;
  }
}

/** Plan locks teach: the button stays, disabled, with its plan and an Upgrade link. */
function LockedButton({ feature }: { feature: "bridge" | "clearance" }) {
  const { t } = useLocale();
  const link = useLinkProps();
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <s-button disabled>{feature === "bridge" ? t("Collect back-in-stock sign-ups") : t("Create discount")}</s-button>
      <s-badge>{planTag(feature, t)}</s-badge>
      <s-button variant="tertiary" {...link("/app/plans")}>
        {t("Upgrade")}
      </s-button>
    </s-stack>
  );
}

function WhyDialog({ dialog: row, onClose }: { dialog: ActionRowView | null; onClose: () => void }) {
  const { t, locale } = useLocale();
  const facts = row ? whyFactsText(row, t, locale) : null;
  return (
    <Modal open={!!row} onClose={onClose} heading={t("Why this action")}>
      {row && (
        <s-stack direction="block" gap="small-200">
          <s-paragraph>{reasonText(row, t, locale)}</s-paragraph>
          {facts ? (
            <s-text color="subdued">{facts}</s-text>
          ) : (
            <s-text color="subdued">{t("The details appear after the next calculation.")}</s-text>
          )}
        </s-stack>
      )}
    </Modal>
  );
}

function PushDialog({ row, onClose }: { row: ActionRowView | null; onClose: () => void }) {
  const { t } = useLocale();
  const url = row?.button.kind === "pushHow" ? row.button.productUrl : null;
  return (
    <Modal
      open={!!row}
      onClose={onClose}
      heading={t("How to promote this product")}
      primaryAction={
        url ? (
          <s-button variant="primary" href={url} target="_top">
            {t("Open product in Shopify")}
          </s-button>
        ) : undefined
      }
      secondaryActions={<s-button onClick={onClose}>{t("Close")}</s-button>}
    >
      {row && (
        <s-stack direction="block" gap="small-200">
          <s-paragraph>{row.productTitle ?? "—"}</s-paragraph>
          <s-ordered-list>
            <s-list-item>{t("Feature it on your home page, for example in a featured product section.")}</s-list-item>
            <s-list-item>{t("Add it to your next email to customers.")}</s-list-item>
            <s-list-item>{t("Move it up in its collection so more shoppers see it first.")}</s-list-item>
          </s-ordered-list>
        </s-stack>
      )}
    </Modal>
  );
}

function SignupsDialog({ row, onClose }: { row: ActionRowView | null; onClose: () => void }) {
  const { t, locale } = useLocale();
  const b = row?.button.kind === "signups" ? row.button : null;
  return (
    <Modal
      open={!!row}
      onClose={onClose}
      heading={t("Collect back-in-stock sign-ups")}
      primaryAction={
        b ? (
          <s-button variant="primary" href={b.productUrl} target="_top">
            {t("Open product in Shopify")}
          </s-button>
        ) : undefined
      }
      secondaryActions={<s-button onClick={onClose}>{t("Close")}</s-button>}
    >
      {row && (
        <s-stack direction="block" gap="small-200">
          <s-paragraph>{t("Shoppers who find this product sold out can leave their email, so the sale isn't lost while you wait for stock.")}</s-paragraph>
          <s-ordered-list>
            <s-list-item>
              {t("Turn on a back-in-stock or sold-out sign-up form on the product page. Many themes have one under Online Store › Themes › Customize.")}
            </s-list-item>
            <s-list-item>{t("Add the expected arrival date to the product description, so shoppers know when to come back.")}</s-list-item>
            <s-list-item>{t("Open the product page while it is sold out and check that the form shows.")}</s-list-item>
          </s-ordered-list>
          {b?.arrival && <s-text color="subdued">{fill(t("Expected arrival: {date}"), { date: formatDay(b.arrival, locale) })}</s-text>}
        </s-stack>
      )}
    </Modal>
  );
}

function clearErrorText(key: ClearFormError, t: T): string {
  switch (key) {
    case "kind":
      return t("Choose a discount type.");
    case "percent":
      return t("Enter a whole number from 1 to 90.");
    case "endsOn":
      return t("Pick today or a later date, or leave it empty.");
    case "code":
      return t("Use 3 to 40 letters, numbers, dashes or underscores.");
  }
}

export function ClearDialog({
  row,
  timezone,
  onClose,
  onCreated,
}: {
  row: ActionRowView | null;
  timezone: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useLocale();
  // Keyed by the row: each opening starts from fresh defaults and a new code.
  const fetcher = useFetcher<ActionsResult>();
  const [form, setForm] = useState<ClearForm>(() => defaultClearForm(todayIn(timezone, new Date())));

  const result = fetcher.data;
  const created = !!(result && result.ok && "discountId" in result && row && result.id === row.id);
  useEffect(() => {
    if (created && row) onCreated(row.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [created]);

  const busy = fetcher.state !== "idle";
  const sample = useSample().on;
  const errors = result && !result.ok && result.error === "invalid" ? result.errors : {};
  const err = (k: ClearFormError) => (errors[k] ? clearErrorText(k, t) : undefined);
  const set = (k: keyof ClearForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = () => {
    if (!row || busy || sample) return; // one request at a time (the server also claims the action atomically)
    fetcher.submit({ op: "clear", id: row.id, ...form }, { method: "post", action: ENDPOINT, encType: "application/json" });
  };

  return (
    <Modal
      open={!!row}
      onClose={onClose}
      heading={t("Create a discount")}
      primaryAction={
        <s-button variant="primary" onClick={submit} loading={flag(busy)} disabled={flag(!row || busy || sample)}>
          {t("Create discount")}
        </s-button>
      }
      secondaryActions={<s-button onClick={onClose}>{t("Cancel")}</s-button>}
    >
      {row && (
        <s-stack direction="block" gap="base">
          <SampleOffNote>{t("Discounts are off in sample data — nothing is created in your store.")}</SampleOffNote>
          {result && !result.ok && result.error === "shopify" && (
            <s-banner tone="critical" heading={t("Shopify couldn't create the discount")}>
              {result.userErrors.length > 0 ? (
                <s-unordered-list>
                  {result.userErrors.map((m, i) => (
                    <s-list-item key={i}>{m}</s-list-item>
                  ))}
                </s-unordered-list>
              ) : (
                <s-paragraph>{t("Please try again in a minute.")}</s-paragraph>
              )}
            </s-banner>
          )}
          {result && !result.ok && (result.error === "failed" || result.error === "not_found" || result.error === "bad_request") && (
            <s-banner tone="critical" heading={t("Shopify couldn't create the discount")}>
              <s-paragraph>{t("Please try again in a minute.")}</s-paragraph>
            </s-banner>
          )}
          {result && !result.ok && result.error === "sample" && <SampleOffNote />}
          {result && !result.ok && result.error === "upgrade" && (
            <s-banner tone="info" heading={t("Clear dead stock")}>
              <s-paragraph>{planTag("clearance", t)}</s-paragraph>
            </s-banner>
          )}
          <s-paragraph>
            {fill(t("Applies to {product} only. Nothing changes in your store until you press Create discount."), {
              product: row.productTitle ?? "—",
            })}
          </s-paragraph>
          <s-choice-list
            label={t("Discount type")}
            name="kind"
            error={err("kind")}
            onChange={(e) => {
              const v = vals(e)[0];
              if (v) set("kind", v);
            }}
          >
            <s-choice value="automatic" selected={flag(form.kind === "automatic")}>
              {t("Automatic discount")}
              <s-text slot="details">{t("Applies at checkout, no code needed.")}</s-text>
            </s-choice>
            <s-choice value="code" selected={flag(form.kind === "code")}>
              {t("Discount code")}
              <s-text slot="details">{t("Shoppers enter the code at checkout.")}</s-text>
            </s-choice>
          </s-choice-list>
          <s-number-field
            label={t("Discount")}
            value={form.percent}
            min={CLEAR_PERCENT.min}
            max={CLEAR_PERCENT.max}
            step={1}
            suffix="%"
            details={t("From 1% to 90% off.")}
            error={err("percent")}
            onInput={(e) => set("percent", val(e))}
          />
          {form.kind === "code" && (
            <s-text-field
              label={t("Code to enter at checkout")}
              value={form.code}
              details={t("Letters, numbers, dashes and underscores, 3 to 40 characters.")}
              error={err("code")}
              onInput={(e) => set("code", val(e).toUpperCase())}
            />
          )}
          <s-date-field
            label={t("End date")}
            value={form.endsOn}
            details={t("Optional. Leave it empty to keep the discount running until you end it in Shopify.")}
            error={err("endsOn")}
            onChange={(e) => set("endsOn", val(e))}
          />
        </s-stack>
      )}
    </Modal>
  );
}

function ClearancesRunning({ items }: { items: ClearanceView[] }) {
  const { t, locale } = useLocale();
  return (
    <s-stack direction="block" gap="small-200">
      <s-heading>{t("Clearances running")}</s-heading>
      {items.map((c) => (
        <s-box key={c.id} padding="small-200" border="base" borderRadius="base">
          <s-stack direction="block" gap="small-100">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text type="strong">{c.productTitle ?? "—"}</s-text>
              <s-badge>{formatPercent(-c.percent / 100, locale)}</s-badge>
            </s-stack>
            <s-text color="subdued">
              {c.kind === "code" && c.code ? fill(t("Discount code {code}"), { code: c.code }) : t("Automatic discount")}
              {" · "}
              {c.endsOn ? fill(t("Ends {date}"), { date: formatDay(c.endsOn, locale) }) : t("No end date")}
            </s-text>
            <s-text>
              {fill(t("Cash freed so far: {amount}"), { amount: formatAmount(c.cashFreed, c.currency, locale) })}
              {c.retail && c.cashFreed !== null ? ` · ${t("Valued at retail price")}` : ""}
            </s-text>
          </s-stack>
        </s-box>
      ))}
    </s-stack>
  );
}
