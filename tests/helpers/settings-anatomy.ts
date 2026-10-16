/**
 * The one settings anatomy (docs/DESIGN-RULES.md): the tab strip first, then cards that each
 * start with a heading (FormCard), Save / Discard in the contextual save bar — never a Save
 * button in the title bar or the page.
 */
import { expect } from "vitest";

export function expectSettingsAnatomy(html: string, opts: { cards: string[]; saveBar?: string }) {
  const tabs = html.indexOf('class="keha-tabs"');
  expect(tabs).toBeGreaterThan(-1);
  for (const title of opts.cards) {
    const at = html.indexOf(`<s-heading>${title}</s-heading>`);
    expect(at, `card "${title}"`).toBeGreaterThan(tabs);
    // The heading sits in the shared card head (FormCard), followed by its description when there is one.
    expect(html.lastIndexOf('class="keha-form-card__head', at), `card head of "${title}"`).toBeGreaterThan(tabs);
  }
  expect(html).not.toMatch(/<s-button[^>]*slot="primary-action"[^>]*>Save</);
  if (opts.saveBar) {
    expect(html).toContain(`<ui-save-bar id="${opts.saveBar}"><button variant="primary">Save</button><button>Discard</button></ui-save-bar>`);
  } else {
    expect(html).not.toContain("<ui-save-bar");
  }
}
