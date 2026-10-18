/**
 * Polaris web-component helpers (2026-09-24 port off Polaris React).
 *
 * Everything visual in the admin is a Shopify `<s-*>` element (Polaris web
 * components, loaded by AppProvider from POLARIS_URL in lib/polaris-shared.ts —
 * 2.0 RC since 2026-10-09). This module holds
 * only what those elements do not provide, plus two React-18 facts of life:
 *
 *  - React 18 stringifies booleans on custom elements (`disabled="false"` is
 *    still *present*, i.e. truthy in HTML). Pass `disabled={x || undefined}` —
 *    or use `flag()` below — so a false flag omits the attribute.
 *  - Event handlers are typed `(event: Event) => void`; the value lives on
 *    `currentTarget`. `val()` / `isChecked()` read it without casts everywhere.
 */
import { Children, Fragment, cloneElement, isValidElement, useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { useNavigate } from "react-router";

/** `flag(cond)` → `true` or `undefined` (never `false`) for boolean attributes. */
export const flag = (cond: unknown): true | undefined => (cond ? true : undefined);

/** Value of the field that fired an `input` / `change` event. */
export function val(e: Event): string {
  return String((e.currentTarget as unknown as { value?: string | null })?.value ?? "");
}

/** Selected values of the `<s-choice-list>` that fired the event. */
export function vals(e: Event): string[] {
  const v = (e.currentTarget as unknown as { values?: unknown })?.values;
  return Array.isArray(v) ? v.map(String) : [];
}

/** Checked state of the checkbox / switch that fired the event. */
export function isChecked(e: Event): boolean {
  return Boolean((e.currentTarget as unknown as { checked?: boolean })?.checked);
}

/**
 * Internal navigation for `<s-link>` / `<s-button href>`: keep the href (right
 * click, middle click, a11y) but route client-side so the App Bridge session
 * token flow is not restarted by a full document load — the exact bug the old
 * Polaris `linkComponent` fixed (login form inside the admin, 2026-09-13).
 */
export function useLinkProps() {
  const navigate = useNavigate();
  return (to: string) => ({
    href: to,
    onClick: (e: Event) => {
      const me = e as unknown as MouseEvent;
      if (me.metaKey || me.ctrlKey || me.shiftKey || me.button === 1) return;
      e.preventDefault();
      navigate(to);
    },
  });
}

/**
 * Controlled wrapper over `<s-modal>`: the element is imperative
 * (`showOverlay()` / `hideOverlay()`), React state is declarative.
 */
/**
 * Puts `slot` on the action buttons themselves. In the embedded admin the modal is drawn by App
 * Bridge outside the app's iframe, and it only picks up `s-button` elements that carry the slot
 * directly — buttons wrapped in an `s-box slot=…` were dropped, so confirm dialogs showed no
 * buttons at all (live check 2026-10-18: "Explore with sample data?" had no Load / Cancel).
 */
function withSlot(node: ReactNode, slot: "primary-action" | "secondary-actions"): ReactNode {
  if (node === null || node === undefined || node === false) return null;
  return Children.toArray(
    isValidElement(node) && node.type === Fragment ? (node.props as { children?: ReactNode }).children : node,
  ).map((child) => (isValidElement(child) ? cloneElement(child as ReactElement<{ slot?: string }>, { slot }) : child));
}

export function Modal({
  open,
  onClose,
  heading,
  size,
  children,
  primaryAction,
  secondaryActions,
}: {
  open: boolean;
  onClose: () => void;
  heading: string;
  size?: "small" | "base" | "large";
  children: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
}) {
  const ref = useRef<HTMLElement & { showOverlay(): void; hideOverlay(): void }>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      if (open) el.showOverlay();
      else el.hideOverlay();
    } catch {
      /* element not upgraded yet (SSR / preview) */
    }
  }, [open]);
  return (
    <s-modal ref={ref as never} heading={heading} size={size} onHide={onClose}>
      {children}
      {withSlot(primaryAction, "primary-action")}
      {withSlot(secondaryActions, "secondary-actions")}
    </s-modal>
  );
}

/**
 * Tabs. Polaris web components have no tab strip (the admin uses filter views
 * inside tables instead), so this is the one piece of chrome we draw ourselves,
 * styled after the admin's tabs in app.css (`.keha-tabs`).
 */
export function Tabs({
  tabs,
  selected,
  onSelect,
}: {
  tabs: { id: string; content: string }[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="keha-tabs" role="tablist">
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={i === selected}
          className={"keha-tab" + (i === selected ? " keha-tab--active" : "")}
          onClick={() => onSelect(i)}
        >
          {tab.content}
        </button>
      ))}
    </div>
  );
}

/** Polaris React badge tones → web-component tones. */
export type BadgeTone = "info" | "success" | "warning" | "critical" | "attention" | "new" | "neutral" | undefined;
export function badgeTone(t: BadgeTone): "auto" | "neutral" | "info" | "success" | "caution" | "warning" | "critical" {
  switch (t) {
    case "success":
      return "success";
    case "critical":
      return "critical";
    case "warning":
      return "warning";
    case "attention":
      return "caution";
    case "info":
    case "new":
      return "info";
    case "neutral":
      return "neutral";
    default:
      return "auto";
  }
}

/** `<s-select>` with an options array (the shape most forms keep in state). */
export function SelectField<T extends string>({
  label,
  labelHidden,
  value,
  options,
  onChange,
  details,
  disabled,
  name,
}: {
  label: string;
  labelHidden?: boolean;
  value: T;
  options: { label: string; value: T; disabled?: boolean }[];
  onChange: (value: T) => void;
  details?: string;
  disabled?: boolean;
  name?: string;
}) {
  return (
    <s-select
      label={label}
      labelAccessibilityVisibility={labelHidden ? "exclusive" : "visible"}
      value={value}
      details={details}
      disabled={flag(disabled)}
      name={name}
      onChange={(e) => onChange(val(e) as T)}
    >
      {options.map((o) => (
        <s-option key={o.value} value={o.value} disabled={flag(o.disabled)}>
          {o.label}
        </s-option>
      ))}
    </s-select>
  );
}

/** `<s-choice-list>` with a choices array; single or multiple selection. */
export function ChoiceListField<T extends string>({
  label,
  labelHidden,
  choices,
  selected,
  onChange,
  multiple,
  name,
  disabled,
}: {
  label: string;
  labelHidden?: boolean;
  choices: { label: string; value: T; helpText?: string; disabled?: boolean }[];
  selected: T[];
  onChange: (selected: T[]) => void;
  multiple?: boolean;
  name?: string;
  disabled?: boolean;
}) {
  return (
    <s-choice-list
      label={label}
      labelAccessibilityVisibility={labelHidden ? "exclusive" : "visible"}
      multiple={flag(multiple)}
      name={name ?? label}
      disabled={flag(disabled)}
      onChange={(e) => onChange(vals(e) as T[])}
    >
      {choices.map((c) => (
        <s-choice key={c.value} value={c.value} selected={flag(selected.includes(c.value))} disabled={flag(c.disabled)}>
          {c.label}
          {c.helpText && <s-text slot="details">{c.helpText}</s-text>}
        </s-choice>
      ))}
    </s-choice-list>
  );
}
