/**
 * Shared confirmation dialog (QA 2026-08-31: five window.confirm() calls were
 * untranslated browser chrome). One Polaris `<s-modal>`, fully localized, used
 * by every destructive action in the admin.
 */
import { Modal } from "./wc";
import { useLocale } from "../lib/i18n";

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  destructive = true,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional fields shown under the message (e.g. a percent to confirm with). */
  children?: React.ReactNode;
}) {
  const { t } = useLocale();
  return (
    <Modal
      open={open}
      onClose={onCancel}
      heading={title}
      primaryAction={
        <s-button variant="primary" tone={destructive ? "critical" : "auto"} onClick={onConfirm}>
          {confirmLabel}
        </s-button>
      }
      secondaryActions={<s-button onClick={onCancel}>{t("Cancel")}</s-button>}
    >
      <s-paragraph>{message}</s-paragraph>
      {children}
    </Modal>
  );
}
