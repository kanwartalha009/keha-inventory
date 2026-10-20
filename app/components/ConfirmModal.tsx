/**
 * Shared confirmation dialog (QA 2026-08-31: five window.confirm() calls were
 * untranslated browser chrome). One Polaris `<s-modal>`, fully localized, used
 * by every destructive action in the admin.
 */
import { Modal, flag, useLastDefined } from "./wc";
import { useLocale } from "../lib/i18n";

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  destructive = true,
  disabled = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  /** The confirm button can't be pressed (e.g. an invalid value in `children`). */
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional fields shown under the message (e.g. a percent to confirm with). */
  children?: React.ReactNode;
}) {
  const { t } = useLocale();
  // The text of the last opening stays while the dialog closes: callers build it from state that
  // is cleared on close, so the title went blank or flipped mid-animation (2026-10-20).
  const text = useLastDefined(open ? { title, message, confirmLabel, destructive } : null) ?? { title, message, confirmLabel, destructive };
  return (
    <Modal
      open={open}
      onClose={onCancel}
      heading={text.title}
      primaryAction={
        <s-button variant="primary" tone={text.destructive ? "critical" : "auto"} onClick={onConfirm} disabled={flag(disabled)}>
          {text.confirmLabel}
        </s-button>
      }
      secondaryActions={<s-button onClick={onCancel}>{t("Cancel")}</s-button>}
    >
      <s-paragraph>{text.message}</s-paragraph>
      {children}
    </Modal>
  );
}
