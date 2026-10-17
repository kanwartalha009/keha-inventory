/**
 * Ship-to and the note to the supplier (merchant audit 2026-10-18): the supplier order builder
 * before the draft is created, and a draft's own page. Both go on the PDF, CSV and email.
 */
import { SelectField, val } from "./wc";
import { useLocale } from "../lib/i18n";
import { PO_NOTE_MAX } from "../lib/po-document-shared";

export type ShipToChoice = { id: string; name: string };

export function PoDetailsFields({
  choices,
  shipTo,
  onShipTo,
  note,
  onNote,
  noteError,
}: {
  choices: readonly ShipToChoice[];
  shipTo: string;
  onShipTo: (id: string) => void;
  note: string;
  onNote: (v: string) => void;
  noteError?: string;
}) {
  const { t } = useLocale();
  return (
    <s-stack direction="block" gap="base">
      {choices.length > 0 && (
        <SelectField<string>
          label={t("Ship to")}
          value={shipTo}
          options={choices.map((c) => ({ value: c.id, label: c.name }))}
          onChange={onShipTo}
          details={t("The location the supplier delivers to. Its address is on the order.")}
        />
      )}
      <s-text-area
        label={t("Note to the supplier")}
        details={t("Optional. Printed on the PDF, the CSV and the email, for example packing or labelling instructions.")}
        value={note}
        rows={3}
        maxLength={PO_NOTE_MAX}
        error={noteError}
        onInput={(e) => onNote(val(e))}
      />
    </s-stack>
  );
}
