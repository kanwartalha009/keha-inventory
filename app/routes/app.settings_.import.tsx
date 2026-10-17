/**
 * Settings → Import & export (/app/settings/import), owner 2026-10-17, Growth (`csvImport`).
 * Setup at scale: download a template with the current values (suppliers; product settings —
 * supplier, case pack, Don't reorder), edit it in a spreadsheet, upload it, check the preview
 * (row-level problems with line and column, "N rows will change", products not found), and only
 * then Import. Nothing is saved before Import; Import checks the file again and writes only the
 * changes the preview showed (lib/setup-import-shared, models/setup-import.server).
 *
 * Free stores see the page with the teaching lock: the column reference and what it does, the
 * buttons locked to the plans; the actions refuse on the server too (403 upgrade JSON).
 */
import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateApp } from "../services/data-scope.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { applyImport, importCounts, planImport, type ApplyResult } from "../models/setup-import.server";
import { AppPage, FormCard } from "../components/ui";
import { PreviewCard } from "../components/import-preview";
import { SettingsTabs } from "../components/settings-tabs";
import { UpgradeBanner, planTag } from "../components/plan";
import { DownloadButton } from "../components/download-button";
import { flag, useLinkProps } from "../components/wc";
import { fill, useLocale } from "../lib/i18n";
import { formatCount } from "../lib/dashboard-shared";
import {
  MAX_IMPORT_BYTES,
  PRODUCT_COLUMNS,
  SUPPLIER_COLUMNS,
  fileErrorText,
  isImportEntity,
  type ImportColumn,
  type ImportEntity,
  type ImportPreview,
} from "../lib/setup-import-shared";

export type ImportPageData = { enabled: boolean; counts: { suppliers: number; variants: number } };

export const loader = async ({ request }: LoaderFunctionArgs): Promise<ImportPageData> => {
  const { shop } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  return { enabled: features.csvImport, counts: await importCounts(shop) };
};

export type ImportAction =
  | { ok: true; intent: "preview"; fileName: string; preview: ImportPreview }
  | { ok: true; intent: "import"; fileName: string; preview: ImportPreview; applied: number; variants: number }
  | { ok: false; intent: "import"; fileName: string; reason: "changed" | "invalid"; preview: ImportPreview }
  | { ok: false; intent: "upload"; error: "noFile" | "tooBig" };

/** POST multipart: intent (preview | import), entity (suppliers | products), file, fingerprint (import). */
export const action = async ({ request }: ActionFunctionArgs): Promise<ImportAction | Response> => {
  const { shop } = await authenticateApp(request);
  const { features } = await getEntitlements(shop);
  if (!features.csvImport) return upgradeResponse("csvImport", "CSV import is on the Growth plan.");
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > MAX_IMPORT_BYTES + 64 * 1024) return { ok: false, intent: "upload", error: "tooBig" } satisfies ImportAction;
  const form = await request.formData().catch(() => null);
  const entity = form?.get("entity");
  const file = form?.get("file");
  if (!form || !isImportEntity(entity)) throw new Response("Bad request", { status: 400 });
  if (!file || typeof file === "string") return { ok: false, intent: "upload", error: "noFile" } satisfies ImportAction;
  const text = await file.text();
  const fileName = file.name.slice(0, 120);
  if (form.get("intent") === "import") {
    const r: ApplyResult = await applyImport(shop, entity, text, file.size, String(form.get("fingerprint") ?? ""));
    return r.ok
      ? { ok: true, intent: "import", fileName, preview: r.preview, applied: r.applied, variants: r.variants }
      : { ok: false, intent: "import", fileName, reason: r.reason, preview: r.preview };
  }
  const planned = await planImport(shop, entity, text, file.size);
  return { ok: true, intent: "preview", fileName, preview: planned.preview };
};

export const headers: HeadersFunction = (h) => boundary.headers(h);

export default function ImportExportSettings() {
  const { t, locale } = useLocale();
  const data = useLoaderData<typeof loader>() as ImportPageData;
  const fetcher = useFetcher<ImportAction>();
  const link = useLinkProps();
  // The file stays in the browser between the check and Import (sent again: nothing is kept on the server).
  const [picked, setPicked] = useState<{ entity: ImportEntity; file: File } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const busy = fetcher.state !== "idle";
  const result = dismissed ? undefined : fetcher.data;

  const send = (intent: "preview" | "import", entity: ImportEntity, file: File, fingerprint?: string) => {
    const body = new FormData();
    body.set("intent", intent);
    body.set("entity", entity);
    body.set("file", file);
    if (fingerprint) body.set("fingerprint", fingerprint);
    setDismissed(false);
    fetcher.submit(body, { method: "post", encType: "multipart/form-data" });
  };
  const onPick = (entity: ImportEntity) => (e: Event) => {
    const files = (e.currentTarget as unknown as { files?: File[] }).files;
    const file = files?.[0];
    if (!file) return;
    setPicked({ entity, file });
    send("preview", entity, file);
  };

  const preview = result && "preview" in result ? result.preview : null;
  const showCheck = !!preview && !(result?.ok && result.intent === "import");

  return (
    <AppPage heading={t("Settings")}>
      <SettingsTabs current="import" />
      {!data.enabled && <UpgradeBanner feature="csvImport" />}
      {result?.ok && result.intent === "import" && (
        <s-banner tone="success" heading={t("Import finished")}>
          {result.preview.entity === "products"
            ? fill(t("{rows} rows imported: {variants} variants changed."), { rows: formatCount(result.applied, locale), variants: formatCount(result.variants, locale) })
            : fill(t("{rows} suppliers imported ({created} new)."), { rows: formatCount(result.applied, locale), created: formatCount(result.preview.created, locale) })}
        </s-banner>
      )}
      {result && !result.ok && result.intent === "import" && result.reason === "changed" && (
        <s-banner tone="warning">{t("Your settings changed since the check. Here is the new check — import again if it looks right.")}</s-banner>
      )}
      {result && !result.ok && result.intent === "upload" && (
        <s-banner tone="critical">
          {result.error === "tooBig" ? fileErrorText("tooBig", "products", t) : t("Choose a CSV file to upload.")}
        </s-banner>
      )}

      <EntityCard
        entity="suppliers"
        title={t("Suppliers")}
        sub={t("One row per supplier: lead time, transit, order cycle, minimums, case pack, currency and vendors. New names are added; suppliers not in the file stay as they are.")}
        count={fill(data.counts.suppliers === 1 ? t("1 supplier set up.") : t("{n} suppliers set up."), { n: formatCount(data.counts.suppliers, locale) })}
        enabled={data.enabled}
        busy={busy && picked?.entity === "suppliers"}
        onPick={onPick("suppliers")}
      />
      <EntityCard
        entity="products"
        title={t("Product settings")}
        sub={t("One row per variant: supplier, case pack and Don't reorder. Rows are matched by variant_id, then sku, then handle — a handle row sets every variant of the product.")}
        count={fill(t("{n} variants in your store."), { n: formatCount(data.counts.variants, locale) })}
        enabled={data.enabled}
        busy={busy && picked?.entity === "products"}
        onPick={onPick("products")}
      />

      {showCheck && preview && picked && (
        <PreviewCard
          preview={preview}
          fileName={"fileName" in result! ? result.fileName : picked.file.name}
          busy={busy}
          onImport={() => send("import", picked.entity, picked.file, preview.fingerprint)}
          onCancel={() => {
            setPicked(null);
            setDismissed(true);
          }}
        />
      )}

      <ColumnsCard entity="suppliers" columns={SUPPLIER_COLUMNS} title={t("Columns in the suppliers file")} />
      <ColumnsCard entity="products" columns={PRODUCT_COLUMNS} title={t("Columns in the product settings file")} />
      {!data.enabled && (
        <s-stack direction="inline">
          <s-button icon="lock" {...link("/app/plans?upgrade=csvImport")}>{`${t("Import & export")} · ${planTag("csvImport", t)}`}</s-button>
        </s-stack>
      )}
    </AppPage>
  );
}

function EntityCard({
  entity,
  title,
  sub,
  count,
  enabled,
  busy,
  onPick,
}: {
  entity: ImportEntity;
  title: string;
  sub: string;
  count: string;
  enabled: boolean;
  busy: boolean;
  onPick: (e: Event) => void;
}) {
  const { t } = useLocale();
  const link = useLinkProps();
  const file = entity === "suppliers" ? "suppliers.csv" : "product-settings.csv";
  return (
    <FormCard
      title={title}
      sub={sub}
      action={
        enabled ? (
          <DownloadButton url={`/app/settings/import/${file}`} fileName={file} label={t("Download CSV")} variant="secondary" />
        ) : (
          <s-button icon="lock" {...link("/app/plans?upgrade=csvImport")}>{`${t("Download CSV")} · ${planTag("csvImport", t)}`}</s-button>
        )
      }
    >
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{count}</s-text>
        <s-drop-zone
          label={t("Upload a CSV")}
          accessibilityLabel={`${t("Upload a CSV")}: ${title}`}
          accept=".csv,text/csv,text/plain"
          disabled={flag(!enabled || busy)}
          onChange={onPick}
        />
        {busy && <s-text color="subdued">{t("Checking your file…")}</s-text>}
      </s-stack>
    </FormCard>
  );
}

function ColumnsCard({ entity, columns, title }: { entity: ImportEntity; columns: ImportColumn[]; title: string }) {
  const { t } = useLocale();
  return (
    <FormCard flush title={title} sub={entity === "products" ? t("Leave a column out to keep its values. An empty cell clears the value.") : t("Leave a column out to keep its values. An empty cell clears the value; name and lead time are required.")}>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">{t("Column")}</s-table-header>
          <s-table-header listSlot="labeled">{t("What it is")}</s-table-header>
          <s-table-header listSlot="labeled">{t("Example")}</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {columns.map((c) => (
            <s-table-row key={c.header}>
              <s-table-cell>
                <s-stack direction="block" gap="none">
                  <code className="keha-nowrap">{c.header}</code>
                  <s-text color="subdued">{t(c.label)}</s-text>
                </s-stack>
              </s-table-cell>
              <s-table-cell>{t(c.hint)}</s-table-cell>
              <s-table-cell>
                <code className="keha-nowrap">{c.example}</code>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </FormCard>
  );
}
