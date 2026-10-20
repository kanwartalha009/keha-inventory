/**
 * 0286 robustness pass (Kanwar 2026-10-20 "Discard doesn't work", link audit):
 *  - Polaris fields follow their React value (components/wc syncFieldProperty);
 *  - a tab switch on the Actions page reloads nothing (lib/revalidate-shared);
 *  - sample data never links into the Shopify admin (components/action-list sampleProductHref).
 */
import { describe, expect, it } from "vitest";
import { syncFieldProperty } from "../app/components/wc";
import { onlyParamChanged } from "../app/lib/revalidate-shared";
import { sampleProductHref } from "../app/components/action-list";

function el(tag: string, attrs: Record<string, string>, props: Record<string, unknown>) {
  return {
    tagName: tag,
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    hasAttribute: (n: string) => n in attrs,
    ...props,
  } as never as Parameters<typeof syncFieldProperty>[0];
}

describe("syncFieldProperty", () => {
  it("Discard: the typed value is replaced by the saved one", () => {
    const f = el("S-TEXT-FIELD", { value: "14" }, { value: "21" });
    expect(syncFieldProperty(f, "value")).toBe(true);
    expect(f.value).toBe("14");
  });
  it("leaves the field alone when it already shows the value (typing)", () => {
    const f = el("S-NUMBER-FIELD", { value: "5" }, { value: "5" });
    expect(syncFieldProperty(f, "value")).toBe(false);
  });
  it("a removed value attribute empties the field", () => {
    const f = el("S-TEXT-FIELD", {}, { value: "x" });
    expect(syncFieldProperty(f, "value")).toBe(true);
    expect(f.value).toBe("");
  });
  it("checkboxes and choices follow checked / selected", () => {
    const c = el("S-CHECKBOX", {}, { checked: true });
    expect(syncFieldProperty(c, "checked")).toBe(true);
    expect(c.checked).toBe(false);
    const o = el("S-CHOICE", { selected: "" }, { selected: false });
    expect(syncFieldProperty(o, "selected")).toBe(true);
    expect(o.selected).toBe(true);
  });
  it("never touches plain HTML elements or elements without the property", () => {
    const input = el("INPUT", { value: "1" }, { value: "2" });
    expect(syncFieldProperty(input, "value")).toBe(false);
    expect(input.value).toBe("2");
    const badge = el("S-BADGE", { value: "1" }, {});
    expect(syncFieldProperty(badge, "value")).toBe(false);
  });
});

describe("onlyParamChanged", () => {
  const u = (s: string) => new URL(s, "https://app.test");
  it("true only when ?tab= alone changed on the same page", () => {
    expect(onlyParamChanged(u("/app/actions"), u("/app/actions?tab=clear"), "tab")).toBe(true);
    expect(onlyParamChanged(u("/app/actions?tab=clear&x=1"), u("/app/actions?x=1&tab=fix"), "tab")).toBe(true);
    expect(onlyParamChanged(u("/app/actions?tab=clear"), u("/app/actions?tab=clear"), "tab")).toBe(false);
    expect(onlyParamChanged(u("/app/actions?tab=clear"), u("/app/actions?tab=fix&x=1"), "tab")).toBe(false);
    expect(onlyParamChanged(u("/app"), u("/app/actions?tab=clear"), "tab")).toBe(false);
  });
});

describe("sampleProductHref", () => {
  it("opens the product in Keha's Products list, never shopify://admin", () => {
    expect(sampleProductHref({ productTitle: "Linen shirt & co" })).toBe("/app/products?q=Linen+shirt+%26+co");
    expect(sampleProductHref({ productTitle: null })).toBe("/app/products");
  });
});
