/**
 * Settings → Suppliers (/app/settings/suppliers), spec §5.5, Growth
 * (`suppliers`). List, add, edit and delete suppliers: name, email (stored
 * encrypted), lead time, minimum per item, minimum order total, case pack,
 * vendor match — order cycle ("Order every … days", 2026-10-17), minimum scope, money
 * minimum, currency, exchange rate, payment terms, freight & duty, the purchase orders' language
 * and Incoterms (merchant audit 2026-10-18) and "hide prices" under More options (8 visible
 * fields, spec ≤ 8).
 *
 * Assignment: by vendor (vendor match), or by product through the admin's own
 * product picker (App Bridge resourcePicker), which sets the supplier on every
 * variant of the picked products. A product assignment wins over the vendor.
 * Free stores see the tab with an Upgrade banner; every action is refused on
 * the server too (403 upgrade JSON).
 */
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticateApp } from "../services/data-scope.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import {
  applyMeasuredLeadTime,
  assignProducts,
  clearProducts,
  deleteSupplier,
  listSuppliers,
  otherSupplierNames,
  saveSupplier,
  storeCurrency,
  supplierContext,
  supplierForm,
  type SupplierListRow,
} from "../models/suppliers.server";
import { secretsWritable } from "../lib/crypto.server";
import { AppPage, Disclosure, EmptyState, FormCard, FormSaveBar, sameValues } from "../components/ui";
import { SettingsTabs } from "../components/settings-tabs";
import { UpgradeBanner, planTag } from "../components/plan";
import ConfirmModal from "../components/ConfirmModal";
import { ChoiceListField, SelectField, flag, isChecked, useLinkProps, val } from "../components/wc";
import { LOCALES, LOCALE_NAMES, fill, useLocale, type Locale, plural } from "../lib/i18n";
import { formatAmount, formatCount, formatPercent } from "../lib/dashboard-shared";
import { landedText, termsText } from "../lib/cash-shared";
import { MIN_SAMPLES, consistentlyLate, measuredLead, reliabilityDetail, reliabilityText } from "../lib/lead-time-shared";
import {
  SUPPLIER_BOUNDS,
  type BalanceChoice,
  needsExchangeRate,
  newSupplierForm,
  productIdsFrom,
  readSupplierForm,
  supplierErrorText,
  validateSupplierForm,
  type SupplierErrors,
  type SupplierForm,
  type SupplierNumberKey,
} from "../lib/suppliers-shared";
import type { MinOrderScope } from "../lib/supplier-shared";

export type SuppliersData = {
  suppliers: SupplierListRow[];
  vendors: string[];
  currency: string;
  /** The store's order cycle (Settings → Defaults): a supplier without its own uses it. */
  cycleDays?: number;
  enabled: boolean;
  /** The supplier being edited ("new" or an id) and its form; null = list only. */
  editing: { id: string | null; form: SupplierForm } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs): Promise<SuppliersData> => {
  const { shop } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  const [suppliers, ctx] = await Promise.all([listSuppliers(shop), supplierContext(shop)]);
  const edit = new URL(request.url).searchParams.get("edit");
  let editing: SuppliersData["editing"] = null;
  if (features.suppliers && edit === "new") editing = { id: null, form: newSupplierForm(ctx.leadTimeDays, ctx.currency) };
  else if (features.suppliers && edit) {
    const form = await supplierForm(shop, edit);
    if (form) editing = { id: edit, form };
  }
  return { suppliers, vendors: ctx.vendors, currency: ctx.currency, cycleDays: ctx.cycleDays, enabled: features.suppliers, editing };
};

export type SuppliersAction =
  | { ok: true; intent: "save" | "delete" | "assign" | "clear" | "useMeasured"; count?: number; name?: string; leadTimeDays?: number }
  | { ok: false; errors?: SupplierErrors; error?: "notFound" | "notMeasured" };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  if (!features.suppliers) return upgradeResponse("suppliers", "Suppliers are on the Growth plan.");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  const id = typeof body.id === "string" && body.id ? body.id : null;
  switch (body.intent) {
    case "save": {
      const form = readSupplierForm(body.form);
      const [taken, currency] = await Promise.all([otherSupplierNames(shop, id), storeCurrency(shop)]);
      const v = validateSupplierForm(form, taken, currency);
      if (!v.ok) return { ok: false, errors: v.errors } satisfies SuppliersAction;
      // Supplier emails are stored encrypted only; never in the clear (lib/crypto.server).
      if (v.input.email && !secretsWritable()) return { ok: false, errors: { email: "emailStorage" } } satisfies SuppliersAction;
      const saved = await saveSupplier(shop, id, v.input);
      if (!saved) return { ok: false, error: "notFound" } satisfies SuppliersAction;
      return { ok: true, intent: "save", name: v.input.name } satisfies SuppliersAction;
    }
    case "delete": {
      if (!id || !(await deleteSupplier(shop, id))) return { ok: false, error: "notFound" } satisfies SuppliersAction;
      return { ok: true, intent: "delete" } satisfies SuppliersAction;
    }
    case "assign": {
      const products = productIdsFrom(body.productIds);
      const n = id ? await assignProducts(shop, id, products) : null;
      if (n === null) return { ok: false, error: "notFound" } satisfies SuppliersAction;
      return { ok: true, intent: "assign", count: products.length } satisfies SuppliersAction;
    }
    case "clear": {
      if (!id) return { ok: false, error: "notFound" } satisfies SuppliersAction;
      await clearProducts(shop, id);
      return { ok: true, intent: "clear" } satisfies SuppliersAction;
    }
    // Merchant audit 2026-10-18: the lead time becomes the median of the measured deliveries (after a confirm).
    case "useMeasured": {
      const r = id ? await applyMeasuredLeadTime(shop, id) : ({ ok: false, error: "notFound" } as const);
      return (r.ok ? { ok: true, intent: "useMeasured", leadTimeDays: r.leadTimeDays } : { ok: false, error: r.error }) satisfies SuppliersAction;
    }
    default:
      throw new Response("Bad request", { status: 400 });
  }
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export default function SuppliersSettings() {
  const { t, locale } = useLocale();
  const data = useLoaderData<typeof loader>() as SuppliersData;
  const fetcher = useFetcher<SuppliersAction>();
  const navigate = useNavigate();
  const link = useLinkProps();
  const [params] = useSearchParams();
  const [confirm, setConfirm] = useState<{ kind: "delete" | "clear" | "useMeasured"; row: SupplierListRow } | null>(null);
  const result = fetcher.data;

  // After a save, go back to the list (the loader re-reads it).
  useEffect(() => {
    if (result?.ok && result.intent === "save" && params.get("edit")) navigate("/app/settings/suppliers", { replace: true });
  }, [result, params, navigate]);

  const post = (body: Record<string, unknown>) => fetcher.submit(body as never, { method: "post", encType: "application/json" });

  return (
    <AppPage
      heading={t("Settings")}
      primaryAction={
        data.enabled ? (
          <s-button variant="primary" icon="plus" {...link("/app/settings/suppliers?edit=new")}>
            {t("Add supplier")}
          </s-button>
        ) : (
          <s-button icon="lock" {...link("/app/plans?upgrade=suppliers")}>
            {`${t("Add supplier")} · ${planTag("suppliers", t)}`}
          </s-button>
        )
      }
    >
      <SettingsTabs current="suppliers" />
      {!data.enabled && <UpgradeBanner feature="suppliers" />}
      {result?.ok && result.intent === "save" && (
        <s-banner tone="success">{fill(t("{name} saved."), { name: result.name ?? "" })}</s-banner>
      )}
      {result?.ok && result.intent === "delete" && <s-banner tone="success">{t("Supplier deleted.")}</s-banner>}
      {result?.ok && result.intent === "assign" && (
        <s-banner tone="success">{fill(t("Products assigned: {n}."), { n: formatCount(result.count ?? 0, locale) })}</s-banner>
      )}
      {result?.ok && result.intent === "clear" && (
        <s-banner tone="success">{t("Product assignments removed. Vendor matching applies again.")}</s-banner>
      )}
      {result?.ok && result.intent === "useMeasured" && (
        <s-banner tone="success">{fill(t("Lead time set to {n} days, as measured. Your order plan uses it from now on."), { n: formatCount(result.leadTimeDays ?? 0, locale) })}</s-banner>
      )}
      {result && !result.ok && result.error === "notMeasured" && (
        <s-banner tone="warning">{t("Not enough deliveries measured yet to set the lead time from them.")}</s-banner>
      )}
      {result && !result.ok && result.error === "notFound" && (
        <s-banner tone="critical">{t("This supplier doesn't exist any more. Reload the page.")}</s-banner>
      )}

      {data.editing && (
        <SupplierEditor
          key={data.editing.id ?? "new"}
          id={data.editing.id}
          initial={data.editing.form}
          vendors={data.vendors}
          storeCurrency={data.currency}
          storeCycleDays={data.cycleDays ?? null}
          saving={fetcher.state !== "idle"}
          errors={result && !result.ok ? (result.errors ?? {}) : {}}
          onSave={(form) => post({ intent: "save", id: data.editing?.id ?? null, form })}
          onCancel={() => navigate("/app/settings/suppliers")}
        />
      )}

      <FormCard flush title={t("Suppliers")} sub={t("Keep lead times, minimum orders and case packs for each supplier.")}>
        {data.suppliers.length === 0 ? (
          <EmptyState
            heading={t("No suppliers yet")}
            body={t("Add your suppliers so every product gets the right lead time, minimum order and case pack. Until then the default lead time is used.")}
          />
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("Supplier")}</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">{t("Lead time")}</s-table-header>
              <s-table-header listSlot="labeled">{t("Order minimums")}</s-table-header>
              <s-table-header listSlot="labeled">{t("Products from")}</s-table-header>
              <s-table-header>{t("Actions")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.suppliers.map((s) => (
                <SupplierRow
                  key={s.id}
                  s={s}
                  storeCurrency={data.currency}
                  enabled={data.enabled}
                  onEdit={() => navigate(`/app/settings/suppliers?edit=${encodeURIComponent(s.id)}`)}
                  onAssign={(productIds) => post({ intent: "assign", id: s.id, productIds })}
                  onDelete={() => setConfirm({ kind: "delete", row: s })}
                  onUseMeasured={() => setConfirm({ kind: "useMeasured", row: s })}
                  onClear={() => setConfirm({ kind: "clear", row: s })}
                />
              ))}
            </s-table-body>
          </s-table>
        )}
      </FormCard>

      <ConfirmModal
        open={!!confirm}
        destructive={confirm?.kind === "useMeasured" ? false : undefined}
        title={
          confirm?.kind === "delete"
            ? fill(t("Delete {name}?"), { name: confirm.row.name })
            : confirm?.kind === "useMeasured"
              ? fill(t("Use the measured lead time for {name}?"), { name: confirm.row.name })
              : fill(t("Remove product assignments from {name}?"), { name: confirm?.row.name ?? "" })
        }
        message={
          confirm?.kind === "delete"
            ? t("Its products go back to matching by vendor. Orders you already made keep their details.")
            : confirm?.kind === "useMeasured"
              ? fill(t("The lead time changes from {from} to {to} days — the median of its last {n} deliveries. Order-by dates and quantities follow. Nothing changes in your store or for the supplier."), {
                  from: formatCount(confirm.row.leadTimeDays, locale),
                  to: formatCount(measuredLead(confirm.row.leadStats)?.suggested ?? confirm.row.leadTimeDays, locale),
                  n: formatCount(confirm.row.leadStats?.samples ?? 0, locale),
                })
              : t("These products go back to matching by vendor.")
        }
        confirmLabel={confirm?.kind === "delete" ? t("Delete supplier") : confirm?.kind === "useMeasured" ? t("Use measured lead time") : t("Remove assignments")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) post({ intent: confirm.kind, id: confirm.row.id });
          setConfirm(null);
        }}
      />
    </AppPage>
  );
}

function SupplierRow({
  s,
  storeCurrency,
  enabled,
  onEdit,
  onAssign,
  onDelete,
  onClear,
  onUseMeasured,
}: {
  s: SupplierListRow;
  storeCurrency: string;
  enabled: boolean;
  onEdit: () => void;
  onAssign: (productIds: string[]) => void;
  onDelete: () => void;
  onClear: () => void;
  onUseMeasured?: () => void;
}) {
  const { t, locale } = useLocale();
  const shopify = useAppBridge();
  const menuId = `keha-supplier-menu-${s.id}`;
  // Measured from received orders: "Usually 6 days late" (≥ 3 deliveries), with on-time share and spread.
  const reliability = reliabilityText(s.leadStats, t, (n) => formatCount(n, locale));
  const reliabilityMore = reliabilityDetail(s.leadStats, t, { count: (n) => formatCount(n, locale), percent: (x) => formatPercent(x, locale) });
  const late = !!s.leadStats && s.leadStats.samples >= MIN_SAMPLES && Math.round(s.leadStats.delayAvg) >= 1;
  // Merchant audit 2026-10-18: the measured lead time against the set one, and a consistently late supplier.
  const measured = measuredLead(s.leadStats);
  const lateBy = consistentlyLate(s.leadStats);
  const minimums = [
    s.minOrder
      ? fill(s.minOrderScope === "product" ? t("{n} per product") : t("{n} per item"), { n: formatCount(s.minOrder, locale) })
      : null,
    s.minOrderTotal ? fill(t("{n} per order"), { n: formatCount(s.minOrderTotal, locale) }) : null,
    s.minOrderValue
      ? fill(t("{money} minimum"), { money: formatAmount(s.minOrderValue, s.currency ?? storeCurrency, locale) })
      : null,
    s.casePack ? fill(t("cases of {n}"), { n: formatCount(s.casePack, locale) }) : null,
  ].filter(Boolean);
  const pick = async () => {
    try {
      const picked = await shopify.resourcePicker({ type: "product", multiple: true, action: "select" });
      const ids = productIdsFrom(picked ?? []);
      if (ids.length) onAssign(ids);
    } catch {
      /* picker closed or unavailable */
    }
  };
  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="block" gap="none">
          <s-text fontWeight="medium">{s.name}</s-text>
          <s-text color="subdued">{s.hasEmail ? t("Email saved") : t("No email")}</s-text>
          {(s.terms || s.landedPct) && <s-text color="subdued">{[termsText(s.terms, t), landedText(s.landedPct, t, locale)].filter(Boolean).join(" ")}</s-text>}
          <s-text color="subdued">
            {[fill(t("Order language: {language}"), { language: LOCALE_NAMES[s.poLanguage ?? "en"] }), s.incoterms].filter(Boolean).join(" · ")}
          </s-text>
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="none">
          <span className="keha-num">{fill(plural(s.leadTimeDays, t("1 day"), t("{n} days")), { n: formatCount(s.leadTimeDays, locale) })}</span>
          {reliability && <s-text tone={late ? "caution" : undefined} color={late ? undefined : "subdued"}>{reliability}</s-text>}
          {reliabilityMore && <s-text color="subdued">{reliabilityMore}</s-text>}
          {measured && (
            <s-text color="subdued">
              {fill(t("Measured: {median} days typical, 80% within {p80} days"), { median: formatCount(Math.round(measured.median), locale), p80: formatCount(Math.round(measured.p80), locale) })}
            </s-text>
          )}
          {lateBy !== null && <s-badge tone="warning">{fill(t("Consistently late: {n} days"), { n: formatCount(lateBy, locale) })}</s-badge>}
          {measured && measured.suggested !== s.leadTimeDays && onUseMeasured && (
            <s-stack direction="inline">
              <s-button variant="tertiary" disabled={flag(!enabled)} onClick={onUseMeasured}>
                {fill(t("Use measured lead time ({n} days)"), { n: formatCount(measured.suggested, locale) })}
              </s-button>
            </s-stack>
          )}
          {s.transitDays ? (
            <s-text color="subdued">{fill(plural(s.transitDays, t("1 day in transit"), t("{n} days in transit")), { n: formatCount(s.transitDays, locale) })}</s-text>
          ) : null}
          {s.orderCycleDays ? (
            <s-text color="subdued">{fill(plural(s.orderCycleDays, t("Order enough for: 1 day"), t("Order enough for: {n} days")), { n: formatCount(s.orderCycleDays, locale) })}</s-text>
          ) : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>{minimums.length ? minimums.join(" · ") : "—"}</s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="none">
          <s-text>{s.vendorMatch.length ? fill(t("Vendors: {list}"), { list: s.vendorMatch.join(", ") }) : t("No vendors")}</s-text>
          {s.products > 0 && (
            <s-text color="subdued">{fill(t("Products picked: {n}"), { n: formatCount(s.products, locale) })}</s-text>
          )}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        {/* Two actions in view, the rest one click away: the row's buttons never wrap. */}
        <span className="keha-inline">
          <s-button variant="tertiary" disabled={flag(!enabled)} onClick={onEdit}>
            {t("Edit")}
          </s-button>
          <s-button variant="tertiary" disabled={flag(!enabled)} onClick={pick}>
            {t("Assign products")}
          </s-button>
          <s-button
            variant="tertiary"
            icon="menu-horizontal"
            disabled={flag(!enabled)}
            commandFor={menuId}
            accessibilityLabel={`${t("More actions")}: ${s.name}`}
          />
          <s-menu id={menuId} accessibilityLabel={t("More actions")}>
            {s.products > 0 && <s-button onClick={onClear}>{t("Remove assignments")}</s-button>}
            <s-button tone="critical" onClick={onDelete}>
              {t("Delete")}
            </s-button>
          </s-menu>
        </span>
      </s-table-cell>
    </s-table-row>
  );
}

function SupplierEditor({
  id,
  initial,
  vendors,
  storeCurrency,
  storeCycleDays,
  saving,
  errors,
  onSave,
  onCancel,
}: {
  id: string | null;
  initial: SupplierForm;
  vendors: string[];
  storeCurrency: string;
  storeCycleDays: number | null;
  saving: boolean;
  errors: SupplierErrors;
  onSave: (form: SupplierForm) => void;
  onCancel: () => void;
}) {
  const { t, locale } = useLocale();
  const [form, setForm] = useState<SupplierForm>(initial);
  // More options opens by itself when one of its fields has an error after a save.
  const moreHasError = !!(
    errors.orderCycleDays ||
    errors.minOrderValue ||
    errors.exchangeRate ||
    errors.currency ||
    errors.depositPercent ||
    errors.balanceDays ||
    errors.landedCostPercent ||
    errors.incoterms
  );
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (moreHasError) setMore(true);
  }, [moreHasError]);
  // A new supplier counts as changed from the start, so Save is there as soon as it opens.
  const dirty = id === null || !sameValues(form, initial);
  const set = <K extends keyof SupplierForm>(key: K, value: SupplierForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const err = (key: keyof SupplierForm) => {
    const code = errors[key];
    if (!code) return undefined;
    const text = supplierErrorText(code, t);
    return key in SUPPLIER_BOUNDS ? fill(text, SUPPLIER_BOUNDS[key as SupplierNumberKey]) : text;
  };
  const numberField = (key: SupplierNumberKey, label: string, details: string, suffix?: string) => (
    <s-number-field
      label={label}
      details={details}
      value={form[key]}
      min={SUPPLIER_BOUNDS[key].min}
      max={SUPPLIER_BOUNDS[key].max}
      step={1}
      suffix={suffix}
      error={err(key)}
      onInput={(e) => set(key, val(e))}
    />
  );
  // The currency this supplier bills in (empty = the store's).
  const supplierCurrency = form.currency.trim().toUpperCase() || storeCurrency;
  const showRate = needsExchangeRate(form.currency, storeCurrency);
  // Vendors already matched but no longer in the catalog stay selectable.
  const vendorChoices = [...new Set([...vendors, ...form.vendorMatch])].map((v) => ({ value: v, label: v }));
  return (
    <FormCard
      title={id ? t("Edit supplier") : t("New supplier")}
      sub={t("Lead time and minimums apply to every product this supplier delivers.")}
      action={
        <s-button variant="tertiary" onClick={onCancel}>
          {t("Cancel")}
        </s-button>
      }
    >
      <FormSaveBar
        id="keha-settings-supplier"
        dirty={dirty}
        saving={saving}
        onSave={() => onSave(form)}
        onDiscard={id === null ? onCancel : () => setForm(initial)}
      />
      <s-stack direction="block" gap="base">
        <s-text-field label={t("Supplier name")} value={form.name} error={err("name")} onInput={(e) => set("name", val(e))} />
        <s-email-field
          label={t("Supplier email")}
          details={t("Where we send purchase orders. Stored encrypted.")}
          value={form.email}
          error={err("email")}
          onInput={(e) => set("email", val(e))}
        />
        {numberField("leadTimeDays", t("Lead time"), t("Total days from placing the order to stock arriving."), t("days"))}
        {numberField(
          "transitDays",
          t("Transit time"),
          t("Days from ship date to arrival — sea or air freight. Part of the lead time. Leave empty if the supplier delivers directly."),
          t("days"),
        )}
        {numberField("minOrder", t("Minimum per item"), t("The fewest units the supplier takes of one variant. Leave empty for none."))}
        {numberField("minOrderTotal", t("Minimum order (units)"), t("The fewest units for the whole order. Suggested orders are topped up to reach it."))}
        {numberField("casePack", t("Case pack"), t("Units per case. Quantities are rounded up to whole cases. A product's own case size wins."))}
        {vendorChoices.length > 0 ? (
          <ChoiceListField
            label={t("Products from these vendors")}
            multiple
            choices={vendorChoices}
            selected={form.vendorMatch}
            onChange={(v) => set("vendorMatch", v)}
          />
        ) : (
          <s-paragraph color="subdued">{t("No vendors in your catalog yet. Assign products to this supplier from the list instead.")}</s-paragraph>
        )}
        {errors.vendorMatch && <s-text tone="critical">{err("vendorMatch")}</s-text>}
        <Disclosure id="supplier-more" title={t("More options")} open={more} onToggle={() => setMore((m) => !m)}>
          <s-stack direction="block" gap="base">
            {numberField(
              "orderCycleDays",
              t("Order enough for"),
              storeCycleDays
                ? fill(t("Days of stock each order from this supplier should last after it arrives. Leave empty to use your store's setting ({n} days)."), { n: formatCount(storeCycleDays, locale) })
                : t("Days of stock each order from this supplier should last after it arrives. Leave empty to use your store's setting."),
              t("days"),
            )}
            <SelectField<MinOrderScope>
              label={t("Minimum per item applies to")}
              value={form.minOrderScope}
              options={[
                { value: "variant", label: t("Each size/color") },
                { value: "product", label: t("Each product (split across sizes by sales)") },
              ]}
              onChange={(v) => set("minOrderScope", v)}
            />
            <s-number-field
              label={t("Minimum order (value)")}
              details={fill(t("The smallest order this supplier accepts, in {currency}. Leave empty for none."), {
                currency: supplierCurrency,
              })}
              value={form.minOrderValue}
              suffix={supplierCurrency}
              inputMode="decimal"
              min={0}
              step={0.01}
              error={err("minOrderValue")}
              onInput={(e) => set("minOrderValue", val(e))}
            />
            <s-text-field
              label={t("Currency")}
              details={fill(t("The currency you pay this supplier in. Leave empty for your store currency ({currency})."), {
                currency: storeCurrency,
              })}
              value={form.currency}
              maxLength={3}
              error={err("currency")}
              onInput={(e) => set("currency", val(e).toUpperCase())}
            />
            {showRate && (
              <s-number-field
                label={fill(t("Exchange rate: 1 {supplierCurrency} = ? {storeCurrency}"), {
                  supplierCurrency,
                  storeCurrency,
                })}
                details={t("Used to convert order values between the two currencies. Leave empty if you don't know it yet.")}
                value={form.exchangeRate}
                prefix={`1 ${supplierCurrency} =`}
                suffix={storeCurrency}
                inputMode="decimal"
                min={0}
                step={0.0001}
                error={err("exchangeRate")}
                onInput={(e) => set("exchangeRate", val(e))}
              />
            )}
            <SelectField<BalanceChoice>
              label={t("Payment terms")}
              value={form.balanceDue}
              options={[
                { value: "order", label: t("Pay everything when you order") },
                { value: "ship", label: t("Deposit, then the rest at shipment") },
                { value: "arrival", label: t("Deposit, then the rest on arrival") },
                { value: "after_arrival", label: t("Deposit, then the rest some days after arrival") },
              ]}
              onChange={(v) => set("balanceDue", v)}
              details={t("When you pay this supplier. The cash per week in your order plan follows it.")}
            />
            {form.balanceDue !== "order" &&
              numberField("depositPercent", t("Deposit"), t("Paid when you place the order, in % of the goods. Use 0 for no deposit."), "%")}
            {form.balanceDue === "after_arrival" && numberField("balanceDays", t("Rest paid after arrival"), t("Days after the stock arrives."), t("days"))}
            <s-number-field
              label={t("Freight & duty")}
              details={t("Shipping and import duty in % of the goods cost, paid on arrival. In your costs and cash, never on the purchase order to the supplier.")}
              value={form.landedCostPercent}
              suffix="%"
              inputMode="decimal"
              min={0}
              step={0.1}
              error={err("landedCostPercent")}
              onInput={(e) => set("landedCostPercent", val(e))}
            />
            <SelectField<Locale>
              label={t("Purchase order language")}
              value={form.poLanguage}
              options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
              onChange={(v) => set("poLanguage", v)}
              details={t("The email, PDF, CSV and confirmation page for this supplier are written in this language.")}
            />
            <s-text-field
              label={t("Delivery terms (Incoterms)")}
              details={t("Optional. Printed on the order, for example FOB Ningbo, EXW or DDP Madrid.")}
              value={form.incoterms}
              maxLength={60}
              error={err("incoterms")}
              onInput={(e) => set("incoterms", val(e))}
            />
            <s-checkbox
              label={t("Hide prices from the supplier")}
              details={t("The order PDF, CSV, email and confirmation page show no unit costs.")}
              checked={flag(form.hidePrices)}
              onChange={(e) => set("hidePrices", isChecked(e))}
            />
          </s-stack>
        </Disclosure>
      </s-stack>
    </FormCard>
  );
}
