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
import { Children, Fragment, cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, type ReactElement, type ReactNode, type RefObject } from "react";
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
  const navigate = useSafeNavigate();
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
 * `useNavigate` that first closes any dialog still shown: the page change removes it, and a dialog
 * removed while shown kept the admin title bar dimmed and unclickable (2026-10-20). Search-param
 * changes on the same page keep their dialogs.
 */
export function useSafeNavigate() {
  const navigate = useNavigate();
  return (to: string, opts?: { replace?: boolean; preventScrollReset?: boolean }) => {
    const path = to.split(/[?#]/)[0];
    if (typeof window !== "undefined" && path && path !== window.location.pathname) closeAllModals();
    navigate(to, opts);
  };
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

/**
 * React 18 drops `on*` props it doesn't know on custom elements (onHide, onDismiss, …): they never
 * reach the element. Attach the element's own event instead. Returns the unsubscribe.
 * (Live 2026-10-18: closing a dialog with its X left React thinking it was open — the admin bar
 * stayed dimmed and the same dialog wouldn't open again.)
 */
export function bindElementEvent(el: EventTarget | null, name: string, handler: () => void): () => void {
  if (!el) return () => {};
  const fn = () => handler();
  el.addEventListener(name, fn);
  return () => el.removeEventListener(name, fn);
}

/** `bindElementEvent` for a ref; the latest handler is always the one called. */
export function useElementEvent(ref: RefObject<EventTarget | null>, name: string, handler: (() => void) | undefined) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => bindElementEvent(ref.current, name, () => latest.current?.()), [ref, name]);
}

/** useLayoutEffect in the browser, nothing on the server (no SSR warning). */
const useClientLayoutEffect = typeof window === "undefined" ? () => {} : useLayoutEffect;

type OverlayElement = HTMLElement & { showOverlay(): void; hideOverlay(): void };

/** A DOM-safe id for an `<s-modal>` from React's useId (":r1:" → "keha-modal-r1"). */
export function modalDomId(reactId: string): string {
  return `keha-modal-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/**
 * Close a dialog that is about to disappear. In the embedded admin App Bridge draws the dialog and
 * dims the admin's title bar OUTSIDE the app's iframe; if the `<s-modal>` element is removed while
 * shown (the page changed), nothing tells App Bridge, and the title bar stayed dimmed and
 * unclickable — no way back (live 2026-10-20). Both routes are tried; each is best-effort.
 */
export function closeOverlay(el: Partial<OverlayElement> | null | undefined, id: string, app: unknown = (globalThis as { shopify?: unknown }).shopify): void {
  try {
    el?.hideOverlay?.();
  } catch {
    /* not upgraded (SSR / preview) */
  }
  try {
    (app as { modal?: { hide?: (id: string) => unknown } } | undefined)?.modal?.hide?.(id);
  } catch {
    /* no App Bridge (outside the admin) */
  }
}

/** The last non-null value: a dialog keeps its title and content while it closes (they went blank mid-animation). */
export function useLastDefined<T>(value: T | null | undefined): T | null {
  const last = useRef<T | null>(value ?? null);
  if (value !== null && value !== undefined) last.current = value;
  return last.current;
}

/** Dialogs shown right now (id → element), so a page change can close any of them first. */
const shownModals = new Map<string, Partial<OverlayElement>>();

/** Close every dialog that is shown (before leaving the page). Returns how many were open. */
export function closeAllModals(app?: unknown): number {
  const n = shownModals.size;
  for (const [id, el] of [...shownModals]) closeOverlay(el, id, app);
  shownModals.clear();
  return n;
}

/**
 * Leave the app for `url` (a shopify:// admin link) from inside a dialog: close the dialog, then go
 * once it has gone — leaving with it shown kept the admin title bar dimmed (2026-10-20).
 */
export function leaveAfterClose(url: string, close: () => void, delayMs = 400): void {
  close();
  closeAllModals();
  window.setTimeout(() => {
    try {
      window.open(url, "_top");
    } catch {
      window.top?.location.assign(url);
    }
  }, delayMs);
}

export function Modal({
  open,
  onClose,
  onAfterHide,
  heading,
  size,
  children,
  primaryAction,
  secondaryActions,
}: {
  open: boolean;
  onClose: () => void;
  /** Fired once the dialog has finished closing (s-modal "afterhide"): navigate from here, never while it is shown. */
  onAfterHide?: () => void;
  heading: string;
  size?: "small" | "base" | "large";
  children: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
}) {
  const ref = useRef<OverlayElement>(null);
  const id = modalDomId(useId());
  const shown = useRef(false);
  const isOpen = useRef(open);
  isOpen.current = open;
  useElementEvent(ref, "afterhide", onAfterHide);
  // Unmounted while shown (a page change, a navigate after a fetcher): close it first. A layout
  // effect's cleanup runs before React removes the element, so App Bridge still finds it.
  useClientLayoutEffect(
    () => () => {
      if (shown.current) closeOverlay(ref.current, id);
      shown.current = false;
      shownModals.delete(id);
    },
    [id],
  );
  // The X, Esc and a click outside fire "hide": tell the page, once, while it still thinks it's open.
  useElementEvent(ref, "hide", () => {
    if (isOpen.current) {
      isOpen.current = false;
      onClose();
    }
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      if (open) el.showOverlay();
      else el.hideOverlay();
      shown.current = open;
      if (open) shownModals.set(id, el);
      else shownModals.delete(id);
    } catch {
      /* element not upgraded yet (SSR / preview) */
    }
  }, [open]);
  return (
    <s-modal ref={ref as never} id={id} heading={heading} size={size}>
      {children}
      {withSlot(primaryAction, "primary-action")}
      {withSlot(secondaryActions, "secondary-actions")}
    </s-modal>
  );
}

/** `<s-banner>` whose close button really calls `onDismiss` (see bindElementEvent). No handler = no close button. */
export function DismissibleBanner({
  onDismiss,
  tone,
  heading,
  children,
}: {
  onDismiss?: () => void;
  tone?: "auto" | "info" | "success" | "warning" | "critical";
  heading?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useElementEvent(ref, "dismiss", onDismiss);
  return (
    <s-banner ref={ref as never} tone={tone} heading={heading} dismissible={onDismiss ? true : undefined}>
      {children}
    </s-banner>
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
