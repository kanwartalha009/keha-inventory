import { describe, expect, it, vi } from "vitest";
import { bindElementEvent } from "../app/components/wc";

// Live 2026-10-18: React 18 drops onHide / onDismiss on custom elements, so a dialog closed with its X
// never told the page (the admin bar stayed dimmed, the dialog wouldn't open again). The element's own
// event is attached instead.
describe("bindElementEvent", () => {
  it("calls the handler on the element's event and stops after unsubscribe", () => {
    const el = new EventTarget();
    const handler = vi.fn();
    const off = bindElementEvent(el, "hide", handler);
    el.dispatchEvent(new Event("hide"));
    el.dispatchEvent(new Event("show"));
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    el.dispatchEvent(new Event("hide"));
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("is a no-op without an element (SSR)", () => {
    expect(() => bindElementEvent(null, "hide", () => {})()).not.toThrow();
  });
});
