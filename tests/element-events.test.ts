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

describe("closing a dialog that is about to disappear (live 2026-10-20: admin title bar stayed dimmed)", () => {
  it("hides it through the element and through App Bridge, by its DOM id", async () => {
    const { closeOverlay, modalDomId } = await import("../app/components/wc");
    const calls: string[] = [];
    const el = { hideOverlay: () => calls.push("element") };
    const app = { modal: { hide: (id: string) => calls.push(`app:${id}`) } };
    const id = modalDomId(":r1f:");
    expect(id).toBe("keha-modal-r1f");
    closeOverlay(el, id, app);
    expect(calls).toEqual(["element", "app:keha-modal-r1f"]);
  });
  it("never throws: no element, no App Bridge, or either one failing", async () => {
    const { closeOverlay } = await import("../app/components/wc");
    expect(() => closeOverlay(null, "x", undefined)).not.toThrow();
    expect(() => closeOverlay({ hideOverlay: () => { throw new Error("not upgraded"); } }, "x", { modal: { hide: () => { throw new Error("gone"); } } })).not.toThrow();
  });
});

describe("UI consistency fixes (live audit 2026-10-20)", () => {
  it("a week across New Year has no years in its label", async () => {
    const { formatWeekRange } = await import("../app/lib/order-plan-shared");
    expect(formatWeekRange("2026-12-28", "en")).toBe("Dec 28 – Jan 3");
    expect(formatWeekRange("2026-10-19", "en")).not.toMatch(/2026/);
  });
  it("purchase order lines are grouped by product, keeping each line's own index", async () => {
    const { byProduct } = await import("../app/lib/purchase-order-shared");
    const lines = [{ productTitle: "Shorts" }, { productTitle: "Jeans" }, { productTitle: "Jeans" }, { productTitle: "Shorts" }];
    expect(byProduct(lines).map((x) => [x.l.productTitle, x.i])).toEqual([
      ["Shorts", 0],
      ["Shorts", 3],
      ["Jeans", 1],
      ["Jeans", 2],
    ]);
  });
  it("confirmed is good news, partly received is not blue like Ordered", async () => {
    const { poStatusTone, poStatusBadge } = await import("../app/lib/purchase-order-shared");
    expect(poStatusTone("confirmed")).toBe("success");
    expect(poStatusTone("sent")).toBe("info");
    const t = (s: string) => s;
    expect(poStatusBadge({ status: "sent", lines: [{ qty: 10, received: 4 }] }, t).tone).toBe("caution");
  });
});
