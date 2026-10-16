/**
 * Settings → Suppliers (/app/settings/suppliers), spec §5.5, Growth
 * (`suppliers`). List, add, edit and delete suppliers: name, email (stored
 * encrypted), lead time, minimum per item, minimum order total, case pack,
 * vendor match — currency and "hide prices" under More options (7 visible
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
import { authenticate } from "../shopify.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import {
  assignProducts,
  clearProducts,
  deleteSupplier,
  listSuppliers,
  otherSupplierNames,
  saveSupplier,
  supplierContext,
  supplierForm,
  type SupplierListRow,
} from "../models/suppliers.server";
import { AppPage, Disclosure, FormCard } from "../components/ui";
import { SettingsTabs } from "../components/settings-tabs";
import { UpgradeBanner, planTag } from "../components/plan";
import ConfirmModal from "../components/ConfirmModal";
import { ChoiceListField, flag, isChecked, useLinkProps, val } from "../components/wc";
import { fill, useLocale } from "../lib/i18n";
import { formatCount } from "../lib/dashboard-shared";
import {
  SUPPLIER_BOUNDS,
  newSupplierForm,
  productIdsFrom,
  readSupplierForm,
  supplierErrorText,
  validateSupplierForm,
  type SupplierErrors,
  type SupplierForm,
  type SupplierNumberKey,
} from "../lib/suppliers-shared";

export type SuppliersData = {
  suppliers: SupplierListRow[];
  vendors: string[];
  currency: string;
  enabled: boolean;
  /** The supplier being edited ("new" or an id) and its form; null = list only. */
  editing: { id: string | null; form: SupplierForm } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs): Promise<SuppliersData> => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  const [suppliers, ctx] = await Promise.all([listSuppliers(session.shop), supplierContext(session.shop)]);
  const edit = new URL(request.url).searchParams.get("edit");
  let editing: SuppliersData["editing"] = null;
  if (features.suppliers && edit === "new") editing = { id: null, form: newSupplierForm(ctx.leadTimeDays, ctx.currency) };
  else if (features.suppliers && edit) {
    const form = await supplierForm(session.shop, edit);
    if (form) editing = { id: edit, form };
  }
  return { suppliers, vendors: ctx.vendors, currency: ctx.currency, enabled: features.suppliers, editing };
};

export type SuppliersAction =
  | { ok: true; intent: "save" | "delete" | "assign" | "clear"; count?: number; name?: string }
  | { ok: false; errors?: SupplierErrors; error?: "notFound" };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.suppliers) return upgradeResponse("suppliers", "Suppliers are on the Growth plan.");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  const shop = session.shop;
  const id = typeof body.id === "string" && body.id ? body.id : null;
  switch (body.intent) {
    case "save": {
      const form = readSupplierForm(body.form);
      const v = validateSupplierForm(form, await otherSupplierNames(shop, id));
      if (!v.ok) return { ok: false, errors: v.errors } satisfies SuppliersAction;
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
  const [confirm, setConfirm] = useState<{ kind: "delete" | "clear"; row: SupplierListRow } | null>(null);
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
          saving={fetcher.state !== "idle"}
          errors={result && !result.ok ? (result.errors ?? {}) : {}}
          onSave={(form) => post({ intent: "save", id: data.editing?.id ?? null, form })}
          onCancel={() => navigate("/app/settings/suppliers")}
        />
      )}

      <s-section padding="none" accessibilityLabel={t("Suppliers")}>
        {data.suppliers.length === 0 ? (
          <s-box padding="base">
            <s-stack direction="block" gap="small" alignItems="center">
              <s-heading>{t("No suppliers yet")}</s-heading>
              <s-paragraph color="subdued">
                {t("Add your suppliers so every product gets the right lead time, minimum order and case pack. Until then the default lead time is used.")}
              </s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("Supplier")}</s-table-header>
              <s-table-header listSlot="labeled">{t("Lead time")}</s-table-header>
              <s-table-header listSlot="labeled">{t("Minimum orders")}</s-table-header>
              <s-table-header listSlot="labeled">{t("Assigned by")}</s-table-header>
              <s-table-header>{t("Manage")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.suppliers.map((s) => (
                <SupplierRow
                  key={s.id}
                  s={s}
                  enabled={data.enabled}
                  onEdit={() => navigate(`/app/settings/suppliers?edit=${encodeURIComponent(s.id)}`)}
                  onAssign={(productIds) => post({ intent: "assign", id: s.id, productIds })}
                  onDelete={() => setConfirm({ kind: "delete", row: s })}
                  onClear={() => setConfirm({ kind: "clear", row: s })}
                />
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <ConfirmModal
        open={!!confirm}
        title={
          confirm?.kind === "delete"
            ? fill(t("Delete {name}?"), { name: confirm.row.name })
            : fill(t("Remove product assignments from {name}?"), { name: confirm?.row.name ?? "" })
        }
        message={
          confirm?.kind === "delete"
            ? t("Its products go back to matching by vendor. Orders you already made keep their details.")
            : t("These products go back to matching by vendor.")
        }
        confirmLabel={confirm?.kind === "delete" ? t("Delete supplier") : t("Remove assignments")}
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
  enabled,
  onEdit,
  onAssign,
  onDelete,
  onClear,
}: {
  s: SupplierListRow;
  enabled: boolean;
  onEdit: () => void;
  onAssign: (productIds: string[]) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const { t, locale } = useLocale();
  const shopify = useAppBridge();
  const minimums = [
    s.minOrder ? fill(t("{n} per item"), { n: formatCount(s.minOrder, locale) }) : null,
    s.minOrderTotal ? fill(t("{n} per order"), { n: formatCount(s.minOrderTotal, locale) }) : null,
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
        </s-stack>
      </s-table-cell>
      <s-table-cell>{fill(t("{n} days"), { n: formatCount(s.leadTimeDays, locale) })}</s-table-cell>
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
        <s-stack direction="inline" gap="small-200">
          <s-button variant="tertiary" disabled={flag(!enabled)} onClick={onEdit}>
            {t("Edit")}
          </s-button>
          <s-button variant="tertiary" disabled={flag(!enabled)} onClick={pick}>
            {t("Assign products")}
          </s-button>
          {s.products > 0 && (
            <s-button variant="tertiary" disabled={flag(!enabled)} onClick={onClear}>
              {t("Remove assignments")}
            </s-button>
          )}
          <s-button variant="tertiary" tone="critical" disabled={flag(!enabled)} onClick={onDelete}>
            {t("Delete")}
          </s-button>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

function SupplierEditor({
  id,
  initial,
  vendors,
  storeCurrency,
  saving,
  errors,
  onSave,
  onCancel,
}: {
  id: string | null;
  initial: SupplierForm;
  vendors: string[];
  storeCurrency: string;
  saving: boolean;
  errors: SupplierErrors;
  onSave: (form: SupplierForm) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const [form, setForm] = useState<SupplierForm>(initial);
  const [more, setMore] = useState(false);
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
  // Vendors already matched but no longer in the catalog stay selectable.
  const vendorChoices = [...new Set([...vendors, ...form.vendorMatch])].map((v) => ({ value: v, label: v }));
  return (
    <FormCard
      title={id ? t("Edit supplier") : t("New supplier")}
      sub={t("Lead time and minimums apply to every product this supplier delivers.")}
    >
      <s-stack direction="block" gap="base">
        <s-text-field label={t("Supplier name")} value={form.name} error={err("name")} onInput={(e) => set("name", val(e))} />
        <s-email-field
          label={t("Supplier email")}
          details={t("Where we send purchase orders. Stored encrypted.")}
          value={form.email}
          error={err("email")}
          onInput={(e) => set("email", val(e))}
        />
        {numberField("leadTimeDays", t("Lead time"), t("Days from placing an order to the stock arriving."), t("days"))}
        {numberField("minOrder", t("Minimum per item"), t("The fewest units the supplier takes of one variant. Leave empty for none."))}
        {numberField("minOrderTotal", t("Minimum order total"), t("The fewest units for the whole order. Suggested orders are topped up to reach it."))}
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
            <s-checkbox
              label={t("Hide prices from the supplier")}
              details={t("The order PDF, CSV, email and confirmation page show no unit costs.")}
              checked={flag(form.hidePrices)}
              onChange={(e) => set("hidePrices", isChecked(e))}
            />
          </s-stack>
        </Disclosure>
        <s-stack direction="inline" gap="small" justifyContent="end">
          <s-button onClick={onCancel}>{t("Cancel")}</s-button>
          <s-button variant="primary" loading={flag(saving)} onClick={() => onSave(form)}>
            {t("Save")}
          </s-button>
        </s-stack>
      </s-stack>
    </FormCard>
  );
}
