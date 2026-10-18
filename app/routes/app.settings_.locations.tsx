/**
 * Settings → Locations (/app/settings/locations), spec §5.5.
 *
 * Every active location with:
 *  - "Included in purchase orders" — an include / leave-out toggle on EVERY plan (audit
 *    2026-10-17: supplier orders count every active location, POS stores included, so which
 *    stock counts is correctness, not a Pro feature). It writes the Location.onlinePool
 *    override (locations-shared onlinePoolForInclude); the rule is compute-shared
 *    countsForOnline. A save that leaves no location counted is refused.
 *  - its role: Warehouse / Store / Other — Pro (`locations`). Everything starts as Other
 *    (Shopify can't tell us reliably which locations are POS stores); warehouses and stores
 *    get their own plan (per-location numbers, the location switcher, the transfer plan).
 *    Below Pro the role stays visible, locked with the plan name (locks teach); a posted
 *    role change is refused on the server (403 upgrade JSON).
 */
import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateApp } from "../services/data-scope.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { activeLocations, listLocationSettings, saveLocationSettings } from "../models/locations.server";
import { AppPage, EmptyState, FormCard, FormSaveBar, HeaderLabel, sameValues } from "../components/ui";
import { SettingsTabs } from "../components/settings-tabs";
import { planTag } from "../components/plan";
import { SelectField, flag, isChecked, useLinkProps } from "../components/wc";
import { fill, useLocale } from "../lib/i18n";
import {
  LOCATION_ROLES,
  locationsErrorText,
  roleLabel,
  validateLocationsForm,
  type LocationRole,
  type LocationSettingsRow,
  type LocationsFormError,
} from "../lib/locations-shared";

/** `enabled` = roles and per-location planning (Pro). The include toggle works on every plan. */
export type LocationsData = { locations: LocationSettingsRow[]; enabled: boolean };

export const loader = async ({ request }: LoaderFunctionArgs): Promise<LocationsData> => {
  const { shop } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  return { locations: await listLocationSettings(shop), enabled: features.locations };
};

export type LocationsAction = { ok: true; saved: number } | { ok: false; error: LocationsFormError };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  if (body.intent !== "save") throw new Response("Bad request", { status: 400 });
  const v = validateLocationsForm(body.locations, await activeLocations(shop), { rolesAllowed: features.locations });
  if (!v.ok && v.error === "rolesLocked") return upgradeResponse("locations", "Locations and stores are on the Pro plan.");
  if (!v.ok) return { ok: false, error: v.error } satisfies LocationsAction;
  return { ok: true, saved: await saveLocationSettings(shop, v.updates) } satisfies LocationsAction;
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

type FormRow = { id: string; role: LocationRole; include: boolean };

export default function LocationsSettings() {
  const { t } = useLocale();
  const link = useLinkProps();
  const data = useLoaderData<typeof loader>() as LocationsData;
  const fetcher = useFetcher<LocationsAction>();
  const initial = useMemo(() => data.locations.map((l) => ({ id: l.id, role: l.role, include: l.counts })), [data.locations]);
  const [form, setForm] = useState<FormRow[]>(initial);
  useEffect(() => setForm(initial), [initial]);
  const saving = fetcher.state !== "idle";
  const dirty = !sameValues(form, initial);
  const result = fetcher.data;
  const set = (id: string, patch: Partial<FormRow>) => setForm((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const save = () =>
    fetcher.submit({ intent: "save", locations: form } as never, { method: "post", encType: "application/json" });
  const counting = data.locations.filter((l) => l.counts).map((l) => l.name);

  return (
    <AppPage heading={t("Settings")}>
      {data.locations.length > 0 && (
        <FormSaveBar id="keha-settings-locations" dirty={dirty} saving={saving} onSave={save} onDiscard={() => setForm(initial)} />
      )}
      <SettingsTabs current="locations" />
      {result?.ok && (
        <s-banner tone="success">{t("Locations saved. Your numbers update after the next nightly refresh.")}</s-banner>
      )}
      {result && !result.ok && <s-banner tone="critical">{locationsErrorText(result.error, t)}</s-banner>}

      <FormCard
        flush
        title={t("Locations")}
        sub={t("Choose which locations are included in purchase orders. POS stores are included too, unless you leave them out.")}
      >
        {data.locations.length === 0 ? (
          <EmptyState heading={t("No active locations yet")} body={t("Your locations appear here once your store is read.")} />
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("Location")}</s-table-header>
              <s-table-header listSlot="labeled">{t("Included in purchase orders")}</s-table-header>
              <s-table-header listSlot="labeled">
                <HeaderLabel
                  id="keha-locations-role"
                  label={t("Role")}
                  hint={t("Warehouses and stores get their own plan, and stock moves from warehouses to stores.")}
                  badge={data.enabled ? undefined : <s-badge icon="lock">{planTag("locations", t)}</s-badge>}
                />
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.locations.map((l) => {
                const row = form.find((r) => r.id === l.id) ?? { id: l.id, role: l.role, include: l.counts };
                return (
                  <s-table-row key={l.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text fontWeight="medium">{l.name}</s-text>
                        <s-text color="subdued">
                          {l.online ? t("Fulfills online orders in Shopify") : t("Doesn't fulfill online orders in Shopify")}
                        </s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-checkbox
                        label={t("Included in purchase orders")}
                        labelAccessibilityVisibility="exclusive"
                        accessibilityLabel={fill(t("Is {location} included in purchase orders?"), { location: l.name })}
                        checked={flag(row.include)}
                        onChange={(e) => set(l.id, { include: isChecked(e) })}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <SelectField
                        label={fill(t("Role of {location}"), { location: l.name })}
                        labelHidden
                        disabled={!data.enabled}
                        value={row.role}
                        options={LOCATION_ROLES.map((r) => ({ value: r, label: roleLabel(r, t) }))}
                        onChange={(v) => set(l.id, { role: v })}
                      />
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </FormCard>

      <FormCard title={t("How this is used")}>
        <s-stack direction="block" gap="small">
          <s-paragraph color="subdued">
            {counting.length
              ? fill(t("Included in purchase orders now: {list}."), { list: counting.join(", ") })
              : t("No location is included in purchase orders yet.")}
          </s-paragraph>
          <s-paragraph color="subdued">
            {t("Purchase orders, daily sales and days of stock are worked out from the stock in every included location.")}
          </s-paragraph>
          <s-paragraph color="subdued">
            {t("Warehouses and stores get their own plan: switch between them on Products and Order plan.")}
          </s-paragraph>
          <s-paragraph color="subdued">
            {t("The transfer plan moves stock from warehouses to stores that are running low.")}
          </s-paragraph>
          {!data.enabled && (
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-paragraph color="subdued">
                {t("On Pro you choose which locations are warehouses and stores, see each store's own sales and days of stock, and move stock from your warehouse to your stores.")}
              </s-paragraph>
              <s-button variant="secondary" {...link("/app/plans?upgrade=locations")}>
                {t("See plans")}
              </s-button>
            </s-stack>
          )}
        </s-stack>
      </FormCard>
    </AppPage>
  );
}
