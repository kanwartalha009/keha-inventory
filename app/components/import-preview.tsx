/**
 * The check before a CSV import (Settings → Import & export): what will change (row, product or
 * supplier, column from → to), rows with problems (skipped) with their line and column, rows not
 * found in the store, unknown columns, and Import / Cancel. Pure view over ImportPreview
 * (lib/setup-import-shared); nothing is saved until Import.
 */
import { fill, useLocale, plural } from "../lib/i18n";
import { formatCount } from "../lib/dashboard-shared";
import { supplierErrorText } from "../lib/suppliers-shared";
import { columnsFor, fileErrorText, issueText, type ImportEntity, type ImportPreview } from "../lib/setup-import-shared";
import { FormCard, HeaderLabel } from "./ui";
import { flag } from "./wc";

/** The column's translated label, from its file header. */
export function columnLabel(entity: ImportEntity, header: string | null, t: (s: string) => string): string {
  const c = columnsFor(entity).find((x) => x.header === header);
  return c ? t(c.label) : (header ?? "");
}

export function PreviewCard({
  preview,
  fileName,
  busy,
  onImport,
  onCancel,
}: {
  preview: ImportPreview;
  fileName: string;
  busy: boolean;
  onImport: () => void;
  onCancel: () => void;
}) {
  const { t, locale } = useLocale();
  const n = (v: number) => formatCount(v, locale);
  const p = preview;
  const entity = p.entity;
  const problems = p.issues.filter((i) => i.code !== "notFound");
  const notFound = p.issues.filter((i) => i.code === "notFound");
  const show = (v: string) => (v === "" ? "—" : v);
  return (
    <FormCard title={t("Check before importing")} sub={fill(t("{file} — nothing is saved until you import."), { file: fileName })}>
      <s-stack direction="block" gap="base">
        {p.fileError ? (
          <s-banner tone="critical">{fileErrorText(p.fileError, entity, t)}</s-banner>
        ) : (
          <>
            <s-stack direction="inline" gap="small-200">
              <s-badge tone={p.changed ? "success" : "neutral"}>{fill(p.changed === 1 ? t("1 row will change") : t("{n} rows will change"), { n: n(p.changed) })}</s-badge>
              {entity === "products" && p.variantsChanged > 0 && <s-badge>{fill(plural(p.variantsChanged, t("1 variant"), t("{n} variants")), { n: n(p.variantsChanged) })}</s-badge>}
              {entity === "suppliers" && p.created > 0 && <s-badge>{fill(t("{n} new"), { n: n(p.created) })}</s-badge>}
              <s-badge tone="neutral">{fill(t("{n} unchanged"), { n: n(p.unchanged) })}</s-badge>
              {p.problemRows > 0 && <s-badge tone="warning">{fill(t("{n} with problems, skipped"), { n: n(p.problemRows) })}</s-badge>}
              {p.notFound > 0 && <s-badge tone="warning">{fill(t("{n} not found"), { n: n(p.notFound) })}</s-badge>}
            </s-stack>
            {p.ignoredColumns.length > 0 && (
              <s-text color="subdued">{fill(t("Not imported (unknown columns): {list}"), { list: p.ignoredColumns.join(", ") })}</s-text>
            )}

            {p.changes.length > 0 && (
              <s-table>
                <s-table-header-row>
                  <s-table-header format="numeric"><HeaderLabel id="keha-imp-row" label={t("Row")} hint={t("Line in your file")} /></s-table-header>
                  <s-table-header listSlot="primary">{entity === "products" ? t("Product") : t("Supplier")}</s-table-header>
                  <s-table-header>{t("Changes")}</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {p.changes.map((c) => (
                    <s-table-row key={c.line}>
                      <s-table-cell>{n(c.line)}</s-table-cell>
                      <s-table-cell>
                        <s-stack direction="block" gap="none">
                          <s-text fontWeight="medium">{c.label}</s-text>
                          {c.kind === "create" && <s-text color="subdued">{t("New supplier")}</s-text>}
                          {c.variants ? <s-text color="subdued">{fill(plural(c.variants, t("1 variant"), t("{n} variants")), { n: n(c.variants) })}</s-text> : null}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="block" gap="none">
                          {c.fields.map((f) => (
                            <s-text key={f.column}>
                              {c.kind === "create"
                                ? `${columnLabel(entity, f.column, t)}: ${show(f.to)}`
                                : `${columnLabel(entity, f.column, t)}: ${show(f.from)} → ${show(f.to)}`}
                            </s-text>
                          ))}
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
            {p.changed > p.changes.length && (
              <s-text color="subdued">{fill(t("Showing the first {shown} of {total} changes."), { shown: n(p.changes.length), total: n(p.changed) })}</s-text>
            )}

            {problems.length > 0 && (
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">{t("Rows with problems (skipped)")}</s-text>
                <s-table>
                  <s-table-header-row>
                    <s-table-header format="numeric"><HeaderLabel id="keha-imp-prow" label={t("Row")} hint={t("Line in your file")} /></s-table-header>
                    <s-table-header>{t("Column")}</s-table-header>
                    <s-table-header listSlot="primary">{t("Problem")}</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {problems.map((i, k) => (
                      <s-table-row key={`${i.line}-${i.column}-${k}`}>
                        <s-table-cell>{n(i.line)}</s-table-cell>
                        <s-table-cell>{i.column ? columnLabel(entity, i.column, t) : "—"}</s-table-cell>
                        <s-table-cell>{issueText(i, t, (code) => supplierErrorText(code, t))}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </s-stack>
            )}
            {notFound.length > 0 && (
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">{t("Not found in your store")}</s-text>
                {notFound.map((i, k) => (
                  <s-text key={`${i.line}-${k}`} color="subdued">
                    {`${fill(t("Row {line}"), { line: n(i.line) })}: ${issueText(i, t, (code) => supplierErrorText(code, t))}`}
                  </s-text>
                ))}
              </s-stack>
            )}
          </>
        )}
        <s-stack direction="inline" gap="small-200">
          <s-button variant="primary" disabled={flag(!!p.fileError || p.changed === 0 || busy)} loading={flag(busy)} onClick={onImport}>
            {p.changed === 1 ? t("Import 1 change") : fill(t("Import {n} changes"), { n: n(p.changed) })}
          </s-button>
          <s-button variant="secondary" disabled={flag(busy)} onClick={onCancel}>
            {t("Cancel")}
          </s-button>
        </s-stack>
      </s-stack>
    </FormCard>
  );
}

