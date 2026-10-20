/**
 * Download a file from an app resource route (PDF / CSV). Uses fetch so App
 * Bridge adds the session token (a plain link would load outside the
 * embedded session), then saves the blob under `fileName`.
 */
import { useId, useState } from "react";
import { flag } from "./wc";
import { useLocale } from "../lib/i18n";

export function DownloadButton({
  url,
  fileName,
  label,
  icon = "export",
  variant,
  slot,
  disabled = false,
}: {
  url: string;
  fileName: string;
  label: string;
  icon?: "export" | "file";
  variant?: "primary" | "secondary" | "tertiary";
  /** Set by AppPage when used as a title-bar action. */
  slot?: Lowercase<string>;
  /** E.g. unsaved changes: the file would have the saved values, not what's on screen. */
  disabled?: boolean;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const download = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = href;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Released a moment later: straight away cancels the download in Safari (link audit 2026-10-20).
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <s-button slot={slot} icon={icon} variant={variant} loading={flag(busy)} disabled={flag(disabled)} onClick={download}>
      {failed ? t("Try again") : label}
    </s-button>
  );
}

/**
 * One "Download CSV" button with its layouts in a menu (the PO page's Order card held three CSV
 * buttons; C5 added a fourth layout). Same fetch-and-save as DownloadButton.
 */
export function DownloadMenu({
  label,
  items,
  disabled = false,
}: {
  label: string;
  items: { url: string; fileName: string; label: string }[];
  disabled?: boolean;
}) {
  const { t } = useLocale();
  const menuId = `keha-dl-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const download = async (url: string, fileName: string) => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = href;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <s-button icon="export" loading={flag(busy)} disabled={flag(disabled)} commandFor={menuId}>
        {failed ? t("Try again") : label}
      </s-button>
      <s-menu id={menuId} accessibilityLabel={label}>
        {items.map((it) => (
          <s-button key={it.url} onClick={() => download(it.url, it.fileName)}>
            {it.label}
          </s-button>
        ))}
      </s-menu>
    </>
  );
}
