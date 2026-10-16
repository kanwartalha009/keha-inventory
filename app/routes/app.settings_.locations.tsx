/**
 * Settings → Locations (/app/settings/locations), spec §5.5, Pro (`locations`).
 *
 * Every active location with:
 *  - its role: Warehouse / Store / Other. Everything starts as Other (Shopify can't tell
 *    us reliably which locations are POS stores); warehouses and stores get their own plan
 *    (per-location numbers, the location switcher, the transfer plan);
 *  - "Counts for online sales": follow Shopify (shows Shopify's fulfillsOnlineOrders), Yes
 *    or No. The online stock pool honours this on every plan (compute-shared
 *    countsForOnline); changing it is Pro.
 *
 * Free / Growth see the same list read-only, which locations make up their one stock pool,
 * and an Upgrade banner (plan locks teach, they don't hide). The save is refused on the
 * server too (403 upgrade JSON). A save that would leave no location counting for online
 * sales is refused.
 */
import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { activeLocations, listLocationSettings, saveLocationSettings } from "../models/locations.server";
import { AppPage, EmptyState, FormCard, FormSaveBar, sameValues } from "../components/ui";
import { SettingsTabs } from "../components/settings-tabs";
import { UpgradeBanner } from "../components/plan";
import { SelectField } from "../components/wc";
import { fill, useLocale } from "../lib/i18n";
import {
  LOCATION_ROLES,
  POOL_CHOICES,
  locationsErrorText,
  poolChoiceLabel,
  roleLabel,
  validateLocationsForm,
  type LocationRole,
  type LocationSettingsRow,
  type LocationsFormError,
  type PoolChoice,
} from "../lib/locations-shared";

export type LocationsData = { locations: LocationSettingsRow[]; enabled: boolean };

export const loader = async ({ request }: LoaderFunctionArgs): Promise<LocationsData> => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  return { locations: await listLocationSettings(session.shop), enabled: features.locations };
};

export type LocationsAction = { ok: true; saved: number } | { ok: false; error: LocationsFormError };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.locations) return upgradeResponse("locations", "Locations and stores are on the Pro plan.");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  if (body.intent !== "save") throw new Response("Bad request", { status: 400 });
  const v = validateLocationsForm(body.locations, await activeLocations(session.shop));
  if (!v.ok) return { ok: false, error: v.error } satisfies LocationsAction;
  return { ok: true, saved: await saveLocationSettings(session.shop, v.updates) } satisfies LocationsAction;
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

type FormRow = { id: string; role: LocationRole; pool: PoolChoice };

export default function LocationsSettings() {
  const { t } = useLocale();
  const data = useLoaderData<typeof loader>() as LocationsData;
  const fetcher = useFetcher<LocationsAction>();
  const initial = useMemo(() => data.locations.map((l) => ({ id: l.id, role: l.role, pool: l.pool })), [data.locations]);
  const [form, setForm] = useState<FormRow[]>(initial);
  useEffect(() => setForm(initial), [initial]);
  const saving = fetcher.state !== "idle";
  const dirty = data.enabled && !sameValues(form, initial);
  const result = fetcher.data;
  const set = (id: string, patch: Partial<FormRow>) => setForm((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const save = () =>
    fetcher.submit({ intent: "save", locations: form } as never, { method: "post", encType: "application/json" });
  const counting = data.locations.filter((l) => l.counts).map((l) => l.name);

  return (
    <AppPage heading={t("Settings")}>
      {data.enabled && data.locations.length > 0 && (
        <FormSaveBar id="keha-settings-locations" dirty={dirty} saving={saving} onSave={save} onDiscard={() => setForm(initial)} />
      )}
      <SettingsTabs current="locations" />
      {!data.enabled && <UpgradeBanner feature="locations" />}
      {result?.ok && (
        <s-banner tone="success">{t("Locations saved. Your numbers update after the next nightly refresh.")}</s-banner>
      )}
      {result && !result.ok && <s-banner tone="critical">{locationsErrorText(result.error, t)}</s-banner>}

      {!data.enabled && (
        <FormCard title={t("Your online stock pool")} sub={t("Free and Growth plan all your stock as one pool.")}>
          <s-stack direction="block" gap="small">
            <s-paragraph>
              {t("It is made of the active locations that count for online sales. Sales per day, days left and order advice are worked out for the pool as a whole.")}
            </s-paragraph>
            <s-paragraph color="subdued">
              {counting.length
                ? fill(t("Counting for online sales now: {list}."), { list: counting.join(", ") })
                : t("No location counts for online sales yet.")}
            </s-paragraph>
            <s-paragraph color="subdued">
              {t("On Pro you choose which locations are warehouses and stores, see each store's own sales and days left, and move stock from your warehouse to your stores.")}
            </s-paragraph>
          </s-stack>
        </FormCard>
      )}

      <FormCard flush title={t("Locations")} sub={t("Choose each location's role and whether it counts for online sales.")}>
        {data.locations.length === 0 ? (
          <EmptyState heading={t("No active locations yet")} body={t("Your locations appear here once your store is read.")} />
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("Location")}</s-table-header>
              <s-table-header listSlot="labeled">{t("Role")}</s-table-header>
              <s-table-header listSlot="labeled">{t("Counts for online sales")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.locations.map((l) => {
                const row = form.find((r) => r.id === l.id) ?? { id: l.id, role: l.role, pool: l.pool };
                return (
                  <s-table-row key={l.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text fontWeight="medium">{l.name}</s-text>
                        <s-text color="subdued">
                          {l.online ? t("Fulfils online orders in Shopify") : t("Doesn't fulfil online orders in Shopify")}
                        </s-text>
                      </s-stack>
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
                    <s-table-cell>
                      <SelectField
                        label={fill(t("Does {location} count for online sales?"), { location: l.name })}
                        labelHidden
                        disabled={!data.enabled}
                        value={row.pool}
                        options={POOL_CHOICES.map((c) => ({ value: c, label: poolChoiceLabel(c, l.online, t) }))}
                        onChange={(v) => set(l.id, { pool: v })}
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
            {t("Warehouses and stores get their own plan: switch between them on Products and Reorder.")}
          </s-paragraph>
          <s-paragraph color="subdued">
            {t("The transfer plan moves stock from warehouses to stores that are running low.")}
          </s-paragraph>
          <s-paragraph color="subdued">
            {t("Locations that count for online sales make up the online stock pool, the default view everywhere.")}
          </s-paragraph>
        </s-stack>
      </FormCard>
    </AppPage>
  );
}
