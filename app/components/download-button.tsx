/**
 * Download a file from an app resource route (PDF / CSV). Uses fetch so App
 * Bridge adds the session token (a plain link would load outside the
 * embedded session), then saves the blob under `fileName`.
 */
import { useState } from "react";
import { flag } from "./wc";
import { useLocale } from "../lib/i18n";

export function DownloadButton({
  url,
  fileName,
  label,
  icon = "export",
  variant,
  slot,
}: {
  url: string;
  fileName: string;
  label: string;
  icon?: "export" | "file";
  variant?: "primary" | "secondary" | "tertiary";
  /** Set by AppPage when used as a title-bar action. */
  slot?: Lowercase<string>;
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
      URL.revokeObjectURL(href);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <s-button slot={slot} icon={icon} variant={variant} loading={flag(busy)} onClick={download}>
      {failed ? t("Try again") : label}
    </s-button>
  );
}
